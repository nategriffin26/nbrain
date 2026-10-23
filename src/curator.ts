// The curator: besides the owner's own hand, the only writer of the profile files in the context repo (format in
// context/profile.ts). Two ways in: corrections an agent passed on (applyCorrections, every minute) and the owner's own
// words (nightly, 03:30). It closes and adds lines and never rewrites a file: a closed line moves to closed.md, so nothing
// is lost, and each change is one commit that the weekly message lists and `undo <id>` takes back. A line a correction
// set changes only by a later correction, so the nightly pass cannot undo what the owner fixed. The one exception: a line
// drawn from something the owner marked private leaves outright (applyPrivate).
import { readFile, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import * as z from "zod";
import { CONTEXT, OWNER } from "./config.js";
import { commit, git } from "./context/git.js";
import { CLOSED_FILE, formatLine, NOW_FILE, parseProfile, PROFILE_FILES, type ProfileLine, stripSources } from "./context/profile.js";
import { cursorOk, readCursor } from "./events/store.js";
import { correctCard } from "./library/cards.js";
import { chain } from "./memory/records.js";
import { complete, replyJson } from "./models.js";
import { writeNow } from "./now.js";
import { localTime } from "./time.js";

const O = OWNER.name;
const PROFILE = new Set<string>(PROFILE_FILES.map(each => each.file));
const CORRECTIONS = "curator.corrections";
const NIGHTLY = "curator.nightly";
const PRIVATE = "curator.private";
const DAY = 86_400_000;
/** Per piece of evidence and per nightly call (~40k tokens): a heavy day of chats and sessions fits whole. */
const ITEM_CHARS = 1500;
const EVIDENCE_CHARS = 160_000;

/** The profile files and closed.md by name, as text ("" when missing). */
export type Texts = Record<string, string>;
export interface Close { file: string; line: number; reason: string; sources: string[] }
export interface Add { file: string; section: string; text: string; sources: string[]; day: string }
export interface Edits { close: Close[]; add: Add[] }
export interface Applied { texts: Texts; applied: string[]; skipped: { op: Close | Add; reason: string }[] }

// ---- the files ----

const clean = (text: string) => text.replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim();

/** `raw` as the last line of `section` ("" = before the first `## `): after its last statement, else right under its
 *  heading; a section not there yet is added at the end of the file. */
export function insertRaw(text: string, section: string, raw: string): string {
  const lines = text === "" ? [] : text.split("\n");
  const headings = lines.flatMap((line, index) => (/^##\s/.test(line) ? [index] : []));
  const at = section === "" ? -1 : lines.findIndex(line => /^##\s+(.+?)\s*$/.exec(line)?.[1] === section);
  if (section !== "" && at < 0) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    return [...lines, ...(lines.length ? [""] : []), `## ${section}`, raw, ""].join("\n");
  }
  const end = headings.find(index => index > at) ?? lines.length;
  let after = at;
  for (let index = at + 1; index < end; index++) if (/^\s*[-*]\s+\S/.test(lines[index]!)) after = index;
  // a file with no statements before its first section: under the title, after a blank line
  if (after < 0 && /^#\s/.test(lines[0] ?? "")) { lines.splice(1, 0, ...(lines[1] === "" ? [] : [""])); after = 1; }
  lines.splice(after + 1, 0, raw);
  return lines.join("\n");
}

/** Close one statement: it leaves its file and joins closed.md with the day, who closed it and why, and where it came from. */
export function closeLine(texts: Texts, line: ProfileLine, day: string, by: string, reason: string): Texts {
  const lines = (texts[line.file] ?? "").split("\n");
  if (!/^\s*[-*]\s+\S/.test(lines[line.line - 1] ?? "")) throw new Error(`${line.file}:${line.line} is not a statement`);
  lines.splice(line.line - 1, 1);
  const was = `${line.sources.join(", ")}${line.day ? ` ${line.day}` : ""}`;
  const entry = `- ${clean(line.text)} <!-- closed ${day} by ${by}: ${clean(reason).replace(/;/g, ",").replace(/[.,\s]+$/, "")}; was ${was} -->`;
  const closed = texts[CLOSED_FILE] || "# Closed\n";
  return { ...texts, [line.file]: lines.join("\n"), [CLOSED_FILE]: `${closed.replace(/\n*$/, "\n")}${entry}\n` };
}

/** Apply closes, then adds. A close names a statement by its file:line in `seen`, the files as the model was shown them,
 *  and lands on that exact line wherever it sits in `texts` now; a line changed or gone since is skipped. Outside a
 *  correction it may not touch a line a correction set. An add already in its file is skipped. Files have no size cap:
 *  the brief picks lines per task within its own budget, so a true line never waits for room. */
export function applyEdits(texts: Texts, edits: Edits, rules: { day: string; correction: boolean }, seen: Texts = texts): Applied {
  let out = { ...texts };
  const applied: string[] = [], skipped: Applied["skipped"] = [];
  const parsed = new Map([...PROFILE].map(file => [file, parseProfile(file, texts[file] ?? "")]));
  const bound = edits.close.flatMap(close => {
    if (!parseProfile(close.file, seen[close.file] ?? "").some(each => each.line === close.line)) { skipped.push({ op: close, reason: "no such line" }); return []; }
    const raw = (seen[close.file] ?? "").split("\n")[close.line - 1]!;
    const at = (texts[close.file] ?? "").split("\n").indexOf(raw) + 1;
    const line = parsed.get(close.file)?.find(each => each.line === at);
    if (!line) { skipped.push({ op: close, reason: "changed since it was shown" }); return []; }
    return [{ close, line }];
  });
  const done = new Set<string>();
  // bottom up, so each close's line number still points at its line
  for (const { close, line } of bound.sort((a, b) => a.line.file.localeCompare(b.line.file) || b.line.line - a.line.line)) {
    if (done.has(`${line.file}:${line.line}`)) { skipped.push({ op: close, reason: "no such line" }); continue; }
    if (!rules.correction && line.sources.some(source => source.startsWith("correction:"))) { skipped.push({ op: close, reason: "set by a correction" }); continue; }
    done.add(`${line.file}:${line.line}`);
    out = closeLine(out, line, rules.day, close.sources.join(", "), close.reason);
    applied.push(`close ${close.file}: ${clean(line.text)} (${clean(close.reason)})`);
  }
  for (const add of edits.add) {
    const text = out[add.file] ?? "";
    if (!PROFILE.has(add.file)) { skipped.push({ op: add, reason: "not a profile file" }); continue; }
    const wanted = clean(add.text).toLowerCase();
    if (wanted === "" || parseProfile(add.file, text).some(line => clean(line.text).toLowerCase() === wanted)) { skipped.push({ op: add, reason: "already there" }); continue; }
    out = { ...out, [add.file]: insertRaw(text, add.section, formatLine(add.text, add.sources, add.day)) };
    applied.push(`add ${add.file}: ${clean(add.text)}`);
  }
  return { texts: out, applied, skipped };
}

const readText = (name: string) => readFile(`${CONTEXT}/${name}`, "utf8").catch(() => "");
async function readTexts(): Promise<Texts> {
  const names = [...PROFILE, CLOSED_FILE];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readText(name)] as const)));
}
/** Write what changed; answers the changed paths. */
async function save(before: Texts, after: Texts): Promise<string[]> {
  const changed = Object.keys(after).filter(name => after[name] !== before[name]);
  await Promise.all(changed.map(name => writeFile(`${CONTEXT}/${name}`, after[name]!)));
  return changed;
}

// Corrections and the nightly pass run in one process on different loops; each read-change-write of the files waits its turn.
let turn: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = turn.then(job, job);
  turn = run.catch(() => undefined);
  return run;
}

function renderProfile(texts: Texts): string {
  return PROFILE_FILES.map(({ file, scope }) => [
    `${file} (${scope} scope):`,
    ...parseProfile(file, texts[file] ?? "").map(line => `${file}:${line.line} [${line.section || "-"}] ${line.text}  (${line.sources.join(", ")}${line.day ? ` ${line.day}` : ""})`),
  ].join("\n")).join("\n\n");
}

// ---- undo ----

const HEADER = /^(---|\+\+\+) (a\/|b\/|\/dev\/null)/;

const STATEMENT = /^\s*[-*]\s+\S/;

/** Take back one change (a commit's short id): the lines it added leave their files (closed.md too), and the lines it
 *  removed come back to the end of the section they were in. Answers the changed paths, or why it refused: a change
 *  whose added lines a later change already took away (A → B, then B → C) is not undone, since bringing A back would
 *  stand it beside the newer C. */
export async function undo(id: string): Promise<{ paths: string[]; refused?: string }> {
  const paths = (await git(["show", "--format=", "--name-only", id])).split("\n").filter(path => PROFILE.has(path) || path === CLOSED_FILE);
  const before = await readTexts();
  const diffs = await Promise.all(paths.map(async path => {
    const diff = (await git(["show", "--format=", "-U0", id, "--", path])).split("\n").filter(line => !HEADER.test(line));
    return { path, added: diff.filter(line => line.startsWith("+")).map(line => line.slice(1)), removed: diff.filter(line => line.startsWith("-")).map(line => line.slice(1)) };
  }));
  const gone = diffs.flatMap(({ path, added }) => added.filter(raw => STATEMENT.test(raw) && !before[path]!.split("\n").includes(raw)));
  if (gone.length) return { paths: [], refused: `undo ${id} refused: a later change already took away ${gone.length} of the lines it added` };
  const after = { ...before };
  for (const { path, added, removed } of diffs) {
    const lines = after[path]!.split("\n");
    for (const raw of added) { const at = lines.indexOf(raw); if (at >= 0 && raw.trim() !== "") lines.splice(at, 1); }
    let text = lines.join("\n");
    const parent = removed.length ? await git(["show", `${id}~1:${path}`]).catch(() => "") : "";
    for (const raw of removed.filter(line => STATEMENT.test(line))) {
      if (text.split("\n").includes(raw)) continue;
      let section = "";
      for (const line of parent.split("\n")) { const heading = /^##\s+(.+?)\s*$/.exec(line); if (heading) section = heading[1]!; else if (line === raw) break; }
      text = insertRaw(text, section, raw);
    }
    after[path] = text;
  }
  return { paths: await save(before, after) };
}

/** The change a correction asks to undo: its target is a change id and it says undo, or it says "undo <id>". */
export function undoTarget(target: string | null, text: string): string | undefined {
  if (target && /^[0-9a-f]{7,40}$/.test(target) && /\bundo\b/i.test(text)) return target;
  return /\bundo\s+([0-9a-f]{7,40})\b/i.exec(text)?.[1];
}

// ---- corrections ----

interface Correction { id: string; target: string | null; text: string; by: string; at: Date }
interface Target { text: string; card?: string; records: Set<string> }

/** What a correction is about, as the model reads it: a card, a record, or an item with the records read from it.
 *  Nothing when that is private: a correction never shows the model what the owner kept out. */
async function targetOf(pool: Pool, id: string | null): Promise<Target> {
  const none: Target = { text: "", records: new Set() };
  if (!id || (await pool.query(`SELECT ${privateRef("$1::text")} AS private`, [id])).rows[0].private) return none;
  if (id.startsWith("card:")) {
    const card = (await pool.query("SELECT id, kind, what, why, url, projects FROM memory.cards WHERE id = $1", [id])).rows[0];
    return card ? { text: `Library card ${card.id} (${card.kind}): what: ${card.what}\nwhy: ${card.why}`, card: card.id, records: new Set() } : none;
  }
  const { rows: records } = await pool.query(
    `SELECT id, type, org, title, people, amount, due_at, paid_at, start_at, status, item_id FROM memory.records
     WHERE (id = $1 OR item_id = $1) AND superseded_by IS NULL`, [id]);
  const itemId = records.find(record => record.id === id)?.item_id ?? id;
  const item = (await pool.query("SELECT id, source, at, sender_name, sender, thread_title, left(body, 4000) AS body FROM memory.items WHERE id = $1", [itemId])).rows[0];
  const lines = [
    ...(item ? [`Item ${item.id} (${item.source}, ${localTime(new Date(item.at).getTime()).slice(0, 16)}, from ${item.sender_name ?? item.sender ?? "?"}${item.thread_title ? `, ${item.thread_title}` : ""}):\n${item.body}`] : []),
    ...records.map(record => `Record ${record.id}: ${JSON.stringify({ ...record, item_id: undefined })}`),
  ];
  return { text: lines.join("\n\n"), records: new Set(records.map(record => record.id as string)) };
}

const CorrectionReply = z.object({
  close: z.array(z.object({ file: z.string(), line: z.coerce.number(), reason: z.string() })).default([]),
  add: z.array(z.object({ file: z.string(), section: z.string().default(""), text: z.string() })).default([]),
  retract: z.array(z.string()).default([]),
  card: z.object({ what: z.string().optional(), why: z.string().optional() }).nullish(),
  now: z.boolean().default(false),
  summary: z.string().default(""),
});

const correctionSystem = `You apply one correction to ${O}'s brain. An agent passed it on, usually in ${O}'s words. You get the correction, what it is about when known, ${O}'s profile (each line as file:line [section] text (source day)) and now.md. Answer with the edits that make the brain say what the correction says, and nothing more:
- close: profile lines the correction shows are wrong or no longer true, by file and line, with a short reason.
- add: the right statement, when the correction gives one worth keeping in the profile: one plain line in the file and section it belongs in, ${O} named in the third person, absolute dates. Life facts (family, health, money, home, people) go in life.md; the other files are read by every coding agent. Never add a line that only says something was wrong.
- retract: ids of the records shown to you that the correction shows were never true (misread, the wrong person, never happened).
- card: a new what and/or why for the library card shown, when the correction is about it.
- now: true when the correction is about what now.md says is going on (it is rewritten from the record with the correction in hand).
A correction can need several of these or none. Lines it does not touch stay as they are.
Answer with JSON only: {"close":[{"file":"…","line":7,"reason":"…"}],"add":[{"file":"…","section":"…","text":"…"}],"retract":["…"],"card":null,"now":false,"summary":"what changed, in a line"}`;

async function applyCorrection(pool: Pool, correction: Correction): Promise<string | undefined> {
  const source = `correction:${correction.id}`;
  const day = localTime(correction.at.getTime()).slice(0, 10);
  const undoing = undoTarget(correction.target, correction.text);
  if (undoing && await git(["cat-file", "-t", undoing]).then(kind => kind === "commit", () => false)) {
    return exclusive(async () => {
      const { paths, refused } = await undo(undoing);
      if (refused) console.warn(`curator: correction ${correction.id}: ${refused}`);
      return commit(paths, `correction ${correction.id}: undo ${undoing}`, correction.by);
    });
  }
  const target = await targetOf(pool, correction.target);
  // the profile as the model sees it: its closes land on these lines, wherever they sit once the turn comes
  const seen = await readTexts();
  const reply = CorrectionReply.parse(replyJson(await complete({
    role: "curator", session: "curator-corrections", maxTokens: 4096,
    messages: [
      { role: "system", content: correctionSystem },
      { role: "user", content: `The correction (${source}, from ${correction.by}, ${day}${correction.target ? `, about ${correction.target}` : ""}):\n${correction.text}\n\n${target.text ? `What it is about:\n${target.text}\n\n` : ""}The profile:\n${renderProfile(seen)}\n\nnow.md:\n${stripSources(await readText(NOW_FILE)) || "(none yet)"}` },
    ],
  })));
  const retract = reply.retract.filter(id => target.records.has(id));
  if (retract.length) {
    const { rows } = await pool.query<{ same_as: string | null }>("UPDATE memory.records SET superseded_by = $1 WHERE id = ANY($2) AND superseded_by IS NULL RETURNING same_as", [source, retract]);
    // what the retracted record had superseded is the latest of its kind again
    for (const key of new Set(rows.flatMap(row => row.same_as ? [row.same_as] : []))) await chain(pool, key);
  }
  if (target.card && (reply.card?.what || reply.card?.why)) await correctCard(pool, target.card, reply.card, source);
  const id = await exclusive(async () => {
    const texts = await readTexts();
    const edits = {
      close: reply.close.map(close => ({ ...close, sources: [source] })),
      add: reply.add.map(add => ({ ...add, sources: [source], day })),
    };
    const result = applyEdits(texts, edits, { day, correction: true }, seen);
    for (const each of result.skipped) console.warn(`curator: ${source}: skipped ${JSON.stringify(each.op)}: ${each.reason}`);
    return commit(await save(texts, result.texts), `correction ${correction.id}: ${clean(reply.summary || result.applied.join("; ")).slice(0, 200)}`, correction.by);
  });
  if (reply.now) await writeNow(pool);
  return id;
}

/** Apply every correction past the cursor, oldest first, one commit each; answers how many. Private marks go first
 *  (applyPrivate). A correction that fails stops the run, and the next tick tries it again. */
export async function applyCorrections(pool: Pool): Promise<number> {
  await applyPrivate(pool);
  const after = Number(await readCursor(pool, CORRECTIONS) ?? 0);
  const { rows } = await pool.query<Correction>("SELECT id::text, target, text, by, at FROM memory.corrections WHERE id > $1 ORDER BY id LIMIT 20", [after]);
  for (const row of rows) {
    await applyCorrection(pool, row);
    await cursorOk(pool, CORRECTIONS, row.id);
  }
  return rows.length;
}

// ---- private ----

/** SQL: `ref` (an item id, with or without its #chunk, a record id or a card id) names an item marked private, by
 *  itself or by its thread. */
export const privateRef = (ref: string) => `EXISTS (SELECT 1 FROM memory.items i
  WHERE i.id IN (regexp_replace(${ref}, '#\\d+$', ''), (SELECT r.item_id FROM memory.records r WHERE r.id = ${ref}), (SELECT k.item_id FROM memory.cards k WHERE k.id = ${ref}))
    AND NOT ${NOT_PRIVATE})`;

/** The sources a closed.md entry carries: who closed it and where the line came from. */
const closedSources = (raw: string) => {
  const match = /<!-- closed \S+ by (.*?): .*; was (.*?)(?: \d{4}-\d{2}-\d{2})? -->\s*$/.exec(raw);
  return match ? `${match[1]}, ${match[2]}`.split(",").map(each => each.trim()).filter(Boolean) : [];
};

/** What the owner marked private leaves everything derived from it, every tick: profile lines and closed.md entries with
 *  a private source are removed outright (closing would keep their text) in one commit that names no line, and when
 *  something was marked since the last run, now.md is written again from what is left. Answers how many lines left. */
export async function applyPrivate(pool: Pool): Promise<number> {
  const removed = await exclusive(async () => {
    const texts = await readTexts();
    const lines = Object.entries(texts).flatMap(([file, text]) => text.split("\n").map((raw, index) => ({
      file, index, sources: file === CLOSED_FILE ? closedSources(raw) : STATEMENT.test(raw) ? parseProfile(file, raw)[0]!.sources : [],
    })));
    const sources = [...new Set(lines.flatMap(line => line.sources))];
    const hidden = new Set(sources.length ? (await pool.query<{ s: string }>(`SELECT s FROM unnest($1::text[]) s WHERE ${privateRef("s")}`, [sources])).rows.map(row => row.s) : []);
    const gone = lines.filter(line => line.sources.some(source => hidden.has(source)));
    if (!gone.length) return 0;
    const after = { ...texts };
    for (const file of new Set(gone.map(line => line.file))) {
      const drop = new Set(gone.filter(line => line.file === file).map(line => line.index));
      after[file] = texts[file]!.split("\n").filter((_, index) => !drop.has(index)).join("\n");
    }
    await commit(await save(texts, after), `private: removed ${gone.length} ${gone.length === 1 ? "line" : "lines"} drawn from what was marked private`, "curator");
    return gone.length;
  });
  const since = await readCursor(pool, PRIVATE);
  const { rows: [mark] } = await pool.query<{ at: string | null }>("SELECT max(at)::text AS at FROM memory.private WHERE $1::timestamptz IS NULL OR at > $1::timestamptz", [since]);
  if (mark?.at) {
    await writeNow(pool);
    await cursorOk(pool, PRIVATE, mark.at);
  }
  return removed;
}

// ---- the owner's own words, nightly ----

export interface Evidence { id: string; day: string; label: string; text: string }

/** What the owner said in a chat or session body: the "Alex: …" turns among the bots' and agents' turns. */
export function ownerTurns(body: string, owner = O): string {
  const marks = [...body.matchAll(/(?:^|\n\n)([A-Za-z][\w .'-]{0,40}): /g)];
  return marks
    .map((mark, index) => ({ who: mark[1]!, text: body.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? body.length).trim() }))
    .filter(turn => turn.who.toLowerCase() === owner.toLowerCase())
    .map(turn => turn.text).join("\n");
}

/** SQL: item `i` is not marked private, by itself or by its thread. */
export const NOT_PRIVATE = "NOT EXISTS (SELECT 1 FROM memory.private p WHERE p.target = i.id OR p.target = 'thread:' || i.source || ':' || i.thread)";

/** The owner's own words that reached the record between `since` and `until`: their turns with the bots and their
 *  prompts in coding sessions, notes bots left (they quote the owner), and records the owner is a party to. Never private. */
export async function ownerWords(pool: Pool, since: string, until: string): Promise<Evidence[]> {
  const { rows: items } = await pool.query<{ id: string; source: string; at: Date; sender_name: string | null; thread_title: string | null; body: string }>(
    `SELECT i.id, i.source, i.at, i.sender_name, i.thread_title, i.body FROM memory.items i
     WHERE i.created_at >= $1 AND i.created_at < $2 AND i.source IN ('chat', 'omp', 'note') AND ${NOT_PRIVATE} ORDER BY i.at`, [since, until]);
  const { rows: records } = await pool.query<{ id: string; type: string; org: string | null; title: string; amount: string | null; due_at: Date | null; start_at: Date | null; status: string | null; at: Date }>(
    `SELECT r.id, r.type, r.org, r.title, r.amount, r.due_at, r.start_at, r.status, i.at FROM memory.records r JOIN memory.items i ON i.id = r.item_id
     WHERE i.created_at >= $1 AND i.created_at < $2 AND r.superseded_by IS NULL AND ${NOT_PRIVATE}
       AND (i.from_me OR r.people ?| (array(SELECT id FROM memory.people WHERE kind = 'self') || array[$3::text, $4::text]))
     ORDER BY i.at`, [since, until, OWNER.name, OWNER.fullName]);
  const day = (at: Date) => localTime(at.getTime()).slice(0, 10);
  const said = items.flatMap(item => {
    const own = item.source === "note" ? item.body
      : ownerTurns(item.body) || ((item.sender_name ?? "").toLowerCase() === O.toLowerCase() ? item.body : "");
    if (!own.trim()) return [];
    const label = item.source === "note" ? `note by ${item.sender_name ?? "a bot"}` : item.source === "chat" ? `${O} to ${item.thread_title ?? "a bot"}` : `${O} in a coding session${item.thread_title ? ` (${item.thread_title})` : ""}`;
    return [{ id: item.id, day: day(item.at), label, text: own.slice(0, ITEM_CHARS) }];
  });
  const kept = records.map(record => ({
    id: record.id, day: day(record.at), label: `record, ${record.type}`,
    text: [record.org, record.title, record.amount && `$${record.amount}`, record.due_at && `due ${day(record.due_at)}`, record.start_at && `on ${day(record.start_at)}`, record.status].filter(Boolean).join(" · "),
  }));
  let used = 0;
  return [...said, ...kept].filter(each => (used += each.text.length + 80) <= EVIDENCE_CHARS);
}

const Quoted = { source: z.string(), quote: z.string() };
const NightlyReply = z.object({
  close: z.array(z.object({ file: z.string(), line: z.coerce.number(), reason: z.string(), ...Quoted })).default([]),
  add: z.array(z.object({ file: z.string(), section: z.string().default(""), text: z.string(), ...Quoted })).default([]),
});

const squash = (text: string) => text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/** The model's edits that quote what they cite: each must name evidence it was shown and quote it word for word. */
export function parseNightly(reply: string, evidence: readonly Evidence[]): Edits {
  const parsed = NightlyReply.parse(replyJson(reply));
  const byId = new Map(evidence.map(each => [each.id, each]));
  const grounded = (op: { source: string; quote: string }) => {
    const shown = byId.get(op.source.replace(/^\[|\]$/g, ""));
    return shown && squash(op.quote).length >= 8 && squash(shown.text).includes(squash(op.quote)) ? shown : undefined;
  };
  return {
    close: parsed.close.flatMap(op => { const shown = grounded(op); return shown ? [{ file: op.file, line: op.line, reason: op.reason, sources: [shown.id] }] : []; }),
    add: parsed.add.flatMap(op => { const shown = grounded(op); return shown ? [{ file: op.file, section: op.section, text: op.text, sources: [shown.id], day: shown.day }] : []; }),
  };
}

const nightlySystem = `You keep ${O}'s profile current from ${OWNER.their} own words. You get the profile (each line as file:line [section] text (source day)) and what reached the record since the last run: ${O}'s turns in chats with ${OWNER.their} bots, ${OWNER.their} prompts in coding sessions, notes bots left (often quoting ${OWNER.them}) and records ${OWNER.they} is a party to. Every agent reads these files at the start of every task, so most nights the right answer is no change.
- add: only a durable statement ${O} made or plainly confirmed about how ${OWNER.they} works, what ${OWNER.they} wants, how ${OWNER.they} decides, ${OWNER.their} tastes, goals, projects, things ${OWNER.they} made, or ${OWNER.their} life, that will still hold next month and that an agent would act on. Not a request for the task at hand, a status, a bot's proposal ${O} did not take up, or what someone else said. Not a restatement of a line already there.
- close: a line ${O}'s words show is no longer true, with the reason.
- Lines whose source starts with correction: are settled: never close them or add anything that contradicts them.
- Each edit names the one source id it comes from and quotes the words in it that justify it, verbatim (at least a few words).
- One plain line in the file's voice, ${O} named in the third person, absolute dates. Life facts (family, health, money, home, people) go in life.md, never a work file. Nothing about other people's private news.
Answer with JSON only: {"close":[{"file":"…","line":7,"reason":"…","source":"…","quote":"…"}],"add":[{"file":"…","section":"…","text":"…","source":"…","quote":"…"}]}, or {"close":[],"add":[]}.`;

/** The nightly pass (03:30): the owner's words since the last run, proposed as closes and adds that quote them, each
 *  applied as its own commit by "curator". Answers the commit ids. */
export async function nightly(pool: Pool, now = new Date()): Promise<string[]> {
  const since = (await readCursor(pool, NIGHTLY)) ?? new Date(now.getTime() - DAY).toISOString();
  const evidence = await ownerWords(pool, since, now.toISOString());
  const ids: string[] = [];
  if (evidence.length) {
    // the profile as the model sees it: each close lands on the line it saw, however earlier commits moved it
    const seen = await readTexts();
    const reply = await complete({
      role: "curator", session: "curator-nightly", maxTokens: 4096,
      messages: [
        { role: "system", content: nightlySystem },
        { role: "user", content: `The profile:\n${renderProfile(seen)}\n\nSince ${localTime(Date.parse(since)).slice(0, 16)}:\n${evidence.map(each => `[${each.id}] ${each.day} ${each.label}: ${each.text}`).join("\n\n")}` },
      ],
    });
    const edits = parseNightly(reply, evidence);
    const day = localTime(now.getTime()).slice(0, 10);
    // one commit per change, so the weekly list can offer each for undo on its own
    for (const op of [...edits.close.map(close => ({ close: [close], add: [] })), ...edits.add.map(add => ({ close: [], add: [add] }))]) {
      const id = await exclusive(async () => {
        const texts = await readTexts();
        const result = applyEdits(texts, op, { day, correction: false }, seen);
        for (const each of result.skipped) console.warn(`curator: skipped ${JSON.stringify(each.op)}: ${each.reason}`);
        if (!result.applied.length) return undefined;
        return commit(await save(texts, result.texts), `curator: ${result.applied[0]!.slice(0, 200)} (${[...op.close, ...op.add][0]!.sources.join(", ")})`, "curator");
      });
      if (id) ids.push(id);
    }
  }
  await cursorOk(pool, NIGHTLY, now.toISOString());
  return ids;
}
