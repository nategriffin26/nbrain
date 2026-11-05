import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { SessionHarness, SessionPartKind, SessionScope, SessionTranscript } from "./types.js";

export interface SessionSourceError {
  harness: SessionHarness;
  originalPath: string;
  name: "SourceDiscoveryError" | "SourceReadError" | "SourceParseError" | "ArchiveWriteError";
}

export interface SessionSourceOptions {
  ompRoot?: string;
  claudeRoot?: string;
  codexRoot?: string;
  opencodePath?: string;
  opencodeStorageRoot?: string;
  drossPool?: Pool;
  onError?: (error: SessionSourceError) => void;
}

export interface SessionSource {
  harness: SessionHarness;
  originalPath: string;
  sourceFingerprint: string;
  scratch: boolean;
  sessionId?: string;
  sourcePaths?: readonly string[];
  versions?(): Iterable<SessionSource>;
  read(): Promise<{ raw: Buffer; sourceFingerprint: string }>;
}

const sessionRecordTypes: Record<"omp" | "codex", Readonly<Record<string, boolean>>> = {
  omp: { session: true, message: true, title: true, title_change: true, model_change: true, thinking_level_change: true, custom_message: true, custom: true, compaction: true, branch_summary: true },
  codex: { session_meta: true, response_item: true, event_msg: true, turn_context: true },
};

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function isBinaryBlock(value: unknown): boolean {
  const part = row(value);
  return /^(?:(?:input|output)_)?(?:image|audio|blob)(?:_|$)/.test(String(part.type))
    || /^(?:image|audio)\//.test(String(part.mimeType ?? part.mime_type))
    || part.encoding === "base64";
}
const json = (value: unknown): string => typeof value === "string" ? value
  : JSON.stringify(value ?? null, (_key, part: unknown) => isBinaryBlock(part) ? undefined : part) ?? "";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const numeric = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value));
  const number = numeric ? Number(value) : 0;
  const source = String(value);
  const date = new Date(numeric ? number > 1e12 ? number : number * 1000
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(source) ? `${source}Z` : source);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value).map(row).filter(p => ["text", "input_text", "output_text"].includes(String(p.type ?? p.kind)))
    .map(p => typeof p.text === "string" ? p.text : "").join("\n");
}

function records(raw: Buffer): Row[] {
  const result: Row[] = [];
  // Active writers can leave an incomplete final record. The archive still retains those bytes.
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { result.push(row(JSON.parse(line))); } catch { /* A malformed record has no parsed projection. */ }
  }
  return result;
}

function parseData(value: unknown): Row {
  if (typeof value !== "string") return row(value);
  try { return row(JSON.parse(value)); } catch { return {}; }
}

function parentFromPath(path: string): string {
  return basename(path).replace(/\.jsonl$/, "").replace(/^.*_/, "");
}

function isScratch(harness: SessionHarness, path: string): boolean {
  return (harness === "omp" || harness === "claude") && path.split(/[\\/]/).some(p => p.includes("private-tmp"));
}

/** Nested Executor/eval envelopes retain the strongest provenance of any enclosed call. */
export function toolScope(name: string | null, input: unknown): SessionScope {
  const provenance = `${name ?? ""} ${json(input)}`;
  if (/(?:^|[^a-z])(?:gmail|apple[-_ .]messages|imessage|apple[-_ .]calendar|google[-_ .]calendar)(?:[^a-z]|$)/i.test(provenance)
    || /tools[.\["'\s]+(?:messages|calendar)(?:[^a-z]|$)/i.test(provenance)
    || /(?:nbrain|dross[-_]memory)[._:/-]+(?:brief|search|fetch|changes|person|sql|records|library)(?:[^a-z]|$)/i.test(provenance)
    || /(?:^|[._:/-])memory[._:/-]+(?:brief|search|fetch|changes|person|sql|records|library)(?:[^a-z]|$)/i.test(name ?? "")
    || /\btools\.memory\.(?:brief|search|fetch|changes|person|sql|records|library)\b/i.test(provenance)
    || /(?:nbrain|dross[-_]memory)[\s\S]*["']?scope["']?\s*:\s*["']life["']/i.test(provenance)) return "life";
  return "work";
}

/** Full parsed text; callers must redact before exposing any part or metadata. */
export function parseSession(raw: Buffer, harness: SessionHarness, originalPath: string): SessionTranscript | null {
  const rows = records(raw);
  const result: SessionTranscript = {
    id: "", harness, originalPath, parentId: null, cwd: null, project: null, title: null,
    started: null, ended: null, scope: harness === "dross" ? "life" : "work",
    scratch: isScratch(harness, originalPath), parts: [],
  };
  const calls = new Map<string, { name: string | null; scope: SessionScope }>();
  const persistentLife = new Set<string>();
  const usedEntries = new Set<string>();
  function add(entry: string, at: unknown, role: string, kind: SessionPartKind, body: string, tool: string | null = null, scope: SessionScope = result.scope): void {
    if (!body.trim()) return;
    let unique = entry;
    let suffix = 1;
    while (usedEntries.has(unique)) unique = `${entry}:${suffix++}`;
    usedEntries.add(unique);
    result.parts.push({ entry: unique, ordinal: result.parts.length, at: iso(at), role, kind, tool, scope, text: body });
  }
  function call(entry: string, at: unknown, id: unknown, name: unknown, input: unknown): void {
    const tool = string(name);
    let scope = result.scope === "life" ? "life" : toolScope(tool, input);
    // Eval and execute can return values retained by earlier cells.
    const persistent = tool && /(?:^|[._])eval$/.test(tool) ? "eval"
      : tool && /(?:^|[._])(?:execute|resume)$/.test(tool) ? "executor" : null;
    if (persistent && persistentLife.has(persistent)) scope = "life";
    if (persistent && scope === "life") persistentLife.add(persistent);
    if (string(id)) calls.set(String(id), { name: tool, scope });
    add(entry, at, "assistant", "tool_call", `${tool ?? "tool"} ${json(input)}`, tool, scope);
  }
  function output(entry: string, at: unknown, id: unknown, name: unknown, value: unknown): void {
    const source = calls.get(String(id));
    const tool = string(name) ?? source?.name ?? null;
    const scope = result.scope === "life" || source?.scope === "life" || toolScope(tool, value) === "life" ? "life" : "work";
    const visible = Array.isArray(value) ? value.filter(v => !isBinaryBlock(v)
      && !["thinking", "reasoning", "redacted_thinking"].includes(String(row(v).type))) : null;
    const body = typeof value === "string" ? value : visible ? visible.length ? text(visible) || json(visible) : "" : json(value);
    add(entry, at, "toolResult", "tool_result", body, tool, scope);
  }
  function time(at: unknown): void {
    const value = iso(at);
    if (value) { result.started ??= value; result.ended = value; }
  }

  switch (harness) {
    case "omp": {
      const header = rows.find(r => r.type === "session");
      if (!header || !string(header.id)) return null;
      result.id = String(header.id);
      result.cwd = string(header.cwd);
      result.started = iso(header.timestamp);
      const explicitParent = string(header.parentSession);
      // Older nested workers omit parentSession. Their dated ancestor identifies the root.
      const ancestor = dirname(originalPath).split(/[\\/]/).reverse().find(part => /^\d{4}-\d{2}-\d{2}.*_/.test(part));
      result.parentId = ancestor ? parentFromPath(explicitParent ?? ancestor) : null;
      for (const [index, r] of rows.entries()) {
        if ((r.type === "title" || r.type === "title_change") && string(r.title)) result.title = String(r.title).replace(/[\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/gu, "").trim();
        if (r.type !== "message") continue;
        const m = row(r.message), role = String(m.role ?? ""), at = r.timestamp ?? m.timestamp;
        const entry = string(r.id) ?? `line:${index}`;
        time(at);
        if (role === "user") {
          add(entry, at, role, m.attribution === "user" && !ancestor && !result.scratch ? "prompt" : "brief", text(m.content));
        } else if (role === "assistant") {
          if (typeof m.content === "string") add(entry, at, role, "answer", m.content);
          for (const [partIndex, p] of array(m.content).map(row).entries()) {
            const key = `${entry}:${partIndex}`;
            if (p.type === "text") add(key, at, role, "answer", text(p.text));
            if (p.type === "toolCall") call(key, at, p.id, p.name, p.arguments);
          }
        } else if (role === "toolResult") output(entry, at, m.toolCallId, m.toolName, m.content);
      }
      break;
    }
    case "claude": {
      result.id = `cc:${basename(originalPath, ".jsonl")}`;
      const segments = originalPath.split(/[\\/]/), sub = segments.indexOf("subagents");
      if (sub > 0) result.parentId = `cc:${segments[sub - 1]}`;
      for (const [index, r] of rows.entries()) {
        if (r.type === "summary") result.title = string(r.summary);
        if (r.type !== "user" && r.type !== "assistant") continue;
        result.cwd ??= string(r.cwd);
        if (r.isSidechain && !result.parentId && string(r.sessionId) && result.id !== `cc:${r.sessionId}`) result.parentId = `cc:${r.sessionId}`;
        const m = row(r.message), entry = string(r.uuid) ?? `line:${index}`, at = r.timestamp;
        time(at);
        const body = text(m.content);
        const parts = array(m.content).map(row);
        if (r.type === "user") {
          if (body) add(entry, at, "user", result.parentId || r.isSidechain || r.isMeta || body.startsWith("<") ? "brief" : "prompt", body);
          for (const [i, p] of parts.entries()) if (p.type === "tool_result") output(`${entry}:${i}`, at, p.tool_use_id, null, p.content);
        } else {
          if (typeof m.content === "string") add(entry, at, "assistant", "answer", m.content);
          for (const [i, p] of parts.entries()) {
            if (p.type === "text") add(`${entry}:${i}`, at, "assistant", "answer", text(p.text));
            if (p.type === "tool_use") call(`${entry}:${i}`, at, p.id, p.name, p.input);
          }
        }
      }
      break;
    }
    case "codex": {
      const header = row(rows.find(r => r.type === "session_meta")?.payload);
      if (!string(header.id)) return null;
      result.id = `cx:${header.id}`;
      result.cwd = string(header.cwd);
      result.started = iso(header.timestamp);
      const subagent = row(row(header.source ?? header.thread_source).subagent);
      const parent = string(row(subagent.thread_spawn).parent_thread_id) ?? string(header.parent_thread_id);
      if (parent) result.parentId = `cx:${parent}`;
      for (const [index, r] of rows.entries()) {
        if (r.type !== "response_item") continue;
        const p = row(r.payload), at = r.timestamp;
        const entry = string(p.id) ?? `line:${index}`;
        time(at);
        if (p.type === "message") {
          const body = text(p.content);
          if (p.role === "user") add(entry, at, "user", result.parentId || body.startsWith("<") ? "brief" : "prompt", body);
          if (p.role === "assistant" && p.channel !== "analysis" && p.channel !== "analysis_summary") add(entry, at, "assistant", "answer", body);
        } else if (["function_call", "custom_tool_call", "local_shell_call"].includes(String(p.type))) {
          call(entry, at, p.call_id ?? p.id, p.name ?? (p.type === "local_shell_call" ? "local_shell" : null), p.arguments ?? p.input ?? p.action);
        } else if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(String(p.type))) output(entry, at, p.call_id, null, p.output);
      }
      break;
    }
    case "opencode": {
      const header = row(rows.find(r => r.type === "session")?.row);
      if (!string(header.id)) return null;
      result.id = `oc:${header.id}`;
      const parent = string(header.parent_id ?? header.parentID);
      result.parentId = parent ? `oc:${parent}` : null;
      result.cwd = string(header.directory);
      result.title = string(header.title);
      result.started = iso(header.time_created ?? row(header.time).created);
      result.ended = iso(header.time_updated ?? row(header.time).updated);
      const messages = new Map(rows.filter(r => r.type === "message").map(r => { const m = row(r.row); return [String(m.id), m] as const; }));
      for (const r of rows) {
        if (r.type !== "part") continue;
        const stored = row(r.row), p = parseData(stored.data ?? stored);
        const messageId = stored.message_id ?? stored.messageID;
        const m = messages.get(String(messageId));
        const md = parseData(m?.data ?? m), role = String(md.role ?? ""), at = row(md.time).created ?? m?.time_created;
        const entry = `${messageId}:${stored.id}`;
        if (p.type === "text") {
          add(entry, at, role, role === "user" ? result.parentId || p.synthetic ? "brief" : "prompt" : "answer", text(p.text));
        } else if (p.type === "tool") {
          const state = row(p.state), id = p.callID ?? stored.id;
          call(`${entry}:call`, at, id, p.tool, state.input);
          if (state.output != null) output(`${entry}:result`, row(state.time).end ?? at, id, p.tool, state.output);
          else if (state.error != null) output(`${entry}:result`, row(state.time).end ?? at, id, p.tool, state.error);
        }
      }
      break;
    }
    case "dross": {
      const header = row(rows.find(r => r.type === "thread")?.row);
      if (!string(header.id)) return null;
      result.id = `dr:${header.id}`;
      result.project = string(header.botId);
      result.started = iso(header.createdAt);
      for (const r of rows) {
        if (r.type !== "message") continue;
        const m = row(r.row), entry = String(m.id), at = m.createdAt, role = String(m.role);
        time(at);
        const blocks = array(m.blocks).map(row);
        const body = blocks.filter(b => !["thinking", "reasoning", "redacted_thinking"].includes(String(b.kind ?? b.type)))
          .map(b => text(b.text)).filter(Boolean).join("\n");
        const handoff = blocks.some(b => b.kind === "bot_message_received");
        add(entry, at, role, role === "user" ? body.startsWith("Run routine") || handoff ? "brief" : "prompt"
          : role === "bot" ? "answer" : "brief", body);
        for (const [i, b] of blocks.entries()) {
          const key = `${entry}:${i}`;
          const kind = b.kind ?? b.type;
          if (["thinking", "reasoning", "redacted_thinking"].includes(String(kind))) continue;
          if (kind === "steps") {
            for (const [j, c] of array(b.calls).map(row).entries()) {
              call(`${key}:call:${j}`, at, `${key}:${j}`, c.tool, c.input ?? c.arguments ?? c.summary);
              if (c.note != null || c.output != null || c.result != null) output(`${key}:result:${j}`, at, `${key}:${j}`, c.tool, c.output ?? c.result ?? c.note);
            }
          } else if (kind === "subagent") {
            if (b.task != null) add(`${key}:task`, at, role, "brief", json(b.task));
            if (b.result != null) output(`${key}:result`, at, null, b.name, b.result);
          } else if (kind === "tool_call" || kind === "tool_use") call(key, at, b.id, b.name ?? b.tool, b.input ?? b.arguments);
          else if (kind === "tool_result") output(key, at, b.tool_use_id ?? b.call_id, b.name ?? b.tool, b.content ?? b.output);
          if (kind === "ask" && b.answer != null) add(`${key}:answer`, at, "user", "brief", json(b.answer));
        }
      }
      break;
    }
  }
  if (result.parentId === result.id) result.parentId = null;
  result.project ??= result.cwd ? basename(result.cwd) : null;
  return result;
}

function missing(error: unknown): boolean { return row(error).code === "ENOENT"; }

async function* files(root: string, extension = ".jsonl", onError?: (path: string) => void): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (missing(error)) return;
    if (onError) { onError(root); return; }
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, extension, onError);
    else if (entry.isFile() && entry.name.endsWith(extension)) yield path;
  }
}

async function fileFingerprint(path: string): Promise<string> {
  const s = await stat(path, { bigint: true });
  return `file:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

function exportRows(type: string, rows: Row[]): string {
  return rows.map(r => JSON.stringify({ type, row: r }) + "\n").join("");
}

async function fileSessionId(path: string, harness: "omp" | "claude" | "codex"): Promise<string | null> {
  if (harness === "claude") return `cc:${basename(path, ".jsonl")}`;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const sessionTypes = sessionRecordTypes[harness];
  let sessionRecords = false;
  let malformed = false;
  try {
    for await (const line of lines) {
      let record: Row;
      if (!line.trim()) continue;
      try { record = row(JSON.parse(line)); } catch { malformed = true; continue; }
      if (sessionTypes[String(record.type)] === true) sessionRecords = true;
      if (harness === "omp" && record.type === "session" && string(record.id)) return String(record.id);
      const payload = row(record.payload);
      if (harness === "codex" && record.type === "session_meta" && string(payload.id)) return `cx:${payload.id}`;
    }
  } finally { lines.close(); stream.destroy(); }
  if (sessionRecords || malformed) throw new SyntaxError("Session source has no identity header");
  return null;
}

/** Includes scratch groups for counts. Consume read() before advancing; SQLite owns one reader per traversal. */
export async function* discoverSessionSources(options: SessionSourceOptions): AsyncGenerator<SessionSource> {
  const harnesses: Array<{ harness: SessionHarness; originalPath: string | undefined; options: SessionSourceOptions }> = [
    { harness: "omp", originalPath: options.ompRoot, options: { ompRoot: options.ompRoot } },
    { harness: "claude", originalPath: options.claudeRoot, options: { claudeRoot: options.claudeRoot } },
    { harness: "codex", originalPath: options.codexRoot, options: { codexRoot: options.codexRoot } },
    { harness: "opencode", originalPath: options.opencodePath ?? options.opencodeStorageRoot, options: { opencodePath: options.opencodePath, opencodeStorageRoot: options.opencodeStorageRoot } },
    { harness: "dross", originalPath: options.drossPool ? "rakazo:threads" : undefined, options: { drossPool: options.drossPool } },
  ];
  for (const source of harnesses) {
    if (!source.originalPath) continue;
    try { yield* discoverHarnessSources({ ...source.options, onError: options.onError }); }
    catch { options.onError?.({ harness: source.harness, originalPath: source.originalPath, name: "SourceDiscoveryError" }); }
  }
}

async function* discoverHarnessSources(options: SessionSourceOptions): AsyncGenerator<SessionSource> {
  for (const [harness, root] of [["omp", options.ompRoot], ["claude", options.claudeRoot], ["codex", options.codexRoot]] as const) {
    if (!root) continue;
    const groups = new Map<string, Array<{ source: SessionSource; mtime: bigint; size: bigint }>>();
    const report = (path: string): void => options.onError?.({ harness, originalPath: path, name: "SourceDiscoveryError" });
    for await (const path of files(root, ".jsonl", report)) {
      try {
        const metadata = await stat(path, { bigint: true });
        const sessionId = await fileSessionId(path, harness);
        if (sessionId === null) continue;
        const scratch = isScratch(harness, relative(root, path));
        const sourceFingerprint = `file:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
        const source: SessionSource = {
          harness, originalPath: path, sourceFingerprint, scratch, sessionId,
          async read() { return { raw: await readFile(path), sourceFingerprint }; },
        };
        const key = JSON.stringify([scratch, sessionId]);
        const group = groups.get(key);
        const member = { source, mtime: metadata.mtimeNs, size: metadata.size };
        if (group) group.push(member);
        else groups.set(key, [member]);
      } catch (error) {
        options.onError?.({ harness, originalPath: path, name: error instanceof SyntaxError ? "SourceParseError" : "SourceDiscoveryError" });
      }
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.mtime !== b.mtime ? a.mtime > b.mtime ? -1 : 1
        : a.size !== b.size ? a.size > b.size ? -1 : 1
        : a.source.originalPath < b.source.originalPath ? -1 : a.source.originalPath > b.source.originalPath ? 1 : 0);
      const canonical = group[0]!.source;
      const members = group.map(member => member.source);
      const sourcePaths = members.map(member => member.originalPath).sort();
      const sourceFingerprint = `group:${digest(JSON.stringify(members.map(member => [member.originalPath, member.sourceFingerprint]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)))}`;
      yield {
        ...canonical, sourcePaths, sourceFingerprint,
        async read() { return { raw: (await canonical.read()).raw, sourceFingerprint }; },
        *versions() { for (let i = 1; i < members.length; i++) yield members[i]!; },
      };
    }
  }
  const opencodeIds = new Set<string>();
  if (options.opencodePath) {
    const path = options.opencodePath;
    let exists = true;
    try { await stat(path); } catch (error) { if (missing(error)) exists = false; else throw error; }
    if (exists) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const sessions = db.prepare("SELECT id FROM session ORDER BY id").all();
        const sessionQuery = db.prepare("SELECT * FROM session WHERE id = ?");
        const messageQuery = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id");
        const partQuery = db.prepare("SELECT p.* FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? ORDER BY m.time_created, m.id, p.id");
        db.function("session_row_digest", { deterministic: true }, value => createHash("sha256").update(String(value)).digest("hex"));
        const revision = db.prepare(`SELECT
          (SELECT group_concat(session_row_digest(id || char(0) || time_created || char(0) || time_updated || char(0) || data), '')
            FROM (SELECT * FROM message WHERE session_id = ? ORDER BY id)) AS messages,
          (SELECT group_concat(session_row_digest(id || char(0) || message_id || char(0) || time_created || char(0) || time_updated || char(0) || data), '')
            FROM (SELECT * FROM part WHERE session_id = ? ORDER BY id)) AS parts`);
        const fingerprint = (id: string): string => `sqlite:${digest(JSON.stringify([sessionQuery.get(id), revision.get(id, id)]))}`;
        for (const session of sessions) {
          const id = String(session.id);
          opencodeIds.add(id);
          let sourceFingerprint: string;
          try { sourceFingerprint = fingerprint(id); }
          catch {
            options.onError?.({ harness: "opencode", originalPath: `${path}#${id}`, name: "SourceDiscoveryError" });
            continue;
          }
          yield {
            harness: "opencode", originalPath: `${path}#${id}`, sourceFingerprint, scratch: false,
            async read() {
              db.exec("BEGIN");
              try {
                const sourceFingerprint = fingerprint(id);
                const header = sessionQuery.get(id);
                if (!header) throw new Error("Session source was removed during discovery");
                const raw = Buffer.from(exportRows("session", [header]) + exportRows("message", messageQuery.all(id)) + exportRows("part", partQuery.all(id)));
                db.exec("COMMIT");
                return { raw, sourceFingerprint };
              } catch (error) { db.exec("ROLLBACK"); throw error; }
            },
          };
        }
      } finally { db.close(); }
    }
  }
  if (options.opencodeStorageRoot) {
    const root = options.opencodeStorageRoot;
    for await (const sessionPath of files(join(root, "session"), ".json")) {
      const id = basename(sessionPath, ".json");
      if (opencodeIds.has(id)) continue;
      try {
        const sourceFiles = [{ type: "session", path: sessionPath }];
        for await (const messagePath of files(join(root, "message", id), ".json")) {
          sourceFiles.push({ type: "message", path: messagePath });
          for await (const partPath of files(join(root, "part", basename(messagePath, ".json")), ".json")) {
            sourceFiles.push({ type: "part", path: partPath });
          }
        }
        const hash = createHash("sha256");
        for (const source of sourceFiles) hash.update(JSON.stringify([relative(root, source.path), await fileFingerprint(source.path)]));
        const sourceFingerprint = `legacy:${hash.digest("hex")}`;
        yield {
          harness: "opencode", originalPath: sessionPath, sourceFingerprint, scratch: false,
          async read() {
            const exported: string[] = [];
            for (const source of sourceFiles) {
              const bytes = await readFile(source.path, "utf8");
              let value: unknown;
              try { value = JSON.parse(bytes); } catch { throw new Error("Legacy session contains malformed JSON"); }
              exported.push(JSON.stringify({ type: source.type, row: value }) + "\n");
            }
            return { raw: Buffer.from(exported.join("")), sourceFingerprint };
          },
        };
      } catch { options.onError?.({ harness: "opencode", originalPath: sessionPath, name: "SourceDiscoveryError" }); }
    }
  }
  if (options.drossPool) {
    const pool = options.drossPool;
    const detected = await pool.query<{ present: boolean }>("SELECT to_regclass('public.messages') IS NOT NULL AND to_regclass('public.threads') IS NOT NULL AS present");
    if (!detected.rows[0]?.present) return;
    const ids = await pool.query<{ id: string }>("SELECT id FROM public.threads ORDER BY id");
    // Hash on the server: unchanged histories never cross the connection.
    const revisionSql = `SELECT md5(row_to_json(t)::text || coalesce((SELECT string_agg(md5(row_to_json(m)::text), '' ORDER BY m.seq, m.id)
      FROM public.messages m WHERE m."threadId" = t.id), '')) AS fingerprint FROM public.threads t WHERE t.id = $1`;
    for (const { id } of ids.rows) {
      let revision;
      try { revision = await pool.query<{ fingerprint: string }>(revisionSql, [id]); }
      catch {
        options.onError?.({ harness: "dross", originalPath: `rakazo:threads/${id}`, name: "SourceDiscoveryError" });
        continue;
      }
      if (!revision.rows[0]) continue;
      yield {
        harness: "dross", originalPath: `rakazo:threads/${id}`, sourceFingerprint: `postgres:${revision.rows[0].fingerprint}`, scratch: false,
        async read() {
          const client = await pool.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const fingerprint = await client.query<{ fingerprint: string }>(revisionSql, [id]);
            const thread = await client.query<{ row: Row }>("SELECT row_to_json(t) AS row FROM public.threads t WHERE id = $1", [id]);
            if (!thread.rows[0] || !fingerprint.rows[0]) throw new Error("Session source was removed during discovery");
            const messages = await client.query<{ row: Row }>('SELECT row_to_json(m) AS row FROM public.messages m WHERE "threadId" = $1 ORDER BY seq, id', [id]);
            const raw = Buffer.from(exportRows("thread", thread.rows.map(r => r.row)) + exportRows("message", messages.rows.map(r => r.row)));
            await client.query("COMMIT");
            return { raw, sourceFingerprint: `postgres:${fingerprint.rows[0].fingerprint}` };
          } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        },
      };
    }
  }
}
