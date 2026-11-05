import type { Pool } from "pg";
import { quoteOf } from "../memory/text.js";
import { containsTerm } from "../memory/search.js";
import { readArchivedSession } from "./archive.js";
import { redactTexts } from "./redact.js";
import type { SessionHarness, SessionPart } from "./types.js";
import { clipToolResult } from "./store.js";

export interface SessionAccess { life: boolean }
export interface SessionWindow {
  from?: string; to?: string; project?: string; directory?: string; harness?: SessionHarness; include_subagents?: boolean;
}
export interface SessionSearchInput extends SessionWindow {
  query: string; limit?: number; exact?: boolean;
  /** Evaluation excludes the asking session and sessions begun after the question. */
  startedBefore?: string; exclude?: string;
}

export class SessionPageError extends Error {
  constructor(readonly pages: number) {
    super(`Session has ${pages} pages. Use page 0 through ${pages - 1}.`);
    this.name = "SessionPageError";
  }
}

const STOP = new Set(`a an and are as at be been but by can could did do does doing done for from had has have how i if in into is it its just let lets me my of on or our so that the their them then there these this those to up was we were what when where which who why will with would you your yeah ok okay also like really want need get go make sure think know see find look remember recall session sessions earlier last time while ago before again back please can't dont don't im i'm about any all some one thing things something way it's that's we've i've you've`.split(/\s+/));
export function sessionTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_]*/g) ?? []).filter(term => term.length >= 2 && !STOP.has(term)))];
}

class Parameters {
  values: unknown[] = [];
  add(value: unknown): string { this.values.push(value); return `$${this.values.length}`; }
}
function dateBound(value: string, end: boolean): Date {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(day ? `${value}T00:00:00` : value);
  if (!Number.isFinite(date.getTime())) throw new Error("Session window requires a valid date or ISO timestamp.");
  if (day && end) date.setDate(date.getDate() + 1);
  return date;
}
export function sessionVisible(alias: string): string {
  return `memory.session_visible(${alias}.id,${alias}.root_id,${alias}.ancestor_ids,${alias}.harness)`;
}
function sessionFilters(sql: Parameters, input: SessionWindow, access: SessionAccess, alias = "s"): string[] {
  const where = [`NOT ${alias}.scratch`, sessionVisible(alias)];
  if (!access.life) where.push(`${alias}.scope='work'`);
  if (input.project) where.push(`${alias}.project=${sql.add(input.project)}`);
  if (input.directory) where.push(`${alias}.cwd=${sql.add(input.directory)}`);
  if (input.harness) where.push(`${alias}.harness=${sql.add(input.harness)}`);
  return where;
}

/** Complete, unranked listing. Window membership means a prompt in that window, not a session's start date. */
export async function listSessions(pool: Pool, input: SessionWindow, access: SessionAccess) {
  const sql = new Parameters();
  const where = sessionFilters(sql, input, access);
  if (!input.include_subagents) where.push("s.parent_id IS NULL");
  const prompts = ["p.session_id=s.id", ...(access.life ? [] : ["p.scope='work'"])];
  if (!input.include_subagents) prompts.push("p.kind='prompt'");
  if (input.from) prompts.push(`p.at>=${sql.add(dateBound(input.from, false))}`);
  if (input.to) prompts.push(`p.at<${sql.add(dateBound(input.to, true))}`);
  if (input.from || input.to) where.push(`EXISTS (SELECT 1 FROM memory.session_parts p WHERE ${prompts.join(" AND ")})`);
  const { rows } = await pool.query(`SELECT 'session:' || s.id AS id,s.harness,s.project,s.title,s.cwd AS directory,
    s.parent_id,s.started,s.ended,s.prompt_count,s.part_count,
    (SELECT min(p.at) FROM memory.session_parts p WHERE p.session_id=s.id AND p.kind='prompt' ${access.life ? "" : "AND p.scope='work'"}) AS first_prompt,
    (SELECT max(p.at) FROM memory.session_parts p WHERE p.session_id=s.id AND p.kind='prompt' ${access.life ? "" : "AND p.scope='work'"}) AS last_prompt,
    (SELECT left(split_part(p.text,E'\\n',1),200) FROM memory.session_parts p WHERE p.session_id=s.id AND p.kind='prompt' ${access.life ? "" : "AND p.scope='work'"} ORDER BY p.ordinal LIMIT 1) AS first_prompt_line
    FROM memory.sessions s WHERE ${where.join(" AND ")} ORDER BY s.started NULLS LAST,s.id`, sql.values);
  return { sessions: rows, count: rows.length, complete: true };
}

/** BM25's best part represents a root session, with the actual matching subagent entry as its receipt. */
export async function searchSessions(pool: Pool, input: SessionSearchInput, access: SessionAccess) {
  const started = performance.now();
  const terms = sessionTerms(input.query);
  if (!input.query.trim() || (!input.exact && !terms.length)) return { results: [], ms: performance.now() - started };
  const sql = new Parameters();
  const q = sql.add(input.exact ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : terms.join(" "));
  const where = [...sessionFilters(sql, input, access, "r"), sessionVisible("s")];
  const partWhere: string[] = [];
  if (!access.life) { partWhere.push("p.scope='work'"); where.push("s.scope='work'"); }
  if (input.from) partWhere.push(`p.at>=${sql.add(dateBound(input.from, false))}`);
  if (input.to) partWhere.push(`p.at<${sql.add(dateBound(input.to, true))}`);
  if (input.startedBefore) where.push(`r.started<${sql.add(input.startedBefore)}`);
  if (input.exclude) where.push(`r.id<>${sql.add(input.exclude.replace(/^session:/, ""))}`);
  const score = input.exact ? "0::real" : "pdb.score(p.id)";
  const match = input.exact ? `p.text ILIKE ${q}` : `p.text ||| ${q}::text`;
  const { rows } = await pool.query<{ root_id: string; session_id: string; entry: string; at: Date | null; kind: string; text: string; score: number; harness: string; project: string | null; title: string | null }>(
    `WITH eligible AS MATERIALIZED (
       SELECT s.id,s.root_id,r.harness,r.project,r.title FROM memory.sessions s JOIN memory.sessions r ON r.id=s.root_id WHERE ${where.join(" AND ")}
     ), ranked AS MATERIALIZED (
       SELECT p.id,p.session_id,p.entry,p.at,p.kind,p.text,${score} AS score FROM memory.session_parts p
       WHERE ${match} ${partWhere.length ? `AND ${partWhere.join(" AND ")}` : ""}
         AND p.session_id = ANY(ARRAY(SELECT id FROM eligible))
       ORDER BY ${input.exact ? "p.at DESC NULLS LAST,p.id" : "score DESC,p.id"} LIMIT 2000
     )
     SELECT e.root_id,p.session_id,p.entry,p.at,p.kind,p.text,p.score,e.harness,e.project,e.title
     FROM ranked p JOIN eligible e ON e.id=p.session_id
     ORDER BY ${input.exact ? "p.at DESC NULLS LAST,p.id" : "p.score DESC,p.id"}`, sql.values);
  if (!input.exact) {
    // A project's own sessions receive a modest prior when the query names it explicitly.
    const namedProjects = new Map<string, boolean>();
    for (const row of rows) {
      if (!row.project) continue;
      let named = namedProjects.get(row.project);
      if (named === undefined) { named = containsTerm(input.query, row.project); namedProjects.set(row.project, named); }
      if (named) row.score *= 1.2;
    }
    rows.sort((a, b) => b.score - a.score);
  }
  const seen = new Set<string>();
  const limit = Math.max(1, Math.min(30, Math.trunc(input.limit ?? 10)));
  const results = [];
  for (const row of rows) {
    if (seen.has(row.root_id)) continue;
    seen.add(row.root_id);
    results.push({ id: `session:${row.root_id}`, receipt: `session:${row.session_id}#${row.entry}`,
      via: row.session_id === row.root_id ? null : `session:${row.session_id}`, entry: row.entry,
      at: row.at, kind: row.kind, harness: row.harness, project: row.project, title: row.title,
      snippet: quoteOf(row.text, terms, 200), matched: terms.filter(term => row.text.toLowerCase().includes(term)) });
    if (results.length === limit) break;
  }
  return { results, ms: performance.now() - started };
}

const PAGE_BYTES = 8192;
/** Pages split by UTF-8 bytes, preserving full prompt/answer text and exact entry anchors. */
export function sessionPages(parts: readonly SessionPart[], expandedEntry?: string): { text: string; entries: string[] }[] {
  const pages: { text: string; entries: string[] }[] = [];
  let text = "", entries: string[] = [];
  for (const part of parts) {
    const body = part.kind === "tool_call" ? part.text.replace(/\s+/g, " ") : part.kind === "tool_result"
      ? part.entry === expandedEntry ? clipToolResult(part.text) : part.text.split(/\r?\n/, 1)[0]! : part.text;
    let line = `[${part.entry} · ${part.at ?? "undated"} · ${part.kind}${part.tool ? ` · ${part.tool}` : ""}]\n${body}\n\n`;
    while (line) {
      const room = PAGE_BYTES - Buffer.byteLength(text);
      const bytes = Buffer.from(line);
      let cut = Math.min(room, bytes.length);
      if (cut < bytes.length) while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
      if (cut === 0) { pages.push({ text, entries }); text = ""; entries = []; continue; }
      const chunk = bytes.subarray(0, cut).toString("utf8");
      text += chunk;
      if (!entries.includes(part.entry)) entries.push(part.entry);
      line = bytes.subarray(cut).toString("utf8");
      if (Buffer.byteLength(text) >= PAGE_BYTES || line) { pages.push({ text, entries }); text = ""; entries = []; }
    }
  }
  if (text || !pages.length) pages.push({ text, entries });
  return pages;
}

export async function fetchSession(pool: Pool, pointer: string, page: number | undefined, access: SessionAccess) {
  const match = /^session:([^#]+)(?:#(.+))?$/.exec(pointer);
  if (!match) throw new Error("Expected session:<id>#<entry>.");
  const id = match[1]!, entry = match[2];
  const { rows: [session] } = await pool.query(`SELECT s.* FROM memory.sessions s WHERE s.id=$1 AND ${sessionVisible("s")} ${access.life ? "" : "AND s.scope='work'"}`, [id]);
  if (!session) throw new Error("No session is available at that pointer.");
  const transcript = await readArchivedSession(session.archive_path, session.harness, session.original_path);
  const parts = transcript.parts.filter(part => access.life || part.scope === "work");
  if (entry && !parts.some(part => part.entry === entry)) throw new Error("No entry is available at that pointer.");
  // Redact before pagination: a secret split at a page boundary must not escape detection.
  const redacted = await redactTexts(parts.map(part => part.text));
  const pages = sessionPages(parts.map((part, index) => ({ ...part, text: redacted[index]! })), entry);
  const at = page ?? (entry ? pages.findIndex(each => each.entries.includes(entry)) : 0);
  if (!Number.isInteger(at) || at < 0 || at >= pages.length) throw new SessionPageError(pages.length);
  return { id: `session:${id}`, title: session.title ?? session.project ?? session.harness, text: pages[at]!.text,
    page: at, pages: pages.length, entries: pages[at]!.entries.map(each => `session:${id}#${each}`),
    metadata: { harness: session.harness, project: session.project, started: session.started, ended: session.ended, parent: session.parent_id ? `session:${session.parent_id}` : null } };
}
