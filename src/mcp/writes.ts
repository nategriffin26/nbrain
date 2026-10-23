// The writes an agent makes through memory-mcp, as memory_writer (INSERT on items/chunks/corrections, select/insert/delete
// on private, nothing else; what a write needs to read, it reads through the reader): remember leaves a note, correct
// passes on what is wrong, private keeps something out. Each is signed with the token's signer, never a name the caller gives.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { MCP_TOOLS } from "./contract.js";
import { type Agent, type Call, ScopeError, sourcesFor, type Tool } from "./types.js";
import { embed } from "../memory/store.js";
import { chunkBody, sha256 } from "../memory/text.js";

const clean = (text: unknown) => String(text ?? "").replaceAll("\u0000", "").trim();
const writerOf = (call: Call): Pool => { if (!call.writer) throw new Error("writes are off: MEMORY_WRITER_DATABASE_URL is not set"); return call.writer; };

/** One note as a new item (source note, kind note); never touches an existing row. */
async function remember(call: Call, args: Record<string, unknown>) {
  const writer = writerOf(call);
  const signer = call.agent.signer;
  const text = clean(args.text), about = clean(args.about);
  const at = new Date();
  const id = `${signer.toLowerCase().replace(/[^a-z0-9]+/g, "")}:${at.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const title = about || `${signer} note`;
  const hash = sha256(JSON.stringify([title, at.toISOString(), text, [], [], null]));
  const chunks = chunkBody(text).map(chunk => {
    const input = `${title.slice(0, 256)}\nDate: ${at.toISOString().slice(0, 10)}\n${chunk.text}`.slice(0, 2000);
    return { ...chunk, input, embed_hash: sha256(input) };
  });
  const vectors = await embed(chunks.map(chunk => chunk.input));
  const client = await writer.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('memory-mcp.remember'))");
    // under the lock, so a twin call waits and then sees this note committed
    const { rows: same } = await call.reader.query("SELECT id FROM memory.items WHERE source = 'note' AND sender = $2 AND body = $1 LIMIT 1", [text, signer]);
    if (same.length > 0) { await client.query("ROLLBACK"); return { kept: false, why: `A ${signer} note already says exactly this.`, id: same[0].id }; }
    await client.query(
      `INSERT INTO memory.items (id, source, kind, ext_id, title, at, sender, sender_name, body, meta, hash, origin) VALUES ($1, 'note', 'note', $1, $2, $3, $4, $4, $5, $6, $7, 'note')`,
      [id, title, at, signer, text, JSON.stringify({ by: signer, via: "memory-mcp", ...(about ? { about } : {}) }), hash]);
    for (const [index, chunk] of chunks.entries()) await client.query(
      `INSERT INTO memory.chunks (item_id, part, start_at, end_at, heading, people, context, text, embed_hash, embedding) VALUES ($1, $2, $3, $4, $5, '', '', $6, $7, $8::halfvec)`,
      [id, chunk.part, chunk.start, chunk.end, chunk.section ? `${title} — ${chunk.section}` : title, chunk.text, chunk.embed_hash, `[${vectors[index]!.join(",")}]`]);
    await client.query("COMMIT");
    return { kept: true, id, by: signer, ...(about ? { about } : {}), at: at.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A correction for the curator; nextval first, since memory_writer may not read the row back. */
async function correct(call: Call, args: Record<string, unknown>) {
  const writer = writerOf(call);
  const target = clean(args.id);
  const { rows } = await writer.query<{ id: string }>("SELECT nextval('memory.corrections_id_seq') AS id");
  const id = rows[0]!.id;
  await writer.query("INSERT INTO memory.corrections (id, target, text, by) VALUES ($1, $2, $3, $4)", [id, target || null, clean(args.text), call.agent.signer]);
  return {
    kept: true, id: `correction:${id}`,
    next: "The curator applies it within a minute: the wrong profile line is closed and the right one added, a record is retracted or a card rewritten. The next brief carries it, and only a later correction changes it.",
  };
}

/** What `private` stores for an item: the item, or its whole thread as thread:<source>:<thread>. An item this token may not
 *  open is refused exactly like one that does not exist, so a refusal says nothing about what is there. */
export function privateTarget(agent: Agent, id: string, item: { source: string; thread: string | null } | undefined, thread: boolean): string {
  const allowed = sourcesFor(agent);
  if (!item || (allowed && !allowed.includes(item.source))) throw new ScopeError(`Nothing ${agent.name} may open has id ${id}.`);
  if (!thread) return id;
  if (!item.thread) throw new ScopeError(`${id} is not in a thread; mark the item itself (leave thread out).`);
  return `thread:${item.source}:${item.thread}`;
}

async function markPrivate(call: Call, args: Record<string, unknown>) {
  const writer = writerOf(call);
  const id = clean(args.id).replace(/#\d+$/, "");
  const { rows: [item] } = await call.reader.query<{ source: string; thread: string | null }>("SELECT source, thread FROM memory.items WHERE id = $1", [id]);
  const target = privateTarget(call.agent, id, item, args.thread === true);
  if (args.private === false) {
    const { rowCount } = await writer.query("DELETE FROM memory.private WHERE target = $1", [target]);
    return { target, private: false, changed: rowCount !== 0 };
  }
  const { rowCount } = await writer.query("INSERT INTO memory.private (target, why, by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [target, clean(args.why) || null, call.agent.signer]);
  return { target, private: true, changed: rowCount !== 0, next: "Left out of search, briefs, the profile and the library from now on; search with private: true finds it." };
}

export const WRITE_TOOLS: Record<string, Tool> = {
  remember: { ...MCP_TOOLS.remember, scopes: ["write"], write: true, run: remember },
  correct: { ...MCP_TOOLS.correct, scopes: ["write"], write: true, run: correct },
  private: { ...MCP_TOOLS.private, scopes: ["write"], write: true, run: markPrivate },
};
