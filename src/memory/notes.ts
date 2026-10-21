// Notes: what the assistant knows about the owner without searching (facts about their life and people, preferences,
// standing rules, decisions, current situations), written by a consolidation pass on the `notes` model role over chats
// with their bots, coding sessions, imported notes and the events the gate sent to the brief, or by a bot through
// `remember`. Latest wins: a note that
// changes another replaces it (replaced_by), and only current notes are items (source "memory", id memory:<note>) in
// search, so a reversed preference is never found beside its replacement. A note is retired only for what replaced it
// says again or reverses: a second model call reads each retired note against the notes that replace it, and what is left
// stays current as its own note (kept_from). Each new note is then checked against the current notes nearest it, as a
// pass over all of them misses an older plan filed under another subject: a note one of them repeats or changes gives way
// to it, with no rewrite. The profile is the compact picture of the owner written from the current notes; context_get
// serves it to life-scope agents.
import type { Pool } from "pg";
import { ASSISTANT, OWNER, ZONE } from "../config.js";
import { type ChatMessage, complete, replyJson } from "../models.js";
import { z } from "zod";
import { search } from "./search.js";
import { type ItemInput, writeItems } from "./store.js";
import { fold } from "./text.js";

const Ids = z.array(z.union([z.string(), z.number()])).nullish();
/** What the notes model answers; a note of an unknown kind or with no text is dropped. */
const Reply = z.object({ notes: z.array(z.object({ kind: z.string(), subject: z.string().nullish(), text: z.string(), at: z.string().nullish(), until: z.string().nullish(), sources: Ids, replaces: Ids })) });
/** The reconcile check of each note it was shown: the note in its group that changes it, if any. */
const Checked = z.object({ checked: z.array(z.object({ id: z.union([z.string(), z.number()]), changed_by: z.union([z.string(), z.number()]).nullish() })) });
/** What the keep call answers: each retired note's statements, the names each is about, the note that says it again or
 * replaces it (both null: none) and that note's own words doing so. */
const Holder = z.union([z.string(), z.number()]).nullish();
const KeptReply = z.object({ retired: z.array(z.object({ id: z.union([z.string(), z.number()]), statements: z.array(z.object({ text: z.string(), names: z.array(z.string()).nullish(), quote: z.string().nullish(), said_by: Holder, replaced_by: Holder })) })) });

export const NOTE_KINDS = ["fact", "preference", "rule", "decision", "situation"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export interface Note { id: number; kind: NoteKind; subject: string; text: string; at: Date; until: Date | null; sources: string[]; by: string }
/** A note the model proposes: its source ids and the current notes it replaces, both checked against what it was shown. */
export interface Proposal { kind: NoteKind; subject: string; text: string; at: Date; until: Date | null; sources: string[]; replaces: number[] }
/** What a retired note says that no new note says again or makes wrong: it stays current as its own note. */
export interface Kept { from: Note; text: string }
/** One thing the pass reads: a chat message or turn, an imported note, a work session turn, a mail or text the gate sent to the brief. */
interface Material { id: string; source: string; origin: string; at: Date; title: string; body: string; who: string; from_me: boolean; thread: string | null; thread_title: string | null; project?: string | null; hash: string }

/** Material per model call, and how much of one message it sees (items stay whole in memory). */
const WINDOW_CHARS = 30_000;
const MESSAGE_CHARS = 4_000;
const WINDOWS_PER_RUN = 4;

const O = OWNER.name;
const INSTRUCTIONS = `You keep ${ASSISTANT}'s notes about ${O}: the short, durable things ${OWNER.their} assistant should know without searching. Kinds:
- fact: about ${OWNER.their} life, people, things, accounts, plans ("${O}'s old laptop goes to Sam, wiped, when the new one arrives on November 3, 2026").
- preference: what ${O} likes or wants, how ${O} wants things done or shown.
- rule: a standing instruction for ${ASSISTANT} or ${OWNER.their} bots and workers ("Coding agents run the tests before every commit").
- decision: a choice ${O} made, with its reason when given.
- situation: true for now (a trip, an appointment, an open problem, a reminder ${O} asked for); give "until" when it ends.

Read the new material and answer with JSON only: {"notes":[{"kind","subject","text","at","until","sources","replaces"}]}.
- Write a note only for what ${O} said, asked for, decided or confirmed, or a durable fact the material establishes about ${OWNER.them} or ${OWNER.their} people. Skip chatter, the assistant's own proposals and status reports ${O} did not take up, tool output, tests and probes, routines and bot-to-bot traffic.
- text: one or two plain sentences that stand alone: name people (${O}, Sam) and give absolute dates (October 17, 2026, never "this weekend" or "tomorrow"), times and numbers exactly as said. Keep ${OWNER.their} reason when ${O} gave one.
- subject: who or what it is about, a short name: "${O}", "Sam", "coding agents", "phone app", "laptop".
- at: the day it was said, YYYY-MM-DD. until: YYYY-MM-DD when a situation ends, else null.
- sources: the [ids] of the material it comes from.
- Latest wins. When the material changes, corrects, narrows or reverses current notes, write the new note whole and put the #id of every current note it makes wrong or out of date in "replaces"; they are retired. Look through all the current notes on that subject for it, old and short ones too: a note left standing beside its reversal tells ${ASSISTANT} both. A note is retired only for what the new note says again or makes wrong: whatever else it says is kept as its own note, so leave other things out of the new note. When it only repeats a current note, write nothing. Merge current notes that say the same thing by writing one note that replaces them all.
- Imported notes are older notes about ${O} from a previous assistant: carry over the ones still worth knowing in these kinds, rewritten to the rules above.
- A note a bot was asked to keep is ${O}'s word relayed: write it as a note (its words, only relative dates made absolute) unless a current note already says exactly this, and retire every current note it corrects, narrows or reverses, standing rules and lists included (a new roster replaces the old one; "the only rule is X" replaces the rules it drops).
- Texts and mail: keep only what establishes something durable about ${O} or ${OWNER.their} people (a plan, an appointment, a commitment, a change in someone's life, what ${O} wrote or agreed to). Receipts, bills, alerts, shipping notices and newsletters are no note: records and search cover them.
Answer {"notes":[]} when nothing is worth keeping.`;

const RECONCILE = `You keep ${ASSISTANT}'s notes about ${O} current: the short, durable things ${OWNER.their} assistant knows without searching (facts, preferences, standing rules, decisions, situations). Latest wins: a note left standing beside its reversal tells ${ASSISTANT} both.
The material is groups of current notes: each group is a note just written, then the current notes nearest it. Notes about one thing can stand side by side under different subjects: an older plan beside the plan that took its place (an October 14 route to a goal beside the October 15 route that replaced it, even when each only reports what someone said), a preference beside its reversal, or one note repeating another.
Check every note in every group: name the note in its group that changes it, one that says it again in whole or in part, or a newer one that corrects, narrows or reverses it, replaces its plan or route, or makes any part of it out of date. A changed note is retired, and retiring loses nothing: whatever else it says that is still true is kept as a note of its own. So name a changer whenever any part of a note is repeated or out of date. Notes about different things, or that each tell a different part of one thing, change nothing.
Answer with JSON only: {"checked":[{"id","about","changed_by"}]}, one entry for every note: about = what it is about in a few words; changed_by = the #id of the note that changes it, else null.`;

const KEEP = `Some of ${ASSISTANT}'s notes about ${O} are being retired, each for new notes or for a current note that changes it. A note is retired only for what another note says again or makes wrong; whatever else in it is still true must stay.
Split each retired note into its statements: every part that is true or false on its own (a rule or instruction, a preference, a fact, a plan, a condition such as "until ${O} reviews ...", a reason, each pick of a list of choices), with its dates, numbers, names and reasons. Write each in the note's own words, made to stand alone: name what it is about (never "it", "this" or "the fix"), the people, absolute dates and its qualifiers.
Then, for each statement, look for a new note ("new 1", "new 2", ...) or a note that stays ("#id") that holds it, in one of two ways:
- said_by: its words state the same claim with the same specifics (the same names, amounts, dates, picks and reason), in any words. Ask: would someone reading only those words know this statement? If not, they do not say it.
- replaced_by: its words set something different for the same thing: another value, rule, plan, route or time that takes the statement's place. A newer plan or route to the same goal replaces everything said about the older one (its steps, timing, conditions, and what anyone said would happen on it), even what the newer one does not mention. A retired note marked [changed by #id] gave way to #id's plan, route or facts: whatever #id's words replace is replaced_by #id.
Neither is a note that only covers the subject: a rule or preference for all bills neither says nor replaces a rule about one named biller (the named one is an exception that stands); a note giving a choice does not say the reason for it; a note saying a lab was answered or a setup was chosen does not say the picks. A retired note never holds anything. A statement neither said nor replaced stays.
Answer with JSON only: {"retired":[{"id":12,"statements":[{"text":"...","names":["..."],"quote":"...","said_by":null,"replaced_by":"new 1"}]}]}, every retired note and every statement of it. names = the names in the statement: people, companies, billers, products, places, accounts, apps, tools and models (not ${O}, not dates); a note that names none of them neither says nor replaces it. quote = the holding note's exact words that say or replace it, copied as one unbroken run (no "..."); quote, said_by and replaced_by are null for a statement that stays.`;

/** New notes a reconcile call looks at, and how many current notes it sets beside each. */
const RECONCILE_GROUPS = 6;
const NEIGHBOURS = 8;

/** The profile's budget, about 1.5k tokens: it rides on every turn. The model is asked for less, as it overshoots. */
const PROFILE_CHARS = 6_000;
const PROFILE = `Write the profile ${ASSISTANT} reads at the head of every turn: the compact picture of ${O} from ${OWNER.their} current notes, for an assistant that must act like it has known ${OWNER.them} for years.
- At most 5,000 characters. Plain text: short headed sections (${O}; People; Rules for ${ASSISTANT} and the bots; Preferences; Now: current situations and what is coming, with dates; Recent decisions), terse "- " lines.
- Only what the notes say; keep exact names, numbers, dates and reasons. Where notes disagree, the newer one holds.
- Put first what is durable and often useful: who ${OWNER.their} people are, how ${O} wants ${OWNER.their} bots to work, what is happening now. Leave one-off details to search (the notes nearest each turn follow the profile): account numbers, single bills, file paths, commit ids, finished work.
- Drop situations that ended before today.
Answer with the profile only.`;

const day = (at: Date) => at.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric", year: "numeric" });
const moment = (at: Date) => at.toLocaleString("en-US", { timeZone: ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const isoDay = (value: unknown): Date | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10))) ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : null;

export const renderNote = (note: Note) => `#${note.id} · ${note.kind} · ${note.subject} · ${day(note.at)}${note.until ? ` (until ${day(note.until)})` : ""}: ${note.text}`;

function label(item: Material): string {
  if (item.source === "memory") return "imported note";
  if (item.source === "note") return `note ${item.who || "a bot"} was asked to keep`;
  if (item.source === "omp") return `work session (${item.project ?? item.thread_title ?? "unknown project"})`;
  if (item.source === "chat") return item.origin === "event" ? `chat turn with ${item.thread_title ?? item.who}` : `${item.from_me ? O : item.who || ASSISTANT} in chat${item.thread_title ? ` with ${item.thread_title}` : ""}`;
  return `${item.source}${item.from_me ? ` from ${O}` : item.who ? ` from ${item.who}` : ""}`;
}
function renderMaterial(item: Material): string {
  const text = [item.title && item.source !== "chat" && item.source !== "memory" && item.source !== "omp" ? item.title : "", item.body].filter(Boolean).join("\n");
  return `[${item.id}] ${moment(item.at)} · ${label(item)}: ${text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text}`;
}

/** The model's answer as proposals: unknown kinds and empty texts dropped, sources and replaces kept only when shown. */
export function parseProposals(reply: string, shown: { sources: ReadonlySet<string>; notes: ReadonlySet<number> }, fallbackAt: Date): Proposal[] {
  const { notes } = Reply.parse(replyJson(reply));
  // ids come back as "#12", "[chat:…]" or bare
  const ids = (value: z.infer<typeof Ids>) => (value ?? []).map(each => String(each).replace(/^[#[]|]$/g, ""));
  return notes.flatMap((note): Proposal[] => {
    const kind = NOTE_KINDS.find(each => each === note.kind);
    const text = note.text.trim();
    if (!kind || text === "") return [];
    return [{
      kind, text, subject: note.subject?.trim() || OWNER.name, at: isoDay(note.at) ?? fallbackAt, until: isoDay(note.until),
      sources: [...new Set(ids(note.sources).filter(id => shown.sources.has(id)))],
      replaces: [...new Set(ids(note.replaces).map(Number).filter(id => shown.notes.has(id)))],
    }];
  });
}

/** The reconcile check as the notes it retires, each with the shown note that holds it now: a note changed by a note that
 * is itself changed goes to the end of that chain, and a check that would close a loop is dropped. */
export function parseChecked(reply: string, shown: ReadonlySet<number>): Map<number, number> {
  const { checked } = Checked.parse(replyJson(reply));
  const id = (value: string | number | null | undefined) => Number(String(value ?? "").replace(/^#/, ""));
  const end = (from: number, by: ReadonlyMap<number, number>) => {
    let at = from;
    while (by.has(at)) at = by.get(at)!;
    return at;
  };
  const changedBy = new Map<number, number>();
  for (const each of checked) {
    const note = id(each.id);
    const holder = id(each.changed_by);
    if (shown.has(note) && shown.has(holder) && !changedBy.has(note) && end(holder, changedBy) !== note) changedBy.set(note, holder);
  }
  return new Map([...changedBy.keys()].map(note => [note, end(note, changedBy)]));
}

export async function currentNotes(pool: Pool): Promise<Note[]> {
  const { rows } = await pool.query<Note>("SELECT id::int, kind, subject, text, at, until, sources, by FROM memory.notes WHERE replaced_by IS NULL ORDER BY at, id");
  // core's pool hands timestamptz back as text
  return rows.map(row => ({ ...row, at: new Date(row.at), until: row.until === null ? null : new Date(row.until) }));
}

/** One call on the notes role with the notes it may name and the material; answers the reply. */
async function ask(system: string, notes: readonly Note[], material: string, now: Date): Promise<string> {
  return complete({
    role: "notes", session: "memory-notes", maxTokens: 8192,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Current notes (#id · kind · subject · date: text):\n${notes.map(renderNote).join("\n") || "(none yet)"}\n\nToday is ${day(now)}.\n\n${material}` },
    ],
  });
}

async function propose(system: string, notes: Note[], material: string, sources: ReadonlySet<string>, fallbackAt: Date, now: Date): Promise<Proposal[]> {
  return parseProposals(await ask(system, notes, material, now), { sources, notes: new Set(notes.map(note => note.id)) }, fallbackAt);
}

/** Notes the material names by id ("note #1241", "memory:1241"): a bot told to retire one means all of it. */
export function citedNotes(material: string): Set<number> {
  return new Set([...material.matchAll(/\b(?:notes?\s*#?|memory:)(\d+)\b/gi)].map(match => Number(match[1])));
}

/** One read of new material against the current notes: the notes it writes, and what the notes they retire keep. A
 *  retired note the material names by id is retired whole: nothing of it is kept. */
export async function readWindow(notes: Note[], material: string, sources: ReadonlySet<string>, fallbackAt: Date, now: Date): Promise<{ proposals: Proposal[]; kept: Kept[] }> {
  const proposals = await propose(INSTRUCTIONS, notes, material, sources, fallbackAt, now);
  return { proposals, kept: await keep(notes, proposals, now, new Map(), citedNotes(material)) };
}

/** What each retired note (replaced by one of `proposals`, or a key of `retire`, which names the shown note it gives way
 * to) says that no new note and no staying note says again or makes wrong: the model splits each retired note into
 * statements and names the note holding each, and the statements no note holds stay. `whole`: retired notes that keep nothing. */
export async function keep(shown: readonly Note[], proposals: readonly Proposal[], now: Date, retire: ReadonlyMap<number, number> = new Map(), whole: ReadonlySet<number> = new Set()): Promise<Kept[]> {
  const gone = shown.filter(note => retire.has(note.id) || proposals.some(proposal => proposal.replaces.includes(note.id)));
  const retired = new Map(gone.filter(note => !whole.has(note.id)).map(note => [note.id, note]));
  if (retired.size === 0) return [];
  const proposed = proposals.map((proposal, index) => `new ${index + 1} · retires ${proposal.replaces.map(id => `#${id}`).join(", ") || "none"} · ${proposal.kind} · ${proposal.subject} · ${day(proposal.at)}${proposal.until ? ` (until ${day(proposal.until)})` : ""}: ${proposal.text}`);
  const staying = shown.filter(note => !gone.includes(note));
  const reply = await complete({
    role: "notes", session: "memory-notes", maxTokens: 8192,
    messages: [
      { role: "system", content: KEEP },
      { role: "user", content: `Today is ${day(now)}.\n\nRetired notes (#id · kind · subject · date: text):\n${[...retired.values()].map(note => `${renderNote(note)}${retire.has(note.id) ? ` [changed by #${retire.get(note.id)}]` : ""}`).join("\n")}\n\nNew notes:\n${proposed.join("\n") || "(none)"}\n\nNotes that stay:\n${staying.map(renderNote).join("\n") || "(none)"}` },
    ],
  });
  return parseKept(reply, retired, { proposals: proposals.map(proposal => proposal.text), staying: new Map(staying.map(note => [note.id, note.text])) });
}

/** The keep call's answer as what stays of each retired note: its statements no new or staying note says or replaces (a
 * statement is held only by a note it was shown whose text has the quoted words and, when the statement names anything,
 * every word of one of those names: a note about all bills does not hold one about Atmos), or the whole note when the
 * answer leaves it out. */
export function parseKept(reply: string, retired: ReadonlyMap<number, Note>, holders: { proposals: readonly string[]; staying: ReadonlyMap<number, string> }): Kept[] {
  const answer = KeptReply.parse(replyJson(reply));
  // words only: case, quote marks, punctuation and spacing differ between a note and the model's copy of it
  const words = (text: string) => ` ${fold(text).replace(/[^\p{L}\p{N}$%]+/gu, " ").trim()} `;
  const holder = (by: string | number | null | undefined): string | undefined => {
    const label = String(by ?? "").trim().toLowerCase();
    const proposal = /^new\s*(\d+)/.exec(label);
    if (proposal) return holders.proposals[Number(proposal[1]) - 1];
    const note = /^#?(\d+)/.exec(label);
    return note ? holders.staying.get(Number(note[1])) : undefined;
  };
  const held = (statement: { names?: string[] | null; quote?: string | null; said_by?: string | number | null; replaced_by?: string | number | null }) => {
    const text = holder(statement.said_by ?? statement.replaced_by);
    const quote = words(statement.quote ?? "");
    if (text === undefined || quote.trim() === "") return false;
    const said = words(text);
    // "iPhone 16 Pro Max" is named by "the iPhone Duo ... the 16 Pro Max"
    const names = (statement.names ?? []).map(name => words(name).trim().split(" ").filter(Boolean)).filter(name => name.length > 0);
    return said.includes(quote) && (names.length === 0 || names.some(name => name.every(word => said.includes(` ${word} `))));
  };
  return [...retired.values()].flatMap((from): Kept[] => {
    const statements = answer.retired.find(each => Number(String(each.id).replace(/^#/, "")) === from.id)?.statements;
    if (!statements) return [{ from, text: from.text }];
    const text = statements.filter(each => !held(each)).map(each => each.text.trim()).filter(Boolean).join(" ");
    return text === "" ? [] : [{ from, text }];
  });
}

/** Store, in one transaction: new notes and the notes each replaces; notes retired into a current note (`retire`: note →
 * the note it gives way to); what the retired notes keep, as notes of their own with the retired note's kind, subject,
 * date, end, sources and writer; and the material read. Answers the new notes' ids. */
async function store(pool: Pool, by: string, change: { proposals?: readonly Proposal[]; retire?: ReadonlyMap<number, number>; kept?: readonly Kept[]; read?: readonly Material[] }): Promise<number[]> {
  const { proposals = [], retire = new Map<number, number>(), kept = [], read = [] } = change;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: number[] = [];
    for (const proposal of proposals) {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO memory.notes (kind, subject, text, at, until, sources, by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [proposal.kind, proposal.subject, proposal.text, proposal.at, proposal.until, proposal.sources, by],
      );
      const id = Number(rows[0]!.id);
      ids.push(id);
      if (proposal.replaces.length > 0) await client.query("UPDATE memory.notes SET replaced_by = $1 WHERE id = ANY($2) AND replaced_by IS NULL", [id, proposal.replaces]);
    }
    for (const [note, holder] of retire) await client.query("UPDATE memory.notes SET replaced_by = $1 WHERE id = $2 AND replaced_by IS NULL", [holder, note]);
    // a rest is part of a note that was already current, so the reconcile step does not take it up again as a new note
    for (const { from, text } of kept) await client.query(
      `WITH kept AS (INSERT INTO memory.notes (kind, subject, text, at, until, sources, by, kept_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id)
       INSERT INTO memory.consolidated (item_id, hash) SELECT 'memory:' || id, 'reconciled' FROM kept`,
      [from.kind, from.subject, text, from.at, from.until, from.sources, from.by, from.id]);
    if (read.length > 0) {
      await client.query("INSERT INTO memory.consolidated (item_id, hash) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (item_id) DO UPDATE SET hash = excluded.hash",
        [read.map(item => item.id), read.map(item => item.hash)]);
      // imported notes live on as notes; their own items would sit in search beside the notes that replaced them
      await client.query("DELETE FROM memory.items WHERE id = ANY($1) AND source = 'memory' AND origin = 'context'", [read.map(item => item.id)]);
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Search sees exactly the current notes: a replaced note's item goes, a current note without one gets it. */
export async function syncNoteItems(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM memory.items i USING memory.notes n WHERE i.source = 'memory' AND i.origin = 'note' AND i.ext_id = n.id::text AND n.replaced_by IS NOT NULL");
  const { rows } = await pool.query<Note>(
    "SELECT n.id::int, n.kind, n.subject, n.text, n.at, n.until, n.sources, n.by FROM memory.notes n WHERE n.replaced_by IS NULL AND NOT EXISTS (SELECT 1 FROM memory.items i WHERE i.id = 'memory:' || n.id) ORDER BY n.id");
  const items = rows.map((note): ItemInput => ({
    id: `memory:${note.id}`, source: "memory", kind: note.kind, ext_id: String(note.id), title: `${note.subject} · ${note.kind}`, at: new Date(note.at),
    body: `${note.text}${note.until ? ` (until ${day(new Date(note.until))})` : ""}`, meta: { note: note.id, subject: note.subject, sources: note.sources, by: note.by }, origin: "note",
  }));
  for (let start = 0; start < items.length; start += 64) await writeItems(pool, items.slice(start, start + 64));
}

/** Gmail's bulk tabs: mail there never says what the owner decided or who their people are. */
const BULK_MAIL = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];

/** Material not yet read (or rewritten since), oldest first: chats with the bots, the owner's work sessions (from 14 days
 *  before the first was read), imported notes, notes a bot asked to keep (`remember`), and texts and mail as they arrive,
 *  bulk mail left out (a message an earlier gate dropped stays dropped). */
async function pending(pool: Pool): Promise<Material[]> {
  const { rows } = await pool.query<Material>(
    `SELECT i.id, i.source, i.origin, i.at, i.title, i.body, coalesce(i.sender_name, i.sender, '') AS who, i.from_me, i.thread, i.thread_title, i.meta->>'project' AS project, i.hash
     FROM memory.items i LEFT JOIN memory.consolidated c ON c.item_id = i.id
     WHERE (c.item_id IS NULL OR c.hash <> i.hash)
       AND (i.source = 'chat'
         OR (i.source = 'omp' AND i.at >= (SELECT min(received_at) FROM brain.events WHERE source = 'omp') - interval '14 days')
         OR (i.source = 'memory' AND i.origin = 'context')
         OR (i.source = 'note' AND i.origin = 'note' AND i.kind = ANY($1))
         OR EXISTS (SELECT 1 FROM brain.events e WHERE e.id = i.event_id AND e.route IS DISTINCT FROM 'drop'
           AND (e.kind IN ('text.received', 'text.sent', 'mail.sent') OR (e.kind = 'mail.received' AND NOT coalesce(e.data->'labels', '[]') ?| $2))))
     ORDER BY i.at, i.id LIMIT 2000`, [NOTE_KINDS, BULK_MAIL]);
  return rows.map(row => ({ ...row, at: new Date(row.at) }));
}

/** Up to `windows` model calls over pending material in time order, each seeing every current note, then up to `windows`
 * reconcile calls over the notes not yet checked against their neighbours. Answers the notes written, the items read and
 * the notes checked (none of either: nothing was left), or undefined while another run holds the pass: the job and the
 * backlog script would otherwise read the same items side by side and write every note twice. */
export async function consolidate(pool: Pool, windows = WINDOWS_PER_RUN, now = new Date()): Promise<{ notes: number; read: number; checked: number } | undefined> {
  const lock = await pool.connect();
  try {
    if (!(await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtext('memory.notes')) AS held")).rows[0]!.held) return undefined;
    try {
      let written = 0;
      let read = 0;
      let queue = await pending(pool);
      for (let run = 0; run < windows && queue.length > 0; run++) {
        const window: Material[] = [];
        let chars = 0;
        for (const item of queue) {
          const size = Math.min(item.body.length + item.title.length, MESSAGE_CHARS) + 80;
          if (window.length > 0 && chars + size > WINDOW_CHARS) break;
          window.push(item);
          chars += size;
        }
        queue = queue.slice(window.length);
        // a reply like "yes, do that" needs what it answers: the few messages of its thread just before the window
        const first = window[0]!;
        const { rows: before } = first.thread === null ? { rows: [] as Material[] } : await pool.query<Material>(
          `SELECT id, source, origin, at, title, body, coalesce(sender_name, sender, '') AS who, from_me, thread, thread_title, meta->>'project' AS project, hash FROM memory.items
           WHERE source = $1 AND thread = $2 AND at < $3 ORDER BY at DESC LIMIT 3`, [first.source, first.thread, first.at]);
        const earlier = before.reverse().map(row => renderMaterial({ ...row, at: new Date(row.at), body: row.body.slice(0, 1500) }));
        const material = `${earlier.length > 0 ? `Earlier messages, already read (context only):\n${earlier.join("\n\n")}\n\n` : ""}New material:\n${window.map(renderMaterial).join("\n\n")}`;
        const { proposals, kept } = await readWindow(await currentNotes(pool), material, new Set(window.map(item => item.id)), window.at(-1)!.at, now);
        written += (await store(pool, "consolidation", { proposals, kept, read: window })).length;
        read += window.length;
        await syncNoteItems(pool);
      }
      const reconciled = await reconcile(pool, windows, now);
      return { notes: written + reconciled.notes, read, checked: reconciled.checked };
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('memory.notes'))");
    }
  } finally {
    lock.release();
  }
}

/** The current notes nearest `note`: the same subject, or found by search on its text. */
async function neighbours(pool: Pool, note: Note, current: ReadonlyMap<number, Note>): Promise<Note[]> {
  const { hits } = await search(pool, { query: `${note.subject}: ${note.text}`, source: ["memory"], limit: NEIGHBOURS, rerank: false });
  const ids = new Set([...hits.map(hit => Number(hit.id.replace(/^memory:/, ""))), ...[...current.values()].filter(each => fold(each.subject) === fold(note.subject)).map(each => each.id)]);
  ids.delete(note.id);
  return [...ids].flatMap(id => current.get(id) ?? []).slice(0, NEIGHBOURS * 2);
}

/**
 * Each note not yet checked, with the current notes nearest it, goes to the model a few groups per call, which names for
 * every note the note in its group that repeats it, reverses it or makes part of it out of date. A changed note gives way
 * to that note (replaced_by), and what else it says stays as a note of its own. No note is rewritten here, so nothing a
 * rewrite might drop is lost. The consolidation pass sees every current note but misses an older plan filed under another
 * subject ("AT&T" beside "Duo purchase"); a group of neighbours does not.
 */
async function reconcile(pool: Pool, calls: number, now: Date): Promise<{ notes: number; checked: number }> {
  let written = 0;
  let checked = 0;
  for (let call = 0; call < calls; call++) {
    const current = new Map((await currentNotes(pool)).map(note => [note.id, note]));
    const { rows } = await pool.query<{ id: string }>("SELECT n.id FROM memory.notes n WHERE n.replaced_by IS NULL AND NOT EXISTS (SELECT 1 FROM memory.consolidated c WHERE c.item_id = 'memory:' || n.id) ORDER BY n.id LIMIT 50");
    if (rows.length === 0) break;
    const groups: Note[][] = [];
    const alone: number[] = [];
    const shown = new Set<number>();
    for (const { id } of rows) {
      const note = current.get(Number(id))!;
      // a note shown in this call's groups waits for the next call, so no note is merged two ways at once
      if (shown.has(note.id)) continue;
      const near = (await neighbours(pool, note, current)).filter(each => !shown.has(each.id));
      if (near.length === 0) { alone.push(note.id); continue; }
      groups.push([note, ...near]);
      for (const each of [note, ...near]) shown.add(each.id);
      if (groups.length === RECONCILE_GROUPS) break;
    }
    if (groups.length > 0) {
      const { retire, kept } = await reconcileGroups(groups, now);
      await store(pool, "reconcile", { retire, kept });
      written += kept.length;
      await syncNoteItems(pool);
    }
    // checked notes go in memory.consolidated as their items' ids (memory:<note>), beside the material the pass read
    await pool.query("INSERT INTO memory.consolidated (item_id, hash) SELECT 'memory:' || id, 'reconciled' FROM unnest($1::bigint[]) AS id ON CONFLICT (item_id) DO NOTHING",
      [[...alone, ...groups.map(group => group[0]!.id)]]);
    checked += alone.length + groups.length;
  }
  return { notes: written, checked };
}

/** One reconcile call over groups of current notes (the note to check first): the notes it retires, each with the note
 * it gives way to, and what they keep. */
export async function reconcileGroups(groups: readonly Note[][], now: Date): Promise<{ retire: Map<number, number>; kept: Kept[] }> {
  const notes = groups.flat();
  const material = groups.map((group, index) => `Group ${index + 1}: ${group.map(note => `#${note.id}`).join(", ")}`).join("\n");
  const retire = parseChecked(await ask(RECONCILE, notes, material, now), new Set(notes.map(note => note.id)));
  return { retire, kept: await keep(notes, [], now, retire) };
}

/** Rewrite the profile when a note was written, or a situation ended, after the last one. */
export async function refreshProfile(pool: Pool, now = new Date(), force = false): Promise<boolean> {
  const { rows } = await pool.query<{ stale: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM memory.profile) OR EXISTS (SELECT 1 FROM memory.notes n, memory.profile p WHERE n.created_at > p.written_at OR n.until BETWEEN p.written_at AND $1) AS stale`, [now]);
  if (!force && !rows[0]?.stale) return false;
  const notes = (await currentNotes(pool)).filter(note => note.until === null || note.until >= now);
  if (notes.length === 0) return false;
  const messages: ChatMessage[] = [{ role: "system", content: PROFILE }, { role: "user", content: `Today is ${day(now)}.\n\nCurrent notes (#id · kind · subject · date: text):\n${notes.map(renderNote).join("\n")}` }];
  let text = (await complete({ role: "notes", session: "memory-profile", maxTokens: 3000, messages })).trim();
  // one shortening turn when it came out over budget
  if (text.length > PROFILE_CHARS) {
    messages.push({ role: "assistant", content: text }, { role: "user", content: `That is ${text.length} characters; it must be under 5,000. Rewrite it shorter: cut one-off details first (search finds them), keep his people, his rules for the bots, his preferences and what is happening now. Answer with the profile only.` });
    text = (await complete({ role: "notes", session: "memory-profile", maxTokens: 3000, messages })).trim();
  }
  await pool.query("INSERT INTO memory.profile (id, text, written_at) VALUES (true, $1, $2) ON CONFLICT (id) DO UPDATE SET text = excluded.text, written_at = excluded.written_at", [text, now]);
  return true;
}
