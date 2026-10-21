// `save`: keep a page, PDF, video, post, note or file in the brain as a `capture` event (memory.items source `saved` within
// a minute, via memory/events.ts), with a snapshot of what was fetched beside it. Enrichment (enrich.ts) follows.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import * as z from "zod";
import { BRAIN_HOME, OWNER } from "../config.js";
import { MCP_TOOLS } from "../mcp/contract.js";
import { type Call, ScopeError, type Tool } from "../mcp/types.js";
import { savedId } from "./id.js";
import { type Captured, readFileAt, readText, readUrl } from "./read.js";

/** Pages are gone within years; a snapshot over this is not kept (the text still is). */
const SNAPSHOT_MAX = 25 * 1024 * 1024;

export interface SaveInput { url?: string; text?: string; title?: string; why?: string; file?: string }
/** Who saves and through which pools: the MCP call's, or the CLI's (one pool, signed as the owner). */
export interface Saver { reader: Pool; writer: Pool; signer: string; via: string; local: boolean }

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export async function save(who: Saver, input: SaveInput) {
  const given = [input.url, input.text, input.file].filter(each => each !== undefined && each !== "").length;
  if (given !== 1) throw new Error("Give exactly one of url, text or file.");
  if (input.file !== undefined && !who.local) throw new ScopeError("file reads a path on this machine; only a local caller may use it. Send the text instead.");
  const why = input.why?.replace(/\s+/g, " ").trim().slice(0, 500) ?? "";
  const read: Captured = input.url ? await readUrl(input.url) : input.file ? await readFileAt(input.file, input.title) : readText(input.text!, input.title);
  if (read.body.trim() === "") throw new Error("Nothing readable was found to keep.");
  const title = (input.url && input.title?.trim()) || read.title;
  const id = savedId(read.external_id);
  const now = new Date();

  let snapshot: string | undefined;
  if (read.snapshot !== undefined && read.snapshot.bytes.length <= SNAPSHOT_MAX) {
    snapshot = join("captures", String(now.getUTCFullYear()), `${id.slice("saved:".length)}.${read.snapshot.ext}`);
    await mkdir(dirname(join(BRAIN_HOME, snapshot)), { recursive: true });
    // an earlier snapshot of the same thing stays
    await writeFile(join(BRAIN_HOME, snapshot), read.snapshot.bytes, { flag: "wx" }).catch(error => { if ((error as { code?: string }).code !== "EEXIST") throw error; });
  }
  const data = { why, by: who.signer, via: who.via, form: read.form, reader: read.reader, ...(read.site ? { site: read.site } : {}), ...(read.author ? { author: read.author } : {}), ...(read.published ? { published: read.published } : {}), ...(snapshot ? { snapshot } : {}), ...(read.original_url ? { original_url: read.original_url } : {}) };
  const body = read.body.replace(/\0/g, "");
  // memory_writer may only INSERT: no RETURNING, and a conflict target would need SELECT; the row count says whether it was new
  const { rowCount } = await who.writer.query(
    `INSERT INTO brain.events (kind, source, external_id, at, title, body, url, data, route, routed_at) VALUES ('capture', 'capture', $1, $2, $3, $4, $5, $6::jsonb, 'memory', $2) ON CONFLICT DO NOTHING`,
    [read.external_id, now.toISOString(), title.replaceAll("\u0000", ""), body, read.url, JSON.stringify(data)]);
  if (rowCount === 0) {
    const { rows } = await who.reader.query<{ at: Date; title: string }>("SELECT at, title FROM memory.items WHERE id = $1", [id]);
    return { already: true, id, title: rows[0]?.title ?? title, saved_at: rows[0]?.at.toISOString() ?? null, note: rows[0] === undefined ? "Already saved; still being indexed." : "Already saved." };
  }
  return { id, title, words: words(body), preview: body.replace(/\s+/g, " ").slice(0, 300), already: false, note: "Searchable within about a minute; summarized and tagged within a few more." };
}

export const captureTools: Record<string, Tool> = {
  save: {
    description: MCP_TOOLS.save.description,
    input: MCP_TOOLS.save.input as z.ZodObject<z.ZodRawShape>,
    scopes: ["write"], write: true,
    run: (call: Call, args) => save({ reader: call.reader, writer: call.writer!, signer: call.agent.signer, via: call.agent.name, local: call.local }, args as SaveInput),
  },
};

/** `capture save <url | -> [--why …] [--title …]`: from the shell, signed as the owner; `-` reads the text from stdin. */
export async function captureCommand(args: string[]): Promise<void> {
  const [verb, target, ...rest] = args;
  const flag = (name: string) => { const at = rest.indexOf(`--${name}`); return at < 0 ? undefined : rest[at + 1]; };
  if (verb !== "save" || !target) throw new Error('usage: capture save <url | -> [--why "…"] [--title "…"]   (- reads the text from stdin)');
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const text = target === "-" ? await new Response(process.stdin as unknown as ReadableStream).text() : undefined;
    const answer = await save({ reader: pool, writer: pool, signer: OWNER.name, via: "cli", local: true }, { ...(text === undefined ? { url: target } : { text }), ...(flag("title") ? { title: flag("title") } : {}), ...(flag("why") ? { why: flag("why") } : {}) });
    console.log(JSON.stringify(answer, null, 2));
  } finally { await pool.end(); }
}
