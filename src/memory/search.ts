// Search and read over memory, on Postgres.
// search: explicit filters first (person, source, from/to), then channels over the eligible chunks:
// - words: BM25 (ParadeDB) over heading ×2, people ×1.5, context, text, any of the query's meaningful words;
// - meaning: cosine of the query's local embedding against the chunks' (pgvector HNSW);
// - date: when the query names a day, week, month or "recently", chunks dated in it, or naming one of its days and dated
//   within a year of it, by words or recency;
// - person: when the query names someone, chunks of items they are on, by words or recency;
// fused by reciprocal rank (k 60), one hit per item (its best chunk). A record stands for the item it was
// read from (it repeats that item's words under a short title), so the item is found by either. The local cross-encoder
// (Qwen3-Reranker, llama-server) reorders the first RERANK_TOP with the fused rank kept as a 4:1 prior. Dated channels are
// ranking signals, never filters. A text is shown with its conversation (the messages just before and after it in its
// thread), and a text already shown in another's conversation takes no slot of its own. Other hits quote the window of the
// item where the most query words meet.
// read: one item (or `<item>#<part>`) in pages of 8 KB, with the neighbouring messages of its thread.
import type { Pool, PoolClient } from "pg";
import { OWNER, ZONE } from "../config.js";
import { embed } from "./store.js";
import { type DateMention, dateMention, fold, foldHandle, quoteOf, queryWords } from "./text.js";

/** `rerank: false` skips the cross-encoder (it costs ~0.7 s and moved one question in 172); memory_search keeps it.
 *  `trace` returns each stage's items (the eval, src/eval/recall.ts, says where a miss was lost). */
export interface SearchInput { query: string; person?: string; source?: string[]; from?: string; to?: string; limit?: number; rerank?: boolean; trace?: boolean }
/** `record`: what a record read from the item (type, when, status, ref), which search found it by. */
export interface Hit { id: string; chunk: string; title: string; date: string; who: string; source: string; kind: string; url?: string; context?: string; record?: string; quote: string; why: string }
export interface SearchResult { hits: Hit[]; person?: { id: string; name: string }[]; people?: { id: string; name: string }[]; date?: string; ms: number; channels: Record<string, number>; trace?: { channels: Record<string, string[]>; fused: string[] } }

const RRF_K = 60;
const CHANNEL_TOP = 100;
/** How many fused hits the cross-encoder reorders: ~25 ms each on a laptop GPU, so 30 keep a search near half a second. */
const RERANK_TOP = 30;
const RERANK_PRIOR = 4;
const RERANK_CHARS = 500;
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

/** Day bound of a from/to filter: a bare date is a whole local day (`to` inclusive). */
function bound(value: string, end: boolean): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? new Date(`${value.trim()}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a date: ${value}`);
  return end && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) : date;
}

/** `former`: ids of person rows merged into this one (meta.formerIds), so a lookup by an old id still lands here. */
interface Person { id: string; name: string; aliases: string[]; handles: string[]; kind: string; relationship: string | null; former: string[] }
let peopleCache: { at: number; people: Person[] } | undefined;
async function allPeople(pool: Pool): Promise<Person[]> {
  if (peopleCache && Date.now() - peopleCache.at < 60_000) return peopleCache.people;
  const { rows } = await pool.query<Person>("SELECT id, name, aliases, handles, kind, relationship, coalesce(meta->'formerIds', '[]') AS former FROM memory.people WHERE kind <> 'self'");
  peopleCache = { at: Date.now(), people: rows };
  return rows;
}

export async function resolvePerson(pool: Pool, name: string): Promise<Person[]> {
  const wanted = fold(name.trim()).replace(/^my\s+/, "");
  const handle = foldHandle(name);
  const people = await allPeople(pool);
  const exact = people.filter(each => each.id === name.trim() || each.former.includes(name.trim()) || fold(each.name) === wanted || each.aliases.some(alias => fold(alias) === wanted) || each.handles.includes(handle));
  if (exact.length > 0) return exact;
  const words = wanted.split(/\s+/).filter(word => word.length > 1);
  return people.filter(each => words.length > 0 && words.every(word => [each.name, ...each.aliases].some(known => fold(known).split(/\s+/).includes(word)))).slice(0, 10);
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

/** Records among `items`, each with the item it was read from and that item's first chunk. */
async function recordSources(pool: Pool, items: string[]): Promise<Map<string, Ranked>> {
  const { rows } = await pool.query<{ record: string; item: string; chunk: string }>(
    `SELECT r.id AS record, s.id AS item, (SELECT c.id FROM memory.chunks c WHERE c.item_id = s.id ORDER BY c.part LIMIT 1) AS chunk
     FROM memory.items r JOIN memory.items s ON s.id = coalesce(r.meta->>'item', r.meta->'sources'->0->>'item')
     WHERE r.id = ANY($1) AND r.source = 'record'`, [items]);
  return new Map(rows.filter(row => row.chunk !== null).map(row => [row.record, { id: Number(row.chunk), item: row.item }]));
}

/** The cross-encoder's score for each document, by index. */
async function rerank(query: string, documents: string[]): Promise<Map<number, number>> {
  const response = await fetch(`${process.env.RERANK_URL}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, documents }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return new Map((await response.json() as { results: { index: number; relevance_score: number }[] }).results.map(each => [each.index, each.relevance_score]));
}

export async function search(pool: Pool, input: SearchInput, now = new Date()): Promise<SearchResult> {
  const started = Date.now();
  const limit = Math.min(30, Math.max(1, Math.round(input.limit ?? 10)));
  const sql = new Sql();
  const clauses = ["true"];
  let person: Person[] | undefined;
  if (input.person?.trim()) {
    person = await resolvePerson(pool, input.person);
    if (person.length === 0) return { hits: [], person: [], ms: Date.now() - started, channels: {} };
    clauses.push(`EXISTS (SELECT 1 FROM memory.item_people r WHERE r.item_id = i.id AND r.person_id = ANY(${sql.add(person.map(each => each.id))}))`);
  }
  if (input.source?.length) clauses.push(`i.source = ANY(${sql.add(input.source)})`);
  if (input.from) clauses.push(`i.at >= ${sql.add(bound(input.from, false))}`);
  if (input.to) clauses.push(`i.at < ${sql.add(bound(input.to, true))}`);
  const where = clauses.join(" AND ");

  const date = dateMention(input.query, now);
  const words = queryWords(date ? date.spans.reduce((rest, span) => rest.replace(span, " "), input.query) : input.query);
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
  const meaning = async () => {
    const [vector] = await embed([input.query], true);
    const local = new Sql();
    local.params.push(...sql.params);
    const v = local.add(`[${vector!.join(",")}]`);
    return channel(pool, `SELECT id, item_id FROM (SELECT c.id, c.item_id, c.embedding <=> ${v}::halfvec AS d FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE ${where} ORDER BY d LIMIT ${CHANNEL_TOP}) x ORDER BY d`, local.params);
  };
  const pending: [string, Promise<Ranked[]>][] = [["words", wordChannel(pool, words, where, sql)], ["meaning", meaning()]];
  // each filter the query resolves is a channel of its own; two or more also make one channel of the items that meet them all
  const filters: [string, (local: Sql) => string][] = [];
  if (date) filters.push(["date", local => inDates(date, local)]);
  if (named.length > 0) filters.push(["person", local => ` AND EXISTS (SELECT 1 FROM memory.item_people r WHERE r.item_id = i.id AND r.person_id = ANY(${local.add(named.map(each => each.id))}))`]);
  if (sources.length > 0) filters.push(["source", local => ` AND i.source = ANY(${local.add(sources)})`]);
  for (const [name, condition] of filters) pending.push([name, scoped(condition)]);
  if (filters.length > 1) pending.push(["combined", scoped(local => filters.map(([, condition]) => condition(local)).join(""))]);
  // "the latest Babylist email": the best word matches, newest first
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
    const { rows } = await pool.query<{ id: string; item_id: string }>("SELECT DISTINCT ON (item_id) id, item_id FROM memory.chunks WHERE item_id = ANY($1) ORDER BY item_id, part", [tokens]);
    order = [...ranked(rows), ...order.filter(each => !rows.some(row => row.item_id === each.item))];
  }

  const fusedOrder = input.trace ? order.map(each => each.item) : [];
  // the reranked head, and room for the texts a conversation already shows
  const details = await hitRows(pool, order.slice(0, Math.max(RERANK_TOP, limit * 2)).map(each => each.id));
  const head = order.slice(0, RERANK_TOP);
  if (input.rerank !== false && process.env.RERANK_URL && head.length > 1) {
    const docs = head.map(each => {
      const row = details.get(each.id)!;
      return `${row.title} · ${row.who} · ${row.at.toISOString().slice(0, 10)}\n${row.context.slice(0, 160)}\n${quoteOf(row.text, words, 300)}`.slice(0, RERANK_CHARS).toWellFormed();
    });
    // a reranker that is down or failing leaves the fused order: search answers without it, and says so in the log
    const scores = await rerank(input.query, docs).catch((error: unknown) => { console.warn(`${new Date().toISOString()} reranker: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    if (scores) {
      const reordered = head.map((each, index) => ({ each, prior: index + 1, score: scores.get(index) ?? 0 })).sort((a, b) => b.score - a.score)
        .map((entry, rank) => ({ ...entry, fused: RERANK_PRIOR / (RRF_K + entry.prior) + 1 / (RRF_K + rank + 1) }))
        .sort((a, b) => b.fused - a.fused || a.prior - b.prior);
      order = [...reordered.map(entry => entry.each), ...order.slice(RERANK_TOP)];
    }
  }

  const sets = Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, new Set(list.map(each => standsFor.get(each.item)?.item ?? each.item))]));
  const candidates = order.filter(each => details.has(each.id)).map(each => details.get(each.id)!);
  const records = candidates.slice(0, limit * 2).flatMap(row => best.get(row.item_id)?.record ?? []);
  const [talk, bodies] = await Promise.all([
    conversations(pool, candidates.filter(row => row.source === "imessage" && row.thread !== null).map(row => row.item_id)),
    pool.query<{ id: string; body: string }>("SELECT id, body FROM memory.items WHERE id = ANY($1) AND NOT (source = 'imessage' AND thread IS NOT NULL)", [[...candidates.slice(0, limit * 2).map(row => row.item_id), ...records]]),
  ]);
  const body = new Map(bodies.rows.map(row => [row.id, row.body]));
  // a text near a conversation already picked joins it, and the messages between them are filled in below
  const entries: { row: HitRow; lines?: Line[]; joined: boolean }[] = [];
  const shown = new Set<string>();
  for (const row of candidates) {
    if (entries.length === limit) break;
    if (shown.has(row.item_id)) continue;
    const lines = talk.get(row.item_id);
    for (const line of lines ?? []) shown.add(line.id);
    const near = lines && entries.find(entry => entry.lines && entry.row.thread === row.thread
      && lines[0]!.at.getTime() - entry.lines.at(-1)!.at.getTime() <= JOIN_MS && entry.lines[0]!.at.getTime() - lines.at(-1)!.at.getTime() <= JOIN_MS);
    if (near) {
      near.lines = [...new Map([...near.lines!, ...lines].map(line => [line.id, line])).values()].sort((a, b) => a.at.getTime() - b.at.getTime());
      near.joined = true;
    } else entries.push({ row, ...(lines ? { lines } : {}), joined: false });
  }
  await Promise.all(entries.filter(entry => entry.joined).map(async entry => {
    const between = await span(pool, entry.row, entry.lines![0]!.at, entry.lines!.at(-1)!.at);
    if (between.length <= JOINED_LINES) entry.lines = between;
  }));
  const hits = entries.map(({ row, lines }): Hit => {
    const text = body.get(row.item_id) ?? row.text;
    const record = body.get(best.get(row.item_id)?.record ?? "");
    return {
      id: row.item_id, chunk: `${row.item_id}#${row.part}`, title: row.title, date: row.at.toISOString(), who: row.who, source: row.source, kind: row.kind,
      ...(row.url ? { url: row.url } : {}), ...(row.context ? { context: row.context } : {}), ...(record ? { record: recordLine(record) } : {}),
      quote: lines ? renderTalk(lines, row, words) : quoteOf(text === "" ? row.title : text, words, QUOTE_CHARS, body.has(row.item_id) ? row.start_at : 0),
      why: Object.keys(sets).filter(name => sets[name]!.has(row.item_id)).join(" · "),
    };
  });
  return {
    hits, ...(person ? { person: person.map(({ id, name }) => ({ id, name })) } : {}), ...(named.length ? { people: named.map(({ id, name }) => ({ id, name })) } : {}),
    ...(date ? { date: date.label } : {}), ms: Date.now() - started, channels: Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, list.length])),
    ...(input.trace ? { trace: { channels: Object.fromEntries(Object.entries(channels).map(([name, list]) => [name, [...new Set(list.map(each => each.item))]])), fused: fusedOrder } } : {}),
  };
}

interface HitRow { id: number; item_id: string; part: number; start_at: number; text: string; context: string; title: string; at: Date; who: string; source: string; kind: string; url: string | null; thread: string | null }

/** The chunks' text and their items' title, date and who: "<owner> to Sam", "Huntington Alerts", "@karpathy". */
async function hitRows(pool: Pool, ids: number[]): Promise<Map<number, HitRow>> {
  const { rows } = await pool.query<HitRow>(
    `SELECT c.id::int AS id, c.item_id, c.part, c.start_at, c.text, c.context, coalesce(nullif(i.title, ''), i.thread_title, CASE i.source WHEN 'imessage' THEN 'Texts' ELSE i.source END) AS title, i.at, i.source, i.kind, i.url, i.thread,
       CASE WHEN i.from_me THEN ${OWNER_SQL} || coalesce(' to ' || nullif((SELECT string_agg(p.name, ', ') FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'recipient' AND p.kind <> 'self'), ''), '')
         ELSE coalesce((SELECT p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'sender' LIMIT 1), i.sender_name, i.sender, '') END AS who
     FROM memory.chunks c JOIN memory.items i ON i.id = c.item_id WHERE c.id = ANY($1)`,
    [ids],
  );
  // core's pool hands timestamptz back as text
  return new Map(rows.map(row => [row.id, { ...row, at: new Date(row.at) }]));
}

interface Line { id: string; at: Date; who: string; body: string }

const LINE = `m.id, m.at, m.body, CASE WHEN m.from_me THEN ${OWNER_SQL} ELSE coalesce((SELECT p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = m.id AND r.role = 'sender' LIMIT 1), m.sender_name, m.sender, '') END AS who`;

/** Each text's conversation: the messages of its thread BEFORE ahead of it and AFTER behind it within a day, itself included. */
async function conversations(pool: Pool, ids: string[]): Promise<Map<string, Line[]>> {
  if (ids.length === 0) return new Map();
  const columns = "m.id, m.at, m.from_me, m.sender, m.sender_name, m.body";
  const { rows } = await pool.query<Line & { hit: string }>(
    `SELECT h.id AS hit, ${LINE}
     FROM memory.items h CROSS JOIN LATERAL (
       (SELECT ${columns} FROM memory.items m WHERE m.source = h.source AND m.thread = h.thread AND m.at < h.at AND m.at > h.at - interval '1 day' ORDER BY m.at DESC LIMIT ${BEFORE})
       UNION ALL
       (SELECT ${columns} FROM memory.items m WHERE m.source = h.source AND m.thread = h.thread AND m.at >= h.at AND m.at < h.at + interval '1 day' ORDER BY m.at LIMIT ${AFTER + 1})
     ) m
     WHERE h.id = ANY($1) ORDER BY h.id, m.at, m.id`, [ids]);
  const talk = new Map<string, Line[]>();
  for (const { hit, ...line } of rows) talk.set(hit, [...(talk.get(hit) ?? []), { ...line, at: new Date(line.at) }]);
  return talk;
}

/** The messages of a hit's thread from `from` to `to`, one more than JOINED_LINES at most. */
async function span(pool: Pool, hit: HitRow, from: Date, to: Date): Promise<Line[]> {
  const { rows } = await pool.query<Line>(`SELECT ${LINE} FROM memory.items m WHERE m.source = $1 AND m.thread = $2 AND m.at BETWEEN $3 AND $4 ORDER BY m.at, m.id LIMIT ${JOINED_LINES + 1}`, [hit.source, hit.thread, from, to]);
  return rows.map(line => ({ ...line, at: new Date(line.at) }));
}

/** A conversation as short lines, "9:14 AM Sam: …" (with the day when it is not the hit's); the hit's own line quotes its
 *  best window. A neighbour Messages kept no text for (an attachment, "�") is left out. */
function renderTalk(lines: readonly Line[], hit: HitRow, words: readonly string[]): string {
  const day = (at: Date) => at.toLocaleDateString("en-US", { timeZone: ZONE, month: "short", day: "numeric" });
  return lines.filter(line => line.id === hit.item_id || !/^[\s\uFFFC\uFFFD]*$/.test(line.body)).map(line => {
    const flat = line.body.replace(/\s+/g, " ").trim();
    const text = line.id === hit.item_id ? quoteOf(flat, words, QUOTE_CHARS) : flat.length > TEXT_CHARS ? `${flat.slice(0, TEXT_CHARS).trimEnd()}…`.toWellFormed() : flat;
    return `${day(line.at) === day(hit.at) ? "" : `${day(line.at)}, `}${line.at.toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" })} ${line.who || "?"}: ${text}`;
  }).join("\n");
}

/** A record on one line, without its ids, provenance and duplicate quotes: "Puttshack booking · Reservation · Puttshack · When Fri, Oct 24, 2025 at 5:10 PM · Ref: VL4PRJ3 · Quote: …". */
function recordLine(body: string): string {
  const line = body.split("\n").map(each => each.trim()).filter(each => each !== "" && !/^(?:id|item|source|confidence|not kept|all_day|people: (?:\[\]|person:)|\w+ quote)\b/i.test(each)).join(" · ");
  return line.length > TEXT_CHARS ? `${line.slice(0, TEXT_CHARS).trimEnd()}…`.toWellFormed() : line;
}

/** Hits as plain lines, for the CLI and a turn's head. */
export function renderHits(hits: readonly Hit[]): string {
  if (hits.length === 0) return "";
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `Memory (verbatim from ${OWNER.name}'s texts, mail, records, calendar, bookmarks and chats; memory_read <id> opens one; these are the best matches, not all of them: for how many, how much in total or the latest, run memory_query, which counts by SQL over every record and item):\n${hits.map(hit =>
    [`[${day(hit.date)} · ${hit.source}${hit.who ? ` · ${hit.who}` : ""}] ${hit.title} (${hit.chunk})`, hit.context, hit.record ? `Record: ${hit.record}` : "", hit.url, hit.quote].filter(Boolean).join("\n")).join("\n\n")}`;
}

// ── read ──

const PAGE_CHARS = 8 * 1024;
const WINDOW = 5;

export async function read(pool: Pool, id: string, page?: number) {
  const match = /^(.+)#(\d+)$/.exec(id.trim());
  const itemId = match ? match[1]! : id.trim();
  const { rows: [item] } = await pool.query("SELECT * FROM memory.items WHERE id = $1", [itemId]);
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
  const { rows: people } = await pool.query<{ role: string; name: string }>("SELECT r.role, p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = $1 ORDER BY r.role, p.name", [itemId]);
  const result: Record<string, unknown> = {
    id: item.id, title: item.title || item.thread_title || item.source, source: item.source, kind: item.kind, date: item.at, url: item.url ?? undefined,
    from: item.from_me ? OWNER.name : item.sender_name ?? item.sender ?? undefined, people: people.map(each => `${each.name} (${each.role})`),
    text: pages[at]!.text, page: at, pages: pages.length,
  };
  if (item.kind === "message" && item.thread) {
    // texts: the same chat within a day; else at least the message before and after
    const day = item.source === "imessage" ? "AND at BETWEEN $4::timestamptz - interval '1 day' AND $4::timestamptz + interval '1 day'" : "";
    const near = async (cmp: "<" | ">", dir: "DESC" | "ASC") => (await pool.query(`SELECT id, at, from_me, sender_name, sender, left(body, 300) AS text FROM memory.items WHERE source = $1 AND thread = $2 AND id <> $3 AND at ${cmp} $4 ${day} ORDER BY at ${dir} LIMIT ${WINDOW}`, [item.source, item.thread, item.id, item.at])).rows;
    const around = [...(await near("<", "DESC")).reverse(), ...(await near(">", "ASC"))];
    if (around.length > 0) result.thread = around.map(each => ({ id: each.id, date: each.at, from: each.from_me ? OWNER.name : each.sender_name ?? each.sender, text: each.text.replace(/\s+/g, " ").trim() }));
  } else if (chunks.length > 1) result.sections = chunks.map(chunk => ({ chunk: `${itemId}#${chunk.part}`, heading: chunk.heading }));
  return result;
}
