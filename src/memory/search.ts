// Search and read over memory, on Postgres.
// search: explicit filters first (person, source, from/to), then channels over the eligible chunks:
// - words: BM25 (ParadeDB) over heading ×2, people ×1.5, context, text, any of the query's meaningful words;
// - meaning: cosine of the query's embedding against the chunks' (pgvector HNSW);
// - date: when the query names a day, week, month or "recently", chunks dated in it, or naming one of its days and dated
//   within a year of it, by words or recency;
// - person: when the query names someone, chunks of items they are on, by words or recency;
// fused by reciprocal rank (k 60), one hit per item (its best chunk). A record stands for the item it was
// read from (it repeats that item's words under a short title), so the item is found by either. The judge (Clef, on
// Workers AI) says how likely each of the first JUDGE_TOP is to answer the query and reorders them, the fused rank kept as
// a 4:1 prior. Dated channels are ranking signals, never filters. A text is shown with its conversation (the messages just
// before and after it in its thread), and a text already shown in another's conversation takes no slot of its own. Other
// hits quote the window of the item where the most query words meet.
// read: one item (or `<item>#<part>`) in pages of 8 KB, with the neighbouring messages of its thread.
import type { Pool, PoolClient } from "pg";
import * as z from "zod";
import { ASSISTANT, OWNER, ZONE } from "../config.js";
import { runModel, workersAiSet } from "../workers-ai.js";
import { embed } from "./store.js";
import { cleanText, type DateMention, dateMention, fold, foldHandle, quoteOf, queryWords } from "./text.js";

/** `judge: false` skips the judge; search keeps it (on the recall eval it found 124 of 172 against 120 without, where
 *  101 answerable questions got nothing strong).
 *  `trace` returns each stage's items (the eval, src/eval/recall.ts, says where a miss was lost). `private` lets in what
 *  the owner marked private (memory.private), left out otherwise. `cards`: only items with a library card that matches
 *  (memory.cards; project matches any of the card's projects). `exact`: the query word for word (case-insensitive) in an
 *  item's text or title, newest first, every match strong. */
export interface SearchInput { query: string; person?: string; source?: string[]; from?: string; to?: string; limit?: number; judge?: boolean; trace?: boolean; private?: boolean; exact?: boolean; cards?: { kind?: string; status?: string; project?: string } }
/** `record`: what a record read from the item (type, when, status, ref), which search found it by. `strength`: strong when
 *  the judge says it answers the query, weak when it only shares words or meaning. `folded`: the
 *  look-alikes folded into it (one order's mails, one thread's messages), oldest first, so the sequence that makes one
 *  value current survives the fold; `more` is their count. */
export interface Result { id: string; chunk: string; title: string; url?: string; date: string; who: string; source: string; kind: string; context?: string; record?: string; quote: string; strength: "strong" | "weak"; more?: number; folded?: { id: string; date: string; title: string }[]; why: string }
/** `results` (with id, title, url) is also the shape ChatGPT's deep research reads. `nothing_strong`: no result is strong. */
export interface SearchResult { results: Result[]; nothing_strong?: true; person?: { id: string; name: string; close?: true }[]; people?: { id: string; name: string }[]; date?: string; ms: number; channels: Record<string, number>; trace?: { channels: Record<string, string[]>; fused: string[] } }

const RRF_K = 60;
const CHANNEL_TOP = 100;
/** How many fused hits the judge reads, in one call (~1.2 s at p90). */
const JUDGE_TOP = 30;
const JUDGE_PRIOR = 4;
const JUDGE_CHARS = 500;
/** Clef answers in about 1.3 s at p90 (3.5 s at worst in 190); past this, search goes on without the judge. */
const JUDGE_MS = 4000;
/** Clef's answer is a probability that the hit answers the query; 0.5 is its yes/no boundary, fixed before the eval. */
const JUDGE_STRONG = 0.5;
const JUDGE_CRITERIA = { true: "it holds what the query asks for: the answer, or the very item the query is looking for", false: "it only shares words, people or topic with the query" };
const Answers = z.object({ answers: z.record(z.string(), z.object({ noul: z.number() })) });
const QUOTE_CHARS = 600;
/** A text hit's conversation: the messages of its thread this many before and after it, within a day, each cut at TEXT_CHARS. */
const BEFORE = 2;
const AFTER = 3;
const TEXT_CHARS = 300;
/** Texts of one thread whose conversations come within an hour of each other show as one, filled in up to JOINED_LINES. */
const JOIN_MS = 3600_000;
const JOINED_LINES = 16;
/** The owner's name as a SQL string literal, for "who" columns of the owner's own messages. */
const OWNER_SQL = `'${OWNER.name.replaceAll("'", "''")}'`;
const SOURCE_WORDS: [RegExp, string[]][] = [
  [/\b(texts?|texted|texting|imessages?|messaged)\b/i, ["imessage"]],
  [/\b(e-?mails?|emailed|mail|inbox|gmail)\b/i, ["gmail"]],
  [/\b(bookmark(?:s|ed)?|saved posts?|tweets?|x posts?)\b/i, ["x"]],
  [/\b(calendar|appointments?|scheduled)\b/i, ["calendar", "record"]],
  [/\b(told you|we (?:talked|discussed|chatted)|i (?:said|asked) you|our (?:chat|conversation))\b/i, ["chat"]],
];

const RECENCY = /\b(latest|most recent|newest|recently|last (?:time|one|e-?mail|text|message|mail))\b/i;

class Sql {
  readonly params: unknown[] = [];
  add(value: unknown): string { this.params.push(value); return `$${this.params.length}`; }
}

/** Apply this to every path that can expose an item, including conversation neighbours and record provenance. */
export function visibleSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM memory.private v WHERE v.target = ${alias}.id OR v.target = 'thread:' || ${alias}.source || ':' || ${alias}.thread)
    AND (${alias}.source <> 'record' OR NOT EXISTS (SELECT 1 FROM memory.items s JOIN memory.private v ON v.target = s.id OR v.target = 'thread:' || s.source || ':' || s.thread WHERE s.id = coalesce(${alias}.meta->>'item', ${alias}.meta->'sources'->0->>'item')))`;
}

/** Superseded typed records remain fetchable history, not current search or changes results. */
export function currentSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM memory.records r WHERE r.id = ${alias}.id AND r.superseded_by IS NOT NULL)`;
}

/** A business shortcode cannot identify a person, even when an old import attached it to their phone. */
export function personSql(alias: string, ids: string): string {
  return `EXISTS (SELECT 1 FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = ${alias}.id AND r.person_id = ANY(${ids}) AND NOT (r.role = 'sender' AND p.kind = 'person' AND ${alias}.source = 'imessage' AND ${alias}.sender ~ '^[0-9]{1,6}$'))`;
}

export function foldKey(row: { item_id: string; source: string; thread: string | null; same_as: string | null; org: string | null; ref: string | null }): string {
  if (row.same_as) return `record:${fold(row.same_as)}`;
  if (row.org && row.ref) return `record:${fold(row.org).trim()}|${fold(row.ref).trim()}`;
  return row.source === "gmail" && row.thread ? `gmail:${row.thread}` : row.item_id;
}

/** Imported mail can be only a preheader, with no order number. Fold matching delivery notices, not two known orders. */
export function sameOrder(a: { source: string; title: string; org: string | null; ref: string | null; at: Date }, b: typeof a): boolean {
  if (!a.org || !b.org) return false;
  const merchant = (org: string) => fold(org).trim().replace(/\.com$/, "");
  if (merchant(a.org) !== merchant(b.org)) return false;
  if (a.ref && b.ref) return fold(a.ref) === fold(b.ref);
  if (a.source !== "gmail" || b.source !== "gmail" || Math.abs(a.at.getTime() - b.at.getTime()) > 14 * 86_400_000) return false;
  const product = (title: string) => /^(?:ordered|shipped|out for delivery|delivered|delivery update):\s*(.+)$/i.exec(title)?.[1]?.replace(/&quot;/g, '"').replace(/["“”]/g, "").trim().toLowerCase();
  const left = product(a.title);
  return !!left && left === product(b.title);
}

/** Strong: in the query's dates, holding every name it names, and judged to answer it; a hit the judge did not read
 *  must hold every word that matters instead. */
export function strengthOf(score: number | undefined, inRange: boolean, exact: boolean, covered: boolean): Result["strength"] {
  if (!inRange || !covered) return "weak";
  return (score === undefined ? exact : score >= JUDGE_STRONG) ? "strong" : "weak";
}

export function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}


function withoutCodes(alias: string): string {
  return `NOT (${alias}.source IN ('gmail', 'imessage') AND (${alias}.title || ' ' || left(${alias}.body, 1000)) ~* '(verification|security|authentication|one.time|login|sign.in)[ -]*(code|pin)|code (is|for your)|[0-9]{4,8} is your')`;
}

/** Day bound of a from/to filter: a bare date is a whole local day (`to` inclusive). */
function bound(value: string, end: boolean): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? new Date(`${value.trim()}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a date: ${value}`);
  return end && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) : date;
}

/** `former`: ids of person rows merged into this one (meta.formerIds), so a lookup by an old id still lands here. */
interface Person { id: string; name: string; aliases: string[]; handles: string[]; kind: string; relationship: string | null; former: string[]; close?: true }
const peopleCache = new WeakMap<Pool, { at: number; people: Person[] }>();
async function allPeople(pool: Pool): Promise<Person[]> {
  const cached = peopleCache.get(pool);
  if (cached && Date.now() - cached.at < 60_000) return cached.people;
  const { rows } = await pool.query<Person>("SELECT id, name, aliases, handles, kind, relationship, coalesce(meta->'formerIds', '[]') AS former FROM memory.people WHERE kind <> 'self'");
  peopleCache.set(pool, { at: Date.now(), people: rows });
  return rows;
}

export async function resolvePerson(pool: Pool, name: string): Promise<Person[]> {
  const wanted = fold(name.trim()).replace(/^my\s+/, "");
  const handle = foldHandle(name);
  const people = await allPeople(pool);
  const exact = people.filter(each => each.id === name.trim() || each.former.includes(name.trim()) || fold(each.name) === wanted || each.aliases.some(alias => fold(alias) === wanted) || (each.handles.includes(handle) && !(each.kind === "person" && /^\+?\d{1,6}$/.test(handle))));
  if (exact.length > 0) return exact;
  const words = wanted.split(/\s+/).filter(word => word.length > 1);
  const partial = people.filter(each => words.length > 0 && words.every(word => [each.name, ...each.aliases].some(known => fold(known).split(/\s+/).includes(word)))).slice(0, 10);
  if (partial.length) return partial;
  const grams = (text: string) => {
    const name = ` ${fold(text).replace(/\s+/g, "")} `;
    return new Set(Array.from({ length: Math.max(0, name.length - 2) }, (_, i) => name.slice(i, i + 3)));
  };
  const wantedGrams = grams(wanted);
  return people.map(each => ({ each, score: Math.max(...[each.name, ...each.aliases].map(name => {
    const known = grams(name);
    return 2 * [...wantedGrams].filter(gram => known.has(gram)).length / (wantedGrams.size + known.size || 1);
  })) })).filter(hit => hit.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3).map(({ each }) => ({ ...each, close: true }));
}

/** People the query names: a full name or alias as whole words; a one-word name only capitalised or after "my". */
async function peopleNamed(pool: Pool, query: string): Promise<Person[]> {
  const folded = ` ${fold(query).replace(/[^\p{L}\p{N}@.+]+/gu, " ")} `;
  const found: Person[] = [];
  for (const each of await allPeople(pool)) {
    const names = [each.name, ...each.aliases, ...(each.relationship ? [each.relationship] : [])].map(known => fold(known).replace(/[^\p{L}\p{N}@.+]+/gu, " ").trim()).filter(known => known.length >= 3);
    const hit = names.some(known => {
      if (!folded.includes(` ${known} `)) return false;
      if (known.includes(" ")) return true;
      return new RegExp(`(?:^|[^\\p{L}])(?:[Mm]y\\s+${known}|${known[0]!.toUpperCase()}${known.slice(1)})(?![\\p{L}])`, "u").test(query);
    });
    if (hit) found.push(each);
  }
  return found.slice(0, 4);
}

type Ranked = { id: number; item: string };
const ranked = (rows: { id: string; item_id: string }[]): Ranked[] => rows.map(row => ({ id: Number(row.id), item: row.item_id }));

// Parameters are typed text: untyped, Postgres infers ParadeDB's query type and rejects it.
const WORD_MATCH = (q: string) => `(c.heading ||| ${q}::text::pdb.boost(2) OR c.people ||| ${q}::text::pdb.boost(1.5) OR c.context ||| ${q}::text OR c.text ||| ${q}::text)`;

/** One channel query on its own connection, so a search's channels run side by side. */
async function channel(pool: Pool, text: string, params: unknown[]): Promise<Ranked[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // no parallel workers: in Colima's bind-mounted data dir they fail to open the HNSW index file ("Permission denied")
    await client.query("SET LOCAL hnsw.ef_search = 200; SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL max_parallel_workers_per_gather = 0");
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return ranked(rows);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The best word matches; with `newest`, the 200 best matches, newest first. */
async function wordChannel(pool: Pool, words: string[], where: string, sql: Sql, extra = "", newest = false): Promise<Ranked[]> {
  if (words.length === 0) return [];
  const local = new Sql();
  local.params.push(...sql.params);
  const q = local.add(words.join(" "));
  const matches = `FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE ${WORD_MATCH(q)} AND ${where}${extra} ORDER BY pdb.score(c.id) DESC`;
  return channel(pool, newest ? `SELECT id, item_id FROM (SELECT c.id, c.item_id, i.at ${matches} LIMIT 200) x ORDER BY at DESC LIMIT ${CHANNEL_TOP}` : `SELECT c.id, c.item_id ${matches} LIMIT ${CHANNEL_TOP}`, local.params);
}

/** Items dated in the mention's ranges, or chunks naming one of its days dated within a year of them. */
function inDates(date: DateMention, sql: Sql): string {
  const ranges = date.ranges.map(([from, to]) => `(i.at >= ${sql.add(from)} AND i.at < ${sql.add(to)})`);
  const named = date.phrases.slice(0, 16).map(phrase => `c.text ### ${sql.add(phrase)}::text`);
  if (named.length === 0) return ` AND (${ranges.join(" OR ")})`;
  const year = 365 * 24 * 3600 * 1000;
  const near = `i.at >= ${sql.add(new Date(Math.min(...date.ranges.map(([from]) => from.getTime())) - year))} AND i.at < ${sql.add(new Date(Math.max(...date.ranges.map(([, to]) => to.getTime())) + year))}`;
  return ` AND (${ranges.join(" OR ")} OR (${near} AND c.id IN (SELECT c.id FROM memory.chunks c WHERE ${named.join(" OR ")})))`;
}

/** Match the date channel against the visible conversation, not only the message's send time. */
export function matchesDate(date: DateMention | undefined, at: Date, text: string): boolean {
  if (!date || date.ranges.some(([from, to]) => at >= from && at < to)) return true;
  const year = 365 * 86_400_000;
  if (at.getTime() < Math.min(...date.ranges.map(([from]) => from.getTime())) - year || at.getTime() >= Math.max(...date.ranges.map(([, to]) => to.getTime())) + year) return false;
  const body = fold(text).replace(/\s+/g, " ");
  return date.phrases.slice(0, 16).some(phrase => new RegExp(`\\b${phrase}(?:st|nd|rd|th)?\\b`, "i").test(body));
}

/** Records among `items`, each with the item it was read from and that item's first chunk. */
async function recordSources(pool: Pool, items: string[]): Promise<Map<string, Ranked>> {
  const { rows } = await pool.query<{ record: string; item: string; chunk: string }>(
    `SELECT r.id AS record, s.id AS item, (SELECT c.id FROM memory.chunks c WHERE c.item_id = s.id ORDER BY c.part LIMIT 1) AS chunk
     FROM memory.items r JOIN memory.items s ON s.id = coalesce(r.meta->>'item', r.meta->'sources'->0->>'item')
     WHERE r.id = ANY($1) AND r.source = 'record'`, [items]);
  return new Map(rows.filter(row => row.chunk !== null).map(row => [row.record, { id: Number(row.chunk), item: row.item }]));
}

/** The judge's probability that each document answers the query, by index: one Clef call for them all. */
export async function judge(query: string, documents: readonly string[]): Promise<number[]> {
  const state = { query, results: Object.fromEntries(documents.map((text, at) => [String(at + 1), text])) };
  const questions = Object.fromEntries(documents.map((_, at) => [`r${at + 1}`, { type: "noul", instructions: `Does result ${at + 1} answer the query?`, criteria: JUDGE_CRITERIA }]));
  const { answers } = await runModel("@cf/cloudflare/clef", { model: "clef", state, questions }, AbortSignal.timeout(JUDGE_MS), Answers);
  return documents.map((_, at) => {
    const answer = answers[`r${at + 1}`];
    if (!answer) throw new Error(`clef: no answer for result ${at + 1}`);
    return answer.noul;
  });
}

export async function search(pool: Pool, input: SearchInput, now = new Date()): Promise<SearchResult> {
  const started = Date.now();
  if (input.exact && !input.query.trim()) return { results: [], nothing_strong: true, ms: Date.now() - started, channels: { exact: 0 } };
  const limit = Math.min(30, Math.max(1, Math.round(input.limit ?? 10)));
  const sql = new Sql();
  const clauses = ["i.source <> 'memory'", currentSql("i")];
  if (!input.private) clauses.push(visibleSql("i"));
  const includeCodes = /\b(codes?|otp|one[- ]time|password|passcode|2fa|verification|authenticate|\d{4,8})\b/i.test(input.query);
  if (!includeCodes) clauses.push(withoutCodes("i"));
  if (input.cards) {
    const card = ["card.item_id = i.id"];
    if (input.cards.kind) card.push(`card.kind = ${sql.add(input.cards.kind)}`);
    if (input.cards.status) card.push(`card.status = ${sql.add(input.cards.status)}`);
    if (input.cards.project) card.push(`EXISTS (SELECT 1 FROM unnest(card.projects) project WHERE strpos(lower(project), lower(${sql.add(input.cards.project)})) > 0)`);
    clauses.push(`EXISTS (SELECT 1 FROM memory.cards card WHERE ${card.join(" AND ")})`);
  }
  let person: Person[] | undefined;
  if (input.person?.trim()) {
    person = await resolvePerson(pool, input.person);
    if (person.length === 0) return { results: [], nothing_strong: true, person: [], ms: Date.now() - started, channels: {} };
    clauses.push(personSql("i", sql.add(person.map(each => each.id))));
  }
  if (input.source?.length) clauses.push(`i.source = ANY(${sql.add(input.source)})`);
  if (input.from) clauses.push(`i.at >= ${sql.add(bound(input.from, false))}`);
  if (input.to) clauses.push(`i.at < ${sql.add(bound(input.to, true))}`);
  const where = clauses.join(" AND ");
  if (input.exact) {
    const result = await exactSearch(pool, input, where, sql, limit, includeCodes);
    return { ...result, ...(person ? { person: person.map(({ id, name, close }) => ({ id, name, ...(close ? { close } : {}) })) } : {}), ms: Date.now() - started };
  }

  const date = dateMention(input.query, now);
  const queryTerms = queryWords(input.query);
  const words = date ? queryWords(date.spans.reduce((rest, span) => rest.replace(span, " "), input.query)) : queryTerms;
  const named = person ? [] : await peopleNamed(pool, input.query);
  const sources = input.source?.length ? [] : SOURCE_WORDS.filter(([pattern]) => pattern.test(input.query)).flatMap(([, list]) => list);
  const scoped = (extra: (local: Sql) => string, newest = false) => {
    const local = new Sql();
    local.params.push(...sql.params);
    const condition = extra(local);
    return words.length > 0
      ? wordChannel(pool, words, where, local, condition, newest)
      : channel(pool, `SELECT c.id, c.item_id FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE ${where}${condition} ORDER BY i.at DESC LIMIT ${CHANNEL_TOP}`, local.params);
  };
  // without the query's embedding (failed, or past its deadline) the other channels still answer
  const meaning = async (): Promise<Ranked[]> => {
    const vector = await embed([input.query], { query: true }).then(([each]) => each, (error: unknown) => {
      console.warn(`${new Date().toISOString()} embed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    if (!vector) return [];
    const local = new Sql();
    local.params.push(...sql.params);
    const v = local.add(`[${vector.join(",")}]`);
    return channel(pool, `SELECT id, item_id FROM (SELECT c.id, c.item_id, c.embedding <=> ${v}::halfvec AS d FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE ${where} ORDER BY d LIMIT ${CHANNEL_TOP}) x ORDER BY d`, local.params);
  };
  const pending: [string, Promise<Ranked[]>][] = [["words", wordChannel(pool, words, where, sql)], ["meaning", meaning()]];
  // each filter the query resolves is a channel of its own; two or more also make one channel of the items that meet them all
  const filters: [string, (local: Sql) => string][] = [];
  if (date) filters.push(["date", local => inDates(date, local)]);
  if (named.length > 0) filters.push(["person", local => ` AND ${personSql("i", local.add(named.map(each => each.id)))}`]);
  if (sources.length > 0) filters.push(["source", local => ` AND i.source = ANY(${local.add(sources)})`]);
  for (const [name, condition] of filters) pending.push([name, scoped(condition)]);
  if (filters.length > 1) pending.push(["combined", scoped(local => filters.map(([, condition]) => condition(local)).join(""))]);
  // "the latest Acme email": the best word matches, newest first
  if (RECENCY.test(input.query) && words.length > 0) pending.push(["recent", scoped(local => filters.find(([name]) => name === "source")?.[1](local) ?? "", true)]);
  // an order number, booking code or phone the query names: what holds it exactly
  const codes = words.filter(word => word.length >= 5 && /\d/.test(word));
  if (codes.length > 0) pending.push(["code", wordChannel(pool, codes, where, sql)]);
  const channels: Record<string, Ranked[]> = Object.fromEntries(await Promise.all(pending.map(async ([name, list]) => [name, await list] as const)));
  const standsFor = await recordSources(pool, [...new Set(Object.values(channels).flatMap(list => list.map(each => each.item)))]);

  // reciprocal rank fusion over chunks, then one hit per item: its best chunk, or a record of it (shown with the item); what
  // meets every filter the query names, or holds a code it names, counts triple
  const fused = new Map<number, { item: string; score: number }>();
  for (const [name, list] of Object.entries(channels)) for (const [rank, each] of list.entries()) {
    const entry = fused.get(each.id) ?? { item: each.item, score: 0 };
    entry.score += (name === "combined" || name === "code" ? 3 : 1) / (RRF_K + rank + 1);
    fused.set(each.id, entry);
  }
  const best = new Map<string, { id: number; record?: string }>();
  for (const [id, entry] of [...fused].sort((a, b) => b[1].score - a[1].score)) {
    const stands = standsFor.get(entry.item);
    const slot = best.get(stands?.item ?? entry.item);
    if (!slot) best.set(stands?.item ?? entry.item, stands ? { id: stands.id, record: entry.item } : { id });
    else if (stands && !slot.record) slot.record = entry.item;
  }
  let order = [...best].map(([item, { id }]) => ({ item, id }));
  // an id the query names exactly is the first hit
  const tokens = input.query.split(/\s+/).map(each => each.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, "")).filter(each => /^(?:[\w.-]+:\S+|[a-z]-[\w-]{3,})$/.test(each));
  if (tokens.length > 0) {
    const local = new Sql();
    local.params.push(...sql.params);
    const { rows } = await pool.query<{ id: string; item_id: string }>(`SELECT DISTINCT ON (c.item_id) c.id, c.item_id FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE ${where} AND c.item_id = ANY(${local.add(tokens)}) ORDER BY c.item_id, c.part`, local.params);
    order = [...ranked(rows), ...order.filter(each => !rows.some(row => row.item_id === each.item))];
  }

  const fusedOrder = input.trace ? order.map(each => each.item) : [];
  // the judged head, and room for the texts a conversation already shows
  const details = await hitRows(pool, order.slice(0, Math.max(JUDGE_TOP, limit * 2)).map(each => each.id));
  const head = order.slice(0, JUDGE_TOP);
  const rows = [...details.values()];
  const records = rows.flatMap(row => best.get(row.item_id)?.record ?? []);
  const [talk, bodies] = await Promise.all([
    conversations(pool, rows.filter(row => row.thread !== null && (row.source === "imessage" || row.source === "chat" && row.origin === "context")).map(row => row.item_id), input.private, includeCodes),
    pool.query<{ id: string; body: string }>("SELECT id, body FROM memory.items WHERE id = ANY($1) AND NOT (source = 'imessage' AND thread IS NOT NULL)", [[...rows.map(row => row.item_id), ...records]]),
  ]);
  const body = new Map(bodies.rows.map(row => [row.id, row.body]));
  const ownerWords = new Set(queryWords(`${OWNER.name} ${OWNER.fullName}`));
  const contentWords = words.filter(word => !ownerWords.has(word) && !SOURCE_WORDS.some(([pattern]) => pattern.test(word)));
  const firstWord = input.query.match(/[\p{L}][\p{L}\p{N}'’_.@+-]*/u)?.[0];
  const knownNames = new Set([ASSISTANT, ...[...(person ?? []), ...named].flatMap(each => [each.name, ...each.aliases])].flatMap(queryWords));
  const names = new Set(queryWords((input.query.match(/\b(?:\p{Lu}[\p{L}\p{N}'’_.@+-]*|[\p{L}]+\d[\p{L}\p{N}_.-]*)\b/gu) ?? [])
    .filter(word => word !== firstWord || knownNames.has(queryWords(word)[0] ?? "") || /[a-z][A-Z]|\d|^[A-Z]{2,}$/.test(word)).join(" ")));
  const temporal = /^(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|dst|am|pm|central)$/i;
  const anchors = contentWords.filter(word => names.has(word) && !(date && temporal.test(word)));
  const relevance = new Map<number, number>();
  const scores = input.judge !== false && workersAiSet() && head.length > 1 ? await judge(input.query, head.map(each => {
    const row = details.get(each.id)!;
    const evidence = talk.get(row.item_id)?.map(line => `${line.who}: ${line.body}`).join("\n") ?? body.get(row.item_id) ?? row.text;
    return `${row.title} · ${row.who} · ${row.at.toISOString().slice(0, 10)}\n${row.context.slice(0, 160)}\n${quoteOf(evidence, queryTerms, 300, row.start_at)}`.slice(0, JUDGE_CHARS).toWellFormed();
  })).catch((error: unknown) => { console.warn(`${new Date().toISOString()} judge: ${error instanceof Error ? error.message : String(error)}`); return undefined; }) : undefined;
  if (scores) {
    for (const [index, score] of scores.entries()) relevance.set(head[index]!.id, score);
    const reordered = head.map((each, index) => ({ each, prior: index + 1, score: scores[index]! })).sort((a, b) => b.score - a.score)
      .map((entry, rank) => ({ ...entry, fused: JUDGE_PRIOR / (RRF_K + entry.prior) + 1 / (RRF_K + rank + 1) }))
      .sort((a, b) => b.fused - a.fused || a.prior - b.prior);
    order = [...reordered.map(entry => entry.each), ...order.slice(JUDGE_TOP)];
  }

  const sets = Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, new Set(list.map(each => standsFor.get(each.item)?.item ?? each.item))]));
  const inRange = (row: HitRow, text: string) => matchesDate(date, row.at, text) && (!input.from || row.at >= bound(input.from, false)) && (!input.to || row.at < bound(input.to, true));
  const candidates = order.filter(each => details.has(each.id)).map(each => details.get(each.id)!);
  const strengths = new Map<number, Result["strength"]>();
  for (const row of candidates) {
    const text = fold(`${row.title} ${row.who} ${row.context} ${body.get(row.item_id) ?? row.text} ${(talk.get(row.item_id) ?? []).map(line => line.body).join(" ")}`);
    const contains = (word: string) => containsTerm(text, word) || [...(person ?? []), ...named].some(each => queryWords([each.name, ...each.aliases, each.relationship ?? ""].join(" ")).includes(word) && fold(row.who).includes(fold(each.name)));
    const covered = anchors.every(contains);
    const exact = tokens.includes(row.item_id) || (contentWords.length > 0 && contentWords.every(contains));
    strengths.set(row.id, strengthOf(relevance.get(row.id), inRange(row, text), exact, covered));
  }
  const strong = (row: HitRow) => strengths.get(row.id)!;
  candidates.sort((a, b) => Number(strong(b) === "strong") - Number(strong(a) === "strong"));
  const entries = await groupHits(pool, candidates, talk, limit, input.private, includeCodes);
  const results = entries.map(({ row, lines, more, folded }): Result => {
    const text = body.get(row.item_id) ?? row.text;
    const record = body.get(best.get(row.item_id)?.record ?? "");
    return {
      id: row.item_id, chunk: `${row.item_id}#${row.part}`, title: row.title, date: row.at.toISOString(), who: row.who, source: row.source, kind: row.kind,
      strength: strong(row), ...(more ? { more } : {}), ...(folded.length > 1 ? { folded } : {}),
      ...(row.url ? { url: row.url } : {}), ...(row.context ? { context: row.context } : {}), ...(record ? { record: recordLine(record) } : {}),
      quote: lines ? renderTalk(lines, row, words) : quoteOf(text === "" ? row.title : text, words, QUOTE_CHARS, body.has(row.item_id) ? row.start_at : 0),
      why: Object.keys(sets).filter(name => sets[name]!.has(row.item_id)).join(" · "),
    };
  });
  return {
    results, ...(!results.some(row => row.strength === "strong") ? { nothing_strong: true as const } : {}), ...(person ? { person: person.map(({ id, name, close }) => ({ id, name, ...(close ? { close } : {}) })) } : {}), ...(named.length ? { people: named.map(({ id, name }) => ({ id, name })) } : {}),
    ...(date ? { date: date.label } : {}), ms: Date.now() - started, channels: Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, list.length])),
    ...(input.trace ? { trace: { channels: Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, [...new Set(list.map(each => each.item))]])), fused: fusedOrder } } : {}),
  };
}

interface HitRow { id: number; item_id: string; part: number; start_at: number; text: string; context: string; title: string; at: Date; who: string; source: string; kind: string; origin: string; url: string | null; thread: string | null; same_as: string | null; org: string | null; ref: string | null }

interface HitGroup { row: HitRow; lines?: Line[]; joined: boolean; more: number; folded: NonNullable<Result["folded"]> }

async function groupHits(pool: Pool, candidates: HitRow[], talk: Map<string, Line[]>, limit: number, privateItems = false, includeCodes = false): Promise<HitGroup[]> {
  const entries: HitGroup[] = [];
  const shown = new Map<string, HitGroup>();
  const folded = new Map<string, HitGroup>();
  const history = (row: HitRow) => ({ id: row.item_id, date: row.at.toISOString(), title: row.title });
  for (const row of candidates) {
    // Conversation overlap is already visible in the quote, not a separate history of look-alikes.
    const overlap = shown.get(row.item_id);
    if (overlap) { overlap.more++; continue; }
    const duplicate = folded.get(foldKey(row)) ?? entries.find(entry => sameOrder(entry.row, row));
    if (duplicate) {
      duplicate.more++;
      duplicate.folded.push(history(row));
      continue;
    }
    const lines = talk.get(row.item_id);
    if (entries.length === limit) continue;
    const near = lines && entries.find(entry => entry.lines && entry.row.source === row.source && entry.row.thread === row.thread
      && lines[0]!.at.getTime() - entry.lines.at(-1)!.at.getTime() <= JOIN_MS && entry.lines[0]!.at.getTime() - lines.at(-1)!.at.getTime() <= JOIN_MS);
    if (near) {
      near.lines = [...new Map([...near.lines!, ...lines].map(line => [line.id, line])).values()].sort((a, b) => a.at.getTime() - b.at.getTime());
      near.joined = true;
      near.more++;
      for (const line of lines) shown.set(line.id, near);
    } else {
      const entry = { row, ...(lines ? { lines } : {}), joined: false, more: 0, folded: [history(row)] };
      entries.push(entry);
      folded.set(foldKey(row), entry);
      for (const line of lines ?? []) shown.set(line.id, entry);
    }
  }
  await Promise.all(entries.filter(entry => entry.joined).map(async entry => {
    const between = await span(pool, entry.row, entry.lines![0]!.at, entry.lines!.at(-1)!.at, privateItems, includeCodes);
    if (between.length <= JOINED_LINES) entry.lines = between;
  }));
  for (const entry of entries) entry.folded.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return entries;
}

const WHO = `CASE WHEN i.from_me THEN ${OWNER_SQL} || coalesce(' to ' || nullif((SELECT string_agg(p.name, ', ') FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'recipient' AND p.kind <> 'self'), ''), '')
  ELSE coalesce((SELECT p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'sender' AND NOT (p.kind = 'person' AND i.source = 'imessage' AND i.sender ~ '^[0-9]{1,6}$') LIMIT 1), i.sender_name, i.sender, '') || coalesce(' to ' || nullif((SELECT string_agg(p.name, ', ') FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'recipient' AND p.kind <> 'self'), ''), '') END`;

/** Exact search reads the item, not its derived chunks or a model's interpretation of the query. */
async function exactSearch(pool: Pool, input: SearchInput, where: string, sql: Sql, limit: number, includeCodes: boolean): Promise<Omit<SearchResult, "ms">> {
  const pattern = sql.add(`%${input.query.replace(/[\\%_]/g, "\\$&")}%`);
  const { rows } = await pool.query<HitRow>(`WITH matches AS MATERIALIZED (
      SELECT i.* FROM memory.items i WHERE ${where} AND (i.body ILIKE ${pattern} OR i.title ILIKE ${pattern})
      ORDER BY i.at DESC, i.id LIMIT ${CHANNEL_TOP}
    )
    SELECT 0 AS id, i.id AS item_id, 0 AS part, 0 AS start_at, i.body AS text, '' AS context,
      coalesce(nullif(i.title, ''), i.thread_title, CASE i.source WHEN 'imessage' THEN 'Texts' ELSE i.source END) AS title,
      i.at, i.source, i.kind, i.origin, i.url, i.thread, rec.same_as, rec.org, rec.ref, ${WHO} AS who
    FROM matches i LEFT JOIN LATERAL (
      SELECT r.same_as, r.org, r.ref FROM memory.records r WHERE r.item_id = i.id AND r.type IN ('order', 'appointment') ORDER BY r.at DESC LIMIT 1
    ) rec ON true ORDER BY i.at DESC, i.id`, sql.params);
  const candidates = rows.map(row => ({ ...row, at: new Date(row.at) }));
  const talk = await conversations(pool, candidates.filter(row => row.thread !== null && (row.source === "imessage" || row.source === "chat" && row.origin === "context")).map(row => row.item_id), input.private, includeCodes);
  const entries = await groupHits(pool, candidates, talk, limit, input.private, includeCodes);
  const results = entries.map(({ row, lines, more, folded }): Result => ({
    id: row.item_id, chunk: `${row.item_id}#${row.part}`, title: row.title, date: row.at.toISOString(), who: row.who, source: row.source, kind: row.kind,
    strength: "strong", ...(more ? { more } : {}), ...(folded.length > 1 ? { folded } : {}), ...(row.url ? { url: row.url } : {}),
    quote: lines ? renderTalk(lines, row, [], input.query) : exactQuote(row.text, input.query) ?? exactQuote(row.title, input.query) ?? "",
    why: "exact",
  }));
  const ids = candidates.map(row => row.item_id);
  return { results, ...(results.length ? {} : { nothing_strong: true }), channels: { exact: candidates.length },
    ...(input.trace ? { trace: { channels: { exact: ids }, fused: ids } } : {}) };
}

function exactQuote(text: string, query: string): string | undefined {
  const match = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(text);
  if (!match) return undefined;
  const start = Math.max(0, match.index - Math.round(QUOTE_CHARS / 5));
  const end = Math.max(start + QUOTE_CHARS, match.index + match[0].length);
  return `${start ? "…" : ""}${cleanText(text.slice(start, end)).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`.toWellFormed();
}

/** The chunks' text and their items' title, date and who: "<owner> to Sam", "Bank Alerts", "@example". */
async function hitRows(pool: Pool, ids: number[]): Promise<Map<number, HitRow>> {
  const { rows } = await pool.query<HitRow>(
    `SELECT c.id::int AS id, c.item_id, c.part, c.start_at, c.text, c.context, coalesce(nullif(i.title, ''), i.thread_title, CASE i.source WHEN 'imessage' THEN 'Texts' ELSE i.source END) AS title, i.at, i.source, i.kind, i.origin, i.url, i.thread, rec.same_as, rec.org, rec.ref,
       ${WHO} AS who
     FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id LEFT JOIN LATERAL (SELECT r.same_as, r.org, r.ref FROM memory.records r WHERE r.item_id = i.id AND r.type IN ('order', 'appointment') ORDER BY r.at DESC LIMIT 1) rec ON true WHERE c.id = ANY($1)`,
    [ids],
  );
  // core's pool hands timestamptz back as text
  return new Map(rows.map(row => [row.id, { ...row, at: new Date(row.at) }]));
}

interface Line { id: string; at: Date; who: string; body: string }

const LINE = `m.id, m.at, m.body, CASE WHEN m.from_me THEN ${OWNER_SQL} ELSE coalesce((SELECT p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = m.id AND r.role = 'sender' AND NOT (p.kind = 'person' AND m.source = 'imessage' AND m.sender ~ '^[0-9]{1,6}$') LIMIT 1), m.sender_name, m.sender, '') END AS who`;

/** Each text's conversation: the messages of its thread BEFORE ahead of it and AFTER behind it within a day, itself included. */
async function conversations(pool: Pool, ids: string[], privateItems = false, includeCodes = false): Promise<Map<string, Line[]>> {
  if (ids.length === 0) return new Map();
  const columns = "m.id, m.at, m.from_me, m.sender, m.sender_name, m.body, m.source";
  const { rows } = await pool.query<Line & { hit: string }>(
    `SELECT h.id AS hit, ${LINE}
     FROM memory.items h CROSS JOIN LATERAL (
       (SELECT ${columns} FROM memory.items m WHERE m.source = h.source AND m.thread = h.thread AND m.at < h.at AND m.at > h.at - interval '1 day' ${privateItems ? "" : `AND ${visibleSql("m")}`} ${includeCodes ? "" : `AND ${withoutCodes("m")}`} ORDER BY m.at DESC LIMIT ${BEFORE})
       UNION ALL
       (SELECT ${columns} FROM memory.items m WHERE m.source = h.source AND m.thread = h.thread AND m.at >= h.at AND m.at < h.at + interval '1 day' ${privateItems ? "" : `AND ${visibleSql("m")}`} ${includeCodes ? "" : `AND ${withoutCodes("m")}`} ORDER BY m.at LIMIT ${AFTER + 1})
     ) m
     WHERE h.id = ANY($1) ORDER BY h.id, m.at, m.id`, [ids]);
  const talk = new Map<string, Line[]>();
  for (const { hit, ...line } of rows) talk.set(hit, [...(talk.get(hit) ?? []), { ...line, at: new Date(line.at) }]);
  return talk;
}

/** The messages of a hit's thread from `from` to `to`, one more than JOINED_LINES at most. */
async function span(pool: Pool, hit: HitRow, from: Date, to: Date, privateItems = false, includeCodes = false): Promise<Line[]> {
  const { rows } = await pool.query<Line>(`SELECT ${LINE} FROM memory.items m WHERE m.source = $1 AND m.thread = $2 AND m.at BETWEEN $3 AND $4 ${privateItems ? "" : `AND ${visibleSql("m")}`} ${includeCodes ? "" : `AND ${withoutCodes("m")}`} ORDER BY m.at, m.id LIMIT ${JOINED_LINES + 1}`, [hit.source, hit.thread, from, to]);
  return rows.map(line => ({ ...line, at: new Date(line.at) }));
}

/** A conversation as short lines, "9:14 AM Sam: …" (with the day when it is not the hit's); the hit's own line quotes its
 *  best window. A neighbour Messages kept no text for (an attachment, "�") is left out. */
function renderTalk(lines: readonly Line[], hit: HitRow, words: readonly string[], exact?: string): string {
  const day = (at: Date) => at.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric" });
  return lines.filter(line => line.id === hit.item_id || !/^[\s\uFFFC\uFFFD]*$/.test(line.body)).map(line => {
    const flat = cleanText(line.body).replace(/\s+/g, " ").trim();
    const text = line.id === hit.item_id ? (exact === undefined ? quoteOf(flat, words, QUOTE_CHARS) : exactQuote(line.body, exact) ?? exactQuote(hit.title, exact) ?? quoteOf(flat, [], QUOTE_CHARS)) : flat.length > TEXT_CHARS ? `${flat.slice(0, TEXT_CHARS).trimEnd()}…`.toWellFormed() : flat;
    return `${day(line.at) === day(hit.at) ? "" : `${day(line.at)}, `}${line.at.toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" })} ${line.who || "?"}: ${text}`;
  }).join("\n");
}

/** A record on one line, without its ids, provenance and duplicate quotes: "Cinema booking · Reservation · Cinema · Ref: AB12CD · Quote: …". */
function recordLine(body: string): string {
  const line = body.split("\n").map(each => each.trim()).filter(each => each !== "" && !/^(?:id|item|source|confidence|not kept|all_day|people: (?:\[\]|person:)|\w+ quote)\b/i.test(each)).join(" · ");
  return line.length > TEXT_CHARS ? `${line.slice(0, TEXT_CHARS).trimEnd()}…`.toWellFormed() : line;
}

/** Hits as plain lines, for the CLI and a turn's head. */
export function renderResults(results: readonly Result[]): string {
  if (results.length === 0) return "";
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `Record (verbatim; fetch <id> opens one; sql counts across the record):\n${results.map(hit =>
    [`[${hit.strength} · ${day(hit.date)} · ${hit.source}${hit.who ? ` · ${hit.who}` : ""}${hit.more ? ` · ${hit.more} more` : ""}] ${hit.title} (${hit.chunk})`, hit.context, hit.record ? `Record: ${hit.record}` : "", hit.url, hit.quote,
      ...(hit.folded ?? []).map(item => `  ${day(item.date)} · ${item.title} (${item.id})`)].filter(Boolean).join("\n")).join("\n\n")}`;
}

// ── read ──

const PAGE_CHARS = 8 * 1024;
const WINDOW = 5;

export async function read(pool: Pool, id: string, page?: number, access: { private?: boolean; life?: boolean } = {}) {
  const match = /^(.+)#(\d+)$/.exec(id.trim());
  const itemId = match ? match[1]! : id.trim();
  const privateItems = access.private === true && access.life === true;
  const { rows: [item] } = await pool.query(`SELECT * FROM memory.items i WHERE i.id = $1 ${privateItems ? "" : `AND ${visibleSql("i")}`}`, [itemId]);
  if (!item) throw new Error(`Nothing in memory has id ${itemId}.`);
  const pages: { start: number; text: string }[] = [];
  for (let start = 0; ; ) {
    if (item.body.length - start <= PAGE_CHARS) { pages.push({ start, text: item.body.slice(start) }); break; }
    const cut = item.body.lastIndexOf("\n", start + PAGE_CHARS);
    const end = cut > start + PAGE_CHARS / 2 ? cut + 1 : start + PAGE_CHARS;
    pages.push({ start, text: item.body.slice(start, end) });
    start = end;
  }
  const { rows: chunks } = await pool.query<{ part: number; start_at: number; heading: string }>("SELECT part, start_at, heading FROM memory.chunks WHERE item_id = $1 ORDER BY part", [itemId]);
  const at = page ?? (match ? Math.max(0, pages.findLastIndex(each => each.start <= (chunks.find(chunk => chunk.part === Number(match[2]))?.start_at ?? 0))) : 0);
  if (!Number.isInteger(at) || at < 0 || at >= pages.length) throw new Error(`${itemId} has ${pages.length} page${pages.length === 1 ? "" : "s"} (0-based).`);
  const { rows: people } = await pool.query<{ role: string; name: string }>("SELECT r.role, p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id JOIN memory.items i ON i.id = r.item_id WHERE r.item_id = $1 AND NOT (r.role = 'sender' AND p.kind = 'person' AND i.source = 'imessage' AND i.sender ~ '^[0-9]{1,6}$') ORDER BY r.role, p.name", [itemId]);
  const result: Record<string, unknown> = {
    id: item.id, title: item.title || item.thread_title || item.source, source: item.source, kind: item.kind, date: item.at, url: item.url ?? undefined,
    from: item.from_me ? OWNER.name : item.sender_name ?? item.sender ?? undefined, people: people.map(each => `${each.name} (${each.role})`),
    text: cleanText(pages[at]!.text), page: at, pages: pages.length,
  };
  if (item.kind === "message" && item.thread) {
    // texts: the same chat within a day; else at least the message before and after
    const day = item.source === "imessage" ? "AND at BETWEEN $4::timestamptz - interval '1 day' AND $4::timestamptz + interval '1 day'" : "";
    const near = async (cmp: "<" | ">", dir: "DESC" | "ASC") => (await pool.query(`SELECT id, at, from_me, sender_name, sender, left(body, 300) AS text FROM memory.items i WHERE source = $1 AND thread = $2 AND id <> $3 AND at ${cmp} $4 ${day} ${privateItems ? "" : `AND ${visibleSql("i")}`} ORDER BY at ${dir} LIMIT ${WINDOW}`, [item.source, item.thread, item.id, item.at])).rows;
    const around = [...(await near("<", "DESC")).reverse(), ...(await near(">", "ASC"))];
    if (around.length > 0) result.thread = around.map(each => ({ id: each.id, date: each.at, from: each.from_me ? OWNER.name : each.sender_name ?? each.sender, text: cleanText(each.text).replace(/\s+/g, " ").trim() }));
  } else if (chunks.length > 1) result.sections = chunks.map(chunk => ({ chunk: `${itemId}#${chunk.part}`, heading: chunk.heading }));
  return result;
}
