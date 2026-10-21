// Text rules for memory: folding, the query's meaningful words, how a body becomes chunks, handles, and the dates a
// query names resolved against now. Dates are wall-clock days in the owner's zone (the process zone, TZ).
import { createHash } from "node:crypto";

export const fold = (text: string): string => text.normalize("NFKC").toLocaleLowerCase("en");
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Words that say nothing about what is asked. */
const FILLER = new Set(
  `a an the and or but of to in on at for from by with about into over is are was were be been being am do does did done have has had
  what whats when where which who whom whose why how any anything some something there here this that these those it its
  i me my mine we us our you your he she they them their his her can could should would will shall may might must not no yes
  tell show give find know think say said get got please up out just also than then so if as happen happens happened happening`.split(/\s+/),
);

/** The query's meaningful words, folded, each once. */
export function queryWords(text: string): string[] {
  return [...new Set((fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’_.@+-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []).map(word => word.replace(/['’]s$/, "")).filter(word => !FILLER.has(word)))];
}

/** A handle as people store it: an address lowercased, a phone as +digits (10 digits are a US number). */
export function foldHandle(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (/^\+?\d{7,}$/.test(digits)) return digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return fold(trimmed);
}

// ── chunks ──
// A short body is one chunk; a long one is cut into chunks of about CHUNK_CHARS, at a markdown heading in the second half of
// the window, else at a paragraph, a sentence end or a space, with OVERLAP characters shared with the chunk before.

const CHUNK_CHARS = 1600;
const OVERLAP = 200;
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/gm;

export interface Chunk { part: number; start: number; end: number; section: string; text: string }

function cutAt(body: string, start: number, marks: readonly { at: number }[]): { end: number; heading: boolean } {
  const limit = start + CHUNK_CHARS;
  const floor = start + Math.floor(CHUNK_CHARS / 2);
  const heading = [...marks].reverse().find(mark => mark.at > floor && mark.at <= limit);
  if (heading !== undefined) return { end: heading.at, heading: true };
  const window = body.slice(floor, limit);
  const last = (pattern: RegExp): number | undefined => {
    let found: number | undefined;
    for (const match of window.matchAll(pattern)) found = floor + match.index + match[0].length;
    return found;
  };
  return { end: last(/\n[ \t]*\n/g) ?? last(/[.!?…][)"'’”]?\s/g) ?? last(/\s/g) ?? limit, heading: false };
}

function overlapFrom(body: string, start: number, end: number): number {
  let at = Math.max(start + 1, end - OVERLAP);
  while (at < end && !/\s/.test(body[at - 1]!)) at++;
  return at >= end ? Math.max(start + 1, end - OVERLAP) : at;
}

export function chunkBody(body: string): Chunk[] {
  const marks = [...body.matchAll(HEADING)].map(match => ({ at: match.index, title: match[1]!.trim() }));
  const sectionAt = (at: number) => marks.filter(mark => mark.at <= at).at(-1)?.title ?? "";
  if (body.length <= CHUNK_CHARS) return [{ part: 0, start: 0, end: body.length, section: sectionAt(0), text: body }];
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < body.length) {
    const { end, heading } = body.length - start <= CHUNK_CHARS ? { end: body.length, heading: false } : cutAt(body, start, marks);
    chunks.push({ part: chunks.length, start, end, section: sectionAt(start), text: body.slice(start, end) });
    if (end >= body.length) break;
    start = heading ? end : overlapFrom(body, start, end);
  }
  return chunks;
}

/** About `chars` of `text` where the most of the query's words meet (each word counted once, then all their uses, then
 *  the window nearest `near`, the offset of the chunk search matched), opening a little before the first; at `near` when
 *  none is there. A word counts where a word starts. A cut through an emoji is mended (the reranker's JSON parser rejects
 *  a lone surrogate, which failed the whole search). */
export function quoteOf(text: string, words: readonly string[], chars: number, near = 0): string {
  const folded = fold(text);
  const lead = Math.round(chars / 5);
  const marks: { at: number; end: number; word: number }[] = [];
  for (const [index, word] of words.entries()) {
    for (let at = folded.indexOf(word); at >= 0 && marks.length < 5000; at = folded.indexOf(word, at + word.length)) {
      if (at === 0 || !/[\p{L}\p{N}]/u.test(folded[at - 1]!)) marks.push({ at, end: at + word.length, word: index });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  let best = { at: Math.min(Math.max(0, near), text.length), distinct: 0, uses: 0, distance: 0 };
  const uses = new Map<number, number>();
  for (let first = 0, past = 0; first < marks.length; first++) {
    while (past < marks.length && marks[past]!.end - marks[first]!.at <= chars - lead) {
      uses.set(marks[past]!.word, (uses.get(marks[past]!.word) ?? 0) + 1);
      past++;
    }
    const window = { at: Math.max(0, marks[first]!.at - lead), distinct: uses.size, uses: past - first, distance: Math.abs(marks[first]!.at - near) };
    if (window.distinct > best.distinct || (window.distinct === best.distinct && (window.uses > best.uses || (window.uses === best.uses && window.distance < best.distance)))) best = window;
    const left = (uses.get(marks[first]!.word) ?? 1) - 1;
    if (left === 0) uses.delete(marks[first]!.word);
    else uses.set(marks[first]!.word, left);
  }
  const cut = text.slice(best.at, best.at + chars).replace(/\s+/g, " ").trim();
  return `${best.at > 0 ? "…" : ""}${cut}${best.at + chars < text.length ? "…" : ""}`.toWellFormed();
}

// ── dates the query names ──

/** Days or a span the query names: when items in it are dated, the words a text uses for it, the query's words that named it. */
export interface DateMention { ranges: [Date, Date][]; phrases: string[]; spans: string[]; label: string }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const monthOf = (word: string) => MONTHS.findIndex(month => month.startsWith(word.toLowerCase().slice(0, 3)));
const day = (y: number, m: number, d: number) => new Date(y, m, d);
const addDays = (date: Date, n: number) => day(date.getFullYear(), date.getMonth(), date.getDate() + n);
const dayPhrases = (date: Date) => [`${MONTHS[date.getMonth()]} ${date.getDate()}`, `${MONTHS[date.getMonth()]!.slice(0, 3)} ${date.getDate()}`];
const oneDay = (date: Date, span: string): DateMention => ({ ranges: [[date, addDays(date, 1)]], phrases: dayPhrases(date), spans: [span], label: `${MONTHS[date.getMonth()]} ${date.getDate()}` });
const days = (from: Date, to: Date, span: string, label: string): DateMention => {
  const phrases: string[] = [];
  for (let at = from; at < to && phrases.length < 32; at = addDays(at, 1)) phrases.push(...dayPhrases(at));
  return { ranges: [[from, to]], phrases, spans: [span], label };
};

export function dateMention(query: string, now: Date): DateMention | undefined {
  const today = day(now.getFullYear(), now.getMonth(), now.getDate());
  const year = today.getFullYear();
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(query);
  if (iso !== null) return oneDay(day(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])), iso[0]);
  const dayWords = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "i").exec(query);
  if (dayWords !== null) {
    const month = monthOf(dayWords[1]!);
    const date = Number(dayWords[2]);
    if (month >= 0 && date >= 1 && date <= 31) {
      const years = dayWords[3] === undefined ? [year + 1, year, year - 1] : [Number(dayWords[3])];
      const ranges = years.map((each): [Date, Date] => [day(each, month, date), day(each, month, date + 1)]);
      return { ranges, phrases: dayPhrases(day(year, month, date)), spans: [dayWords[0]], label: `${MONTHS[month]} ${date}` };
    }
  }
  const relative = /\b(today|tonight|this morning|this afternoon|this evening|yesterday|tomorrow|(\d+|a|one|two|three|four|five|six|seven) days? ago|(last|this|next) (week|month|weekend)|(?:(last|this|next|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|recent(?:ly)?|lately|these days)\b/i.exec(query);
  if (relative !== null) {
    const [span, word] = [relative[0], relative[1]!.toLowerCase()];
    if (/^(today|tonight|this (morning|afternoon|evening))/.test(word)) return oneDay(today, span);
    if (word === "yesterday") return oneDay(addDays(today, -1), span);
    if (word === "tomorrow") return oneDay(addDays(today, 1), span);
    if (relative[2] !== undefined) {
      const n = /^\d+$/.test(relative[2]) ? Number(relative[2]) : ["a", "one", "two", "three", "four", "five", "six", "seven"].indexOf(relative[2].toLowerCase()) || 1;
      return oneDay(addDays(today, -n), span);
    }
    if (relative[4] !== undefined) {
      const shift = { last: -1, this: 0, next: 1 }[relative[3]!.toLowerCase() as "last" | "this" | "next"];
      if (relative[4].toLowerCase() === "month") {
        const from = day(year, today.getMonth() + shift, 1);
        return { ranges: [[from, day(from.getFullYear(), from.getMonth() + 1, 1)]], phrases: [MONTHS[from.getMonth()]!], spans: [span], label: MONTHS[from.getMonth()]! };
      }
      const monday = addDays(today, -((today.getDay() + 6) % 7) + 7 * shift);
      return relative[4].toLowerCase() === "weekend" ? days(addDays(monday, 5), addDays(monday, 7), span, `the weekend of ${dayPhrases(addDays(monday, 5))[0]}`) : days(monday, addDays(monday, 7), span, `the week of ${dayPhrases(monday)[0]}`);
    }
    if (relative[6] !== undefined) {
      const back = (today.getDay() - WEEKDAYS.indexOf(relative[6].toLowerCase()) + 7) % 7;
      const last = addDays(today, -(back || 7));
      const next = addDays(today, (7 - back) % 7 || 7);
      const which = relative[5]?.toLowerCase();
      const picked = which === "last" ? [last] : which === "next" ? [next] : back === 0 ? [today] : [last, next];
      return { ranges: picked.map((each): [Date, Date] => [each, addDays(each, 1)]), phrases: picked.flatMap(dayPhrases), spans: [span], label: picked.map(each => dayPhrases(each)[0]).join(" or ") };
    }
    return days(addDays(today, -14), addDays(today, 1), span, "the last two weeks");
  }
  // months alone, every one named; "may" and "march" count only capitalised or with a year, and a month without one takes
  // the year of the next month named with one ("August and September 2026")
  const months = [...query.matchAll(new RegExp(`\\b${MONTH_WORD}\\b(?:\\s+(\\d{4})\\b)?`, "gi"))]
    .filter(match => match[2] !== undefined || match[1]![0] === match[1]![0]!.toUpperCase() || !(/^(may|mar|march)$/i.test(match[1]!) || match[1]!.length === 3))
    .map(match => ({ month: monthOf(match[1]!), year: match[2] === undefined ? undefined : Number(match[2]), span: match[0] }));
  if (months.length === 0) return undefined;
  for (let index = months.length - 2; index >= 0; index--) months[index]!.year ??= months[index + 1]!.year;
  return {
    ranges: months.flatMap(({ month, year: named }) => (named === undefined ? [year, year - 1] : [named]).map((each): [Date, Date] => [day(each, month, 1), day(each, month + 1, 1)])),
    phrases: [...new Set(months.map(({ month }) => MONTHS[month]!))], spans: months.map(({ span }) => span), label: months.map(({ month, year: named }) => `${MONTHS[month]}${named === undefined ? "" : ` ${named}`}`).join(" and "),
  };
}
