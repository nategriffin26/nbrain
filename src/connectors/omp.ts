// omp sessions: the owner's own words in top-level omp sessions, each with the answer that closed the turn, as work.turn
// events. Subagent sessions (inside a session's directory) and scratch sessions (--private-tmp*) are other agents talking
// to each other, not the owner, so they are never read.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Pool } from "pg";
import { OWNER } from "../config.js";
import { cursorOk, insertEvent, readCursor } from "../events/store.js";
import { guarded } from "./common.js";

const SOURCE = "omp";
const ROOT = process.env.OMP_SESSIONS ?? join(homedir(), ".omp", "agent", "sessions");
/** A session still being written can be touched a little after the scan that read it: files this close to the last scan are read again. */
const OVERLAP_MS = 10 * 60_000;
const MESSAGE_CHARS = 8_000;
const ANSWER_CHARS = 4_000;
const TITLE_CHARS = 80;

export interface Turn { session: string; entry: string; at: string; cwd: string; project: string; title: string; message: string; answer: string }

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: { type?: string; text?: string }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n") : "";
/** Titles carry a leading icon glyph (private-use characters). */
const cleanTitle = (title: string) => title.replace(/\p{Co}/gu, "").trim();

/** The owner's turns in one session file: each typed message with the last assistant text before the next one. */
export function turnsOfSession(text: string): Turn[] {
  let session = "";
  let cwd = "";
  let title = "";
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry: { type?: string; id?: string; title?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: unknown; attribution?: string } };
    try { entry = JSON.parse(line); } catch { continue; } // a session being written ends in a partial line
    if (entry.type === "session") { session = entry.id ?? ""; cwd = entry.cwd ?? ""; }
    else if ((entry.type === "title" || entry.type === "title_change") && entry.title) title = cleanTitle(entry.title);
    else if (entry.type === "message" && entry.message) {
      const { role, content, attribution } = entry.message;
      const body = textOf(content).trim();
      if (role === "user" && attribution === "user" && body !== "" && entry.id && entry.timestamp) {
        turns.push({ session, entry: entry.id, at: entry.timestamp, cwd, project: basename(cwd), title: "", message: body, answer: "" });
      } else if (role === "assistant" && body !== "" && turns.length > 0) turns.at(-1)!.answer = body;
    }
  }
  return turns.map(turn => ({ ...turn, title }));
}

/** Top-level session files: <root>/<cwd slug>/<ISO>_<id>.jsonl, with their modification times. */
export async function sessionFiles(root: string): Promise<{ file: string; mtime: number }[]> {
  const files: { file: string; mtime: number }[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith("--private-tmp")) continue;
    for (const entry of await readdir(join(root, dir.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = join(root, dir.name, entry.name);
      files.push({ file, mtime: (await stat(file)).mtimeMs });
    }
  }
  return files;
}

/** Read the sessions written since the last scan (all of them the first time); answers files read and events written or changed. */
export async function pollOmp(pool: Pool, root = ROOT): Promise<{ files: number; written: number }> {
  const result = { files: 0, written: 0 };
  await guarded(pool, SOURCE, async () => {
    const started = Date.now();
    const last = await readCursor(pool, SOURCE);
    const since = last === null ? 0 : Date.parse(last) - OVERLAP_MS;
    for (const { file, mtime } of await sessionFiles(root)) {
      if (mtime < since) continue;
      result.files++;
      for (const turn of turnsOfSession(await readFile(file, "utf8"))) {
        const firstLine = turn.message.split("\n", 1)[0]!.trim();
        const answer = turn.answer.slice(0, ANSWER_CHARS);
        const outcome = await insertEvent(pool, {
          kind: "work.turn", source: SOURCE, external_id: `${turn.session}:${turn.entry}`, at: turn.at,
          title: (turn.title || firstLine).slice(0, TITLE_CHARS),
          body: `${OWNER.name}: ${turn.message.slice(0, MESSAGE_CHARS)}${answer ? `\n\nAgent: ${answer}` : ""}`,
          data: { session: turn.session, cwd: turn.cwd, project: turn.project, file: basename(file) },
        }, "update");
        if (outcome !== "same") result.written++;
      }
    }
    await cursorOk(pool, SOURCE, new Date(started).toISOString());
  });
  return result;
}

export async function ompCommand(args: string[]): Promise<void> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (args[0] !== undefined && args[0] !== "poll") throw new Error("usage: omp [poll]  (reads new omp sessions into the brain)");
    const started = Date.now();
    const { files, written } = await pollOmp(pool);
    console.log(`omp: ${files} files read, ${written} events written, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}
