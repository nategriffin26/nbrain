// Writes raw things into memory: an item verbatim, its people, and its chunks with their local embeddings.
// Embeddings come from Ollama's Qwen3-Embedding-0.6B at its full 1024 dimensions, on this machine.
import type { Pool } from "pg";
import * as z from "zod";
import { OWNER } from "../config.js";
import { chunkBody, cleanText, sha256 } from "./text.js";

export const EMBED_MODEL = "qwen3-embedding:0.6b";
const EMBED_BATCH = 16;
/** Two batches in flight keep Ollama's runner fed: on short texts that is 58 chunks/s against 24 one batch at a time. */
const IN_FLIGHT = 2;
/** The most one embedding input carries. */
const EMBED_CHARS = 2000;
const QUERY_INSTRUCTION = `Instruct: Given a question ${OWNER.name} asks about ${OWNER.their} own texts, emails, saved posts, records, calendar and chats, find the ones that answer it\nQuery: `;
const Embeddings = z.object({ embeddings: z.array(z.array(z.number())) });
/** An urgent embedding's deadline, every batch together: a warm query takes ~0.09 s, but Ollama unloads an idle model and
 *  loading it again took 4.2 s. A search or brief goes on without it past this. */
const URGENT_MS = 6000;

/** Unit vectors for `texts`. A `query` gets the retrieval instruction and is `urgent`: someone waits on it, so it has a
 *  deadline. */
export async function embed(texts: readonly string[], { query = false, urgent = query }: { query?: boolean; urgent?: boolean } = {}): Promise<number[][]> {
  const inputs = texts.map(text => `${query ? QUERY_INSTRUCTION : ""}${text.slice(0, EMBED_CHARS)}`);
  const batches = Array.from({ length: Math.ceil(inputs.length / EMBED_BATCH) }, (_, at) => at * EMBED_BATCH);
  // one call's requests end together: at the first failure no worker takes another batch, what is in flight is aborted,
  // and the call rejects once every worker has stopped
  const stop = new AbortController();
  const ended = urgent ? AbortSignal.any([stop.signal, AbortSignal.timeout(URGENT_MS)]) : stop.signal;
  let failure: { error: unknown } | undefined;
  const out: number[][] = [];
  const worker = async () => {
    while (!stop.signal.aborted) {
      const start = batches.shift();
      if (start === undefined) return;
      const input = inputs.slice(start, start + EMBED_BATCH);
      try {
        const response = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/embed`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: EMBED_MODEL, input, dimensions: 1024, truncate: true }), signal: ended,
        });
        if (!response.ok) throw new Error(`Ollama embed: ${response.status} ${(await response.text()).slice(0, 200)}`);
        const { embeddings } = Embeddings.parse(await response.json());
        if (embeddings.length !== input.length) throw new Error(`Ollama embed: ${embeddings.length} vectors for ${input.length} texts`);
        embeddings.forEach((vector, at) => { out[start + at] = unit(vector); });
      } catch (error) {
        if (!failure) { failure = { error }; stop.abort(); }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  if (failure) throw failure.error;
  return out;
}

function unit(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

export interface ItemInput {
  id: string;
  source: string;
  kind: string;
  ext_id?: string | null;
  thread?: string | null;
  thread_title?: string | null;
  title: string;
  at: Date;
  sender?: string | null;
  sender_name?: string | null;
  recipients?: string[];
  from_me?: boolean;
  url?: string | null;
  body: string;
  meta?: Record<string, unknown>;
  origin: "context" | "event" | "note" | "skill";
  event_id?: number | null;
  /** People on the item by id; handles below resolve to more. */
  people?: { id: string; role: string }[];
  /** Handles (addresses, phones) of who sent and received it, folded; each known person becomes a role. */
  handles?: { handle: string; role: string }[];
  /** A line of context per chunk, by `${part}:${sha256(text)}`. */
  contexts?: Map<string, string>;
  /** Write even when the hash matches: contexts and meta are not in it (enrichment rewrites an item whose text did not change). */
  force?: true;
}

/** The embedding input of a chunk: its context line first, then heading, date and people, then its text. */
function embedInput(context: string, heading: string, at: Date, people: string, text: string): string {
  const head = [context, heading.slice(0, 256), `Date: ${at.toISOString().slice(0, 10)}`, people === "" ? "" : `People: ${people.split(", ").slice(0, 8).join(", ").slice(0, 512)}`].filter(Boolean);
  return `${head.join("\n")}\n${text}`.slice(0, EMBED_CHARS);
}

/**
 * Write `items`: an unchanged one (same hash) is skipped; a changed one gets its people and chunks rewritten, keeping the
 * vectors of chunks whose embedding input did not change. An imported item never replaces an event's copy of the same
 * (source, ext_id). Answers how many items were written.
 */
export async function writeItems(pool: Pool, items: readonly ItemInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const { rows: existing } = await pool.query<{ id: string; source: string; ext_id: string | null; hash: string; origin: string }>(
    "SELECT id, source, ext_id, hash, origin FROM memory.items WHERE id = ANY($1) OR (source, ext_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))",
    [items.map(item => item.id), items.map(item => item.source), items.map(item => item.ext_id ?? "")],
  );
  const byId = new Map(existing.map(row => [row.id, row]));
  const byExt = new Map(existing.filter(row => row.ext_id !== null).map(row => [`${row.source}\u0000${row.ext_id}`, row]));
  const changed: (ItemInput & { hash: string })[] = [];
  for (const raw of items) {
    const item = { ...raw, title: cleanText(raw.title), body: cleanText(raw.body) };
    const hash = sha256(JSON.stringify([item.title, item.at.toISOString(), item.body, item.people ?? [], item.handles ?? [], item.thread_title ?? null]));
    const have = byId.get(item.id) ?? (item.ext_id ? byExt.get(`${item.source}\u0000${item.ext_id}`) : undefined);
    if ((have?.hash === hash && !item.force) || (have?.origin === "event" && item.origin === "context")) continue;
    changed.push({ ...item, id: have?.id ?? item.id, hash });
  }
  if (changed.length === 0) return 0;
  const ids = changed.map(item => item.id);

  // people: given ids, plus whoever the handles name
  const handles = [...new Set(changed.flatMap(item => (item.handles ?? []).map(each => each.handle)))];
  const { rows: owners } = handles.length === 0 ? { rows: [] } : await pool.query<{ id: string; handle: string }>(
    "SELECT p.id, h.handle FROM memory.people p CROSS JOIN LATERAL jsonb_array_elements_text(p.handles) AS h(handle) WHERE h.handle = ANY($1) AND (p.kind <> 'person' OR h.handle !~ '^\\+?[0-9]{1,6}$')", [handles]);
  const ownerOf = new Map(owners.map(row => [row.handle, row.id]));
  const roles = changed.map(item => {
    const all = [...(item.people ?? []), ...(item.handles ?? []).flatMap(each => ownerOf.has(each.handle) ? [{ id: ownerOf.get(each.handle)!, role: each.role }] : [])];
    return [...new Map(all.map(each => [`${each.id}\u0000${each.role}`, each])).values()];
  });
  const personIds = [...new Set(roles.flat().map(each => each.id))];
  const { rows: named } = personIds.length === 0 ? { rows: [] } : await pool.query<{ id: string; name: string; aliases: string[]; kind: string }>("SELECT id, name, aliases, kind FROM memory.people WHERE id = ANY($1)", [personIds]);
  const person = new Map(named.map(row => [row.id, row]));

  // chunks, reusing vectors by embedding input
  const { rows: kept } = await pool.query<{ embed_hash: string; embedding: string }>("SELECT embed_hash, embedding::text FROM memory.chunks WHERE item_id = ANY($1)", [ids]);
  const vectors = new Map(kept.map(row => [row.embed_hash, row.embedding]));
  const chunks = changed.flatMap((item, index) => {
    // the people column: names and aliases from the roles (the owner left out; a big group's recipients say little), then the raw sender
    const many = roles[index]!.filter(each => each.role === "recipient").length > 8;
    const names = roles[index]!.filter(each => person.get(each.id)?.kind !== "self" && !(many && each.role === "recipient")).flatMap(each => person.has(each.id) ? [person.get(each.id)!.name, ...person.get(each.id)!.aliases] : []);
    const people = [...new Set([...names, ...[item.sender_name, item.sender].filter((each): each is string => !!each)])].join(", ");
    const title = item.title || item.thread_title || "";
    return chunkBody(item.body).map(chunk => {
      const heading = chunk.section === "" || chunk.section === title ? title : `${title} — ${chunk.section}`;
      const context = item.contexts?.get(`${chunk.part}:${sha256(chunk.text)}`) ?? "";
      const input = embedInput(context, heading, item.at, people, chunk.text);
      return { item_id: item.id, ...chunk, heading, people, context, input, embed_hash: sha256(input) };
    });
  });
  const missing = [...new Set(chunks.filter(chunk => !vectors.has(chunk.embed_hash)).map(chunk => chunk.embed_hash))];
  const inputs = new Map(chunks.map(chunk => [chunk.embed_hash, chunk.input]));
  const fresh = await embed(missing.map(hash => inputs.get(hash)!));
  for (const [index, hash] of missing.entries()) vectors.set(hash, `[${fresh[index]!.join(",")}]`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // another writer (the event indexer beside a load) may have taken a (source, ext_id) while this batch embedded
    const { rows: holders } = await client.query<{ id: string; source: string; ext_id: string; origin: string }>(
      "SELECT id, source, ext_id, origin FROM memory.items WHERE (source, ext_id) IN (SELECT * FROM unnest($1::text[], $2::text[])) FOR UPDATE",
      [changed.map(item => item.source), changed.map(item => item.ext_id ?? "")],
    );
    const holder = new Map(holders.map(row => [`${row.source}\u0000${row.ext_id}`, row]));
    const target = new Map(changed.map(item => {
      const held = item.ext_id ? holder.get(`${item.source}\u0000${item.ext_id}`) : undefined;
      return [item.id, held === undefined || held.id === item.id ? item.id : held.origin === "event" && item.origin === "context" ? null : held.id];
    }));
    const writes = changed.flatMap((item, index) => target.get(item.id) ? [{ item: { ...item, id: target.get(item.id)! }, roles: roles[index]! }] : []);
    const finalIds = writes.map(each => each.item.id);
    await client.query(
      `INSERT INTO memory.items (id, source, kind, ext_id, thread, thread_title, title, at, sender, sender_name, recipients, from_me, url, body, meta, hash, origin, event_id)
       SELECT * FROM jsonb_to_recordset($1) AS x(id text, source text, kind text, ext_id text, thread text, thread_title text, title text, at timestamptz, sender text, sender_name text, recipients jsonb, from_me boolean, url text, body text, meta jsonb, hash text, origin text, event_id bigint)
       ON CONFLICT (id) DO UPDATE SET source = excluded.source, kind = excluded.kind, ext_id = excluded.ext_id, thread = excluded.thread, thread_title = excluded.thread_title, title = excluded.title, at = excluded.at,
         sender = excluded.sender, sender_name = excluded.sender_name, recipients = excluded.recipients, from_me = excluded.from_me, url = excluded.url, body = excluded.body, meta = excluded.meta,
         hash = excluded.hash, origin = excluded.origin, event_id = excluded.event_id, updated_at = now()`,
      [JSON.stringify(writes.map(({ item }) => ({ id: item.id, source: item.source, kind: item.kind, ext_id: item.ext_id ?? null, thread: item.thread ?? null, thread_title: item.thread_title ?? null, title: item.title, at: item.at.toISOString(), sender: item.sender ?? null, sender_name: item.sender_name ?? null, recipients: item.recipients ?? [], from_me: item.from_me ?? false, url: item.url ?? null, body: item.body, meta: item.meta ?? {}, hash: item.hash, origin: item.origin, event_id: item.event_id ?? null })))],
    );
    await client.query("DELETE FROM memory.item_people WHERE item_id = ANY($1)", [finalIds]);
    const links = writes.flatMap(({ item, roles: on }) => on.filter(each => person.has(each.id)).map(each => ({ item_id: item.id, person_id: each.id, role: each.role })));
    if (links.length > 0) await client.query("INSERT INTO memory.item_people SELECT * FROM jsonb_to_recordset($1) AS x(item_id text, person_id text, role text) ON CONFLICT DO NOTHING", [JSON.stringify(links)]);
    await client.query("DELETE FROM memory.chunks WHERE item_id = ANY($1)", [finalIds]);
    const rows = chunks.flatMap(chunk => target.get(chunk.item_id) ? [{ ...chunk, item_id: target.get(chunk.item_id)! }] : []);
    await client.query(
      `INSERT INTO memory.chunks (item_id, part, start_at, end_at, heading, people, context, text, embed_hash, embedding)
       SELECT item_id, part, start_at, end_at, heading, people, context, text, embed_hash, embedding::halfvec FROM unnest($1::text[], $2::int[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
         AS x(item_id, part, start_at, end_at, heading, people, context, text, embed_hash, embedding)`,
      [rows.map(c => c.item_id), rows.map(c => c.part), rows.map(c => c.start), rows.map(c => c.end), rows.map(c => c.heading), rows.map(c => c.people), rows.map(c => c.context), rows.map(c => c.text), rows.map(c => c.embed_hash), rows.map(c => vectors.get(c.embed_hash)!)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return changed.length;
}

/** Rebuild existing items affected by text cleaning; verbatim connector events remain untouched. */
export async function reindexText(pool: Pool): Promise<number> {
  let after = "";
  let written = 0;
  for (;;) {
    const { rows } = await pool.query<ItemInput>(
      `SELECT i.*, coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.person_id, 'role', p.role)) FROM memory.item_people p WHERE p.item_id = i.id), '[]') AS people
       FROM memory.items i WHERE i.id > $1 AND i.source IN ('gmail', 'imessage') ORDER BY i.id LIMIT 100`, [after]);
    if (!rows.length) return written;
    after = rows.at(-1)!.id;
    const changed = rows.filter(row => cleanText(row.body) !== row.body || cleanText(row.title) !== row.title);
    if (changed.length) written += await writeItems(pool, changed.map(row => ({ ...row, at: new Date(row.at) })));
  }
}
