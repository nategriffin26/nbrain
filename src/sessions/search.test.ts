import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import pg from "pg";
import { freshDatabase } from "../testdb.js";
import { fetchSession, listSessions, searchSessions, SessionPageError, sessionPages } from "./search.js";
import { clipToolResult, ingestSessions, resolveSessionRoots, storeSession } from "./store.js";
import type { SessionPart, SessionTranscript } from "./types.js";

const part = (entry: string, text: string, extra: Partial<SessionPart> = {}): SessionPart => ({ entry, ordinal: 0, at: "2026-01-03T12:00:00Z", role: "user", kind: "prompt", tool: null, scope: "work", text, ...extra });
const transcript = (id: string, parts: SessionPart[], extra: Partial<SessionTranscript> = {}): SessionTranscript => ({ id, harness: "omp", originalPath: `/synthetic/${id}.jsonl`, parentId: null, cwd: "/synthetic/project", project: "project", title: id, started: "2026-01-01T00:00:00Z", ended: "2026-01-04T00:00:00Z", scope: "work", scratch: false, parts, ...extra });

it("keeps every multibyte prompt byte across 8 KB fetch pages", () => {
  const text = "界".repeat(8000);
  const pages = sessionPages([part("entry", text)]);
  expect(pages.every(page => Buffer.byteLength(page.text) <= 8192)).toBe(true);
  expect(pages.map(page => page.text).join("")).toContain(text);
  expect(pages.every(page => page.entries.includes("entry"))).toBe(true);
});
it("clips tool output to 2 KB without losing its final diagnostic", () => {
  const result = clipToolResult("界".repeat(3000) + "FINAL_DIAGNOSTIC");
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2048);
  expect(result).toMatch(/FINAL_DIAGNOSTIC$/);
  expect(result).not.toContain("\ufffd");
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("session projection and retrieval", () => {
  let pool: pg.Pool;
  let archive: string;
  const work = { life: false }, life = { life: true };
  beforeAll(async () => {
    ({ pool } = await freshDatabase("session_recall"));
    archive = await mkdtemp(join(tmpdir(), "nbrain-session-test-"));
    const save = (s: SessionTranscript) => storeSession(pool, { transcript: s, archivePath: join(archive, `${s.id}.jsonl.zst`), sourceFingerprint: "fixture", sourceBytes: 0 });
    await save(transcript("root", [part("owner", "quartz deployment"), part("life", "orchid appointment", { ordinal: 1, kind: "tool_result", role: "toolResult", scope: "life" })]));
    await save(transcript("child", [part("tool", "quartz boundary regression exact-identifier-247", { kind: "tool_result", role: "toolResult" })], { parentId: "root" }));
    await save(transcript("grandchild", [part("deep", "nested heliotrope discovery")], { parentId: "child" }));
    await save(transcript("later", [part("other", "quartz deployment", { at: "2026-01-04T12:00:00Z" })]));
    await save(transcript("chat", [part("chat-entry", "orchid appointment", { scope: "life" })], { harness: "dross", scope: "life" }));
    const synthetic = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;
    await save(transcript("secret", [part("secret-entry", `credential ${synthetic}`)]));
    await resolveSessionRoots(pool);
  }, 30_000);
  afterAll(async () => { await pool?.end(); if (archive) await rm(archive, { recursive: true, force: true }); });

  it("lists sessions by prompts inside the window even when they started earlier", async () => {
    const found = await listSessions(pool, { from: "2026-01-03T00:00:00Z", to: "2026-01-04T00:00:00Z", harness: "omp" }, work);
    expect(found.sessions.map(row => row.id)).toEqual(["session:root", "session:secret"]);
    expect(found.complete).toBe(true);
  });
  it("returns the matching subagent entry while ranking its root only once", async () => {
    const found = await searchSessions(pool, { query: "exact-identifier-247", exact: true }, work);
    expect(found.results[0]).toMatchObject({ id: "session:root", receipt: "session:child#tool", via: "session:child" });
  });
  it("never returns life results to a work token", async () => {
    expect((await searchSessions(pool, { query: "orchid" }, work)).results).toEqual([]);
    expect((await searchSessions(pool, { query: "orchid" }, life)).results.map(row => row.id).sort()).toEqual(["session:chat", "session:root"]);
    expect((await listSessions(pool, { harness: "dross" }, work)).sessions).toEqual([]);
  });
  it("redacts a planted key before it reaches the part table or exact results", async () => {
    const synthetic = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;
    expect((await pool.query("SELECT text FROM memory.session_parts WHERE session_id='secret'")).rows[0].text).toMatch(/\[REDACTED:/);
    expect((await searchSessions(pool, { query: synthetic, exact: true }, life)).results).toEqual([]);
  });
  it.each(["session:child", "thread:omp:root"])("hides private ancestors marked %s from list, search, fetch and reader SQL", async target => {
    await pool.query("INSERT INTO memory.private(target,by) VALUES($1,'test')", [target]);
    try {
      expect((await searchSessions(pool, { query: "heliotrope" }, life)).results).toEqual([]);
      await expect(fetchSession(pool, "session:child#tool", undefined, life)).rejects.toThrow("No session");
      expect((await listSessions(pool, { include_subagents: true }, life)).sessions.map(row => row.id)).not.toContain("session:grandchild");
      const client = await pool.connect();
      try {
        await client.query("BEGIN; SET LOCAL ROLE memory_reader");
        expect((await client.query("SELECT session_id FROM memory.session_parts WHERE session_id IN ('child','grandchild')")).rows).toEqual([]);
      } finally { await client.query("ROLLBACK"); client.release(); }
    } finally { await pool.query("DELETE FROM memory.private WHERE target=$1", [target]); }
  });
  it("fetches full answers at the exact entry from the archive after the source is gone", async () => {
    const raw = [
      { type: "session", id: "root", cwd: "/synthetic/project", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: "full", timestamp: "2026-01-03T12:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "A complete archived answer." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(archive, "root.jsonl.zst"), zstdCompressSync(Buffer.from(raw)));
    const found = await fetchSession(pool, "session:root", undefined, work);
    expect(found.text).toContain("A complete archived answer.");
    const pointer = found.entries[0]!;
    expect((await fetchSession(pool, pointer, undefined, work)).text).toContain("A complete archived answer.");
    await expect(fetchSession(pool, "session:root#absent", undefined, work)).rejects.toThrow("No entry");
    for (const page of [-1, 0.5, 1]) await expect(fetchSession(pool, "session:root", page, work)).rejects.toBeInstanceOf(SessionPageError);
  });
  it("opens a tool-result receipt beyond its first line so the matching evidence can be cited", async () => {
    const text = "Command completed\nEvidence: turquoise-boundary";
    const raw = [
      { type: "session", id: "receipt", timestamp: "2026-01-03T12:00:00Z" },
      { type: "message", id: "output", timestamp: "2026-01-03T12:00:00Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    const archivePath = join(archive, "receipt.jsonl.zst");
    await writeFile(archivePath, zstdCompressSync(Buffer.from(raw)));
    await storeSession(pool, { transcript: transcript("receipt", [part("output", text, { kind: "tool_result", role: "toolResult", tool: "bash" })]), archivePath, sourceFingerprint: "receipt", sourceBytes: Buffer.byteLength(raw) });
    const hit = (await searchSessions(pool, { query: "turquoise-boundary", exact: true }, work)).results[0]!;
    expect((await fetchSession(pool, hit.receipt, undefined, work)).text).toContain("Evidence: turquoise-boundary");
    expect((await fetchSession(pool, hit.id, undefined, work)).text).not.toContain("Evidence: turquoise-boundary");
  });

  it("continues past a rejected source, retries it later, and skips unchanged duplicate copies", async () => {
    const sourceRoot = join(archive, "sources"), archiveRoot = join(archive, "retained");
    for (const folder of ["one", "two"]) await mkdir(join(sourceRoot, folder), { recursive: true });
    const raw = (id: string) => JSON.stringify({ type: "session", id, timestamp: "2026-01-03T12:00:00Z" }) + "\n" +
      JSON.stringify({ type: "message", id: "entry", timestamp: "2026-01-03T12:00:00Z", message: { role: "user", attribution: "user", content: [{ type: "text", text: `material ${id}` }] } }) + "\n";
    for (const id of ["before-rejection", "rejected", "after-rejection"]) await writeFile(join(sourceRoot, "one", `${id}.jsonl`), raw(id));
    await writeFile(join(sourceRoot, "two", "before-rejection.jsonl"), raw("before-rejection"));
    await pool.query(`CREATE FUNCTION memory.reject_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='rejected' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_session BEFORE INSERT ON memory.sessions FOR EACH ROW EXECUTE FUNCTION memory.reject_session()`);
    try {
      await expect(ingestSessions(pool, { archiveRoot, ompRoot: sourceRoot })).rejects.toThrow("1 session sources failed; 2 projected");
      expect((await pool.query("SELECT id FROM memory.sessions WHERE id IN ('before-rejection','after-rejection') ORDER BY id")).rows).toEqual([{ id: "after-rejection" }, { id: "before-rejection" }]);
      expect((await pool.query("SELECT last_error FROM brain.cursors WHERE source='sessions'")).rows[0].last_error).toContain("1 session sources failed");
    } finally { await pool.query("DROP TRIGGER reject_session ON memory.sessions; DROP FUNCTION memory.reject_session()"); }
    expect(await ingestSessions(pool, { archiveRoot, ompRoot: sourceRoot })).toBe(1);
    expect(await ingestSessions(pool, { archiveRoot, ompRoot: sourceRoot })).toBe(0);
    expect((await pool.query("SELECT last_error FROM brain.cursors WHERE source='sessions'")).rows[0].last_error).toBeNull();
  });
});
