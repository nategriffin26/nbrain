import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import type pg from "pg";
import { freshDatabase } from "../testdb.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Uses the production HTTP entry point and real Postgres, never the owner's brain.
describe.runIf(!!process.env.TEST_DATABASE_URL)("stateless HTTP lifecycle", () => {
  let child: ChildProcess, home: string;
  let pool: pg.Pool;
  const url = new URL("http://127.0.0.1:8932/mcp");
  const token = randomBytes(32).toString("hex");
  const headers = { authorization: `Bearer ${token}` };
  const clients: Client[] = [];
  beforeAll(async () => {
    const database = await freshDatabase("transport");
    pool = database.pool;
    home = mkdtempSync(`${tmpdir()}/nbrain-transport-`);
    mkdirSync(`${home}/memory-mcp`);
    mkdirSync(`${home}/logs`);
    const archive = `${home}/session.jsonl.zst`;
    writeFileSync(archive, zstdCompressSync(Buffer.from([
      { type: "session", id: "fixture", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: "entry", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Archived fixture." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n")));
    await pool.query("INSERT INTO memory.items(id,source,kind,body,hash,at,origin) VALUES('saved:fixture','saved','note','Fixture body.','fixture',now(),'note')");
    await pool.query("INSERT INTO memory.sessions(id,root_id,harness,original_path,archive_path,source_fingerprint,source_bytes,scope,prompt_count,part_count) VALUES('fixture','fixture','omp','/fixture.jsonl',$1,'fixture',0,'work',0,1)", [archive]);
    writeFileSync(`${home}/memory-mcp/tokens.json`, JSON.stringify({ tokens: [{ agent: "transport-test", sha256: createHash("sha256").update(token).digest("hex"), scopes: ["work", "archive"] }] }));
    child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
      env: { ...process.env, BRAIN_HOME: home, BRAIN_LOGS: `${home}/logs`, BRAIN_CONTEXT: `${home}/context`, MEMORY_MCP_HOME: `${home}/memory-mcp`, MEMORY_MCP_PORT: "8932", MEMORY_RO_DATABASE_URL: database.url, MEMORY_WRITER_DATABASE_URL: "", PUBLIC_URL: "", OWNER_TAILSCALE_LOGIN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // Bound a real child-process startup, not simulated application time.
    const timer = setTimeout(() => reject(new Error("Test server did not bind port 8932")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Test server exited before listening")); });
    child.stdout!.on("data", chunk => {
      if (String(chunk).includes("listening at")) { clearTimeout(timer); resolve(); }
    });
    await promise;
  }, 30_000);
  afterAll(async () => {
    await Promise.all(clients.map(client => client.close()));
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      // Bound cleanup of the real process if its sockets do not drain.
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    await pool?.end();
    if (home) rmSync(home, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: "transport-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  }
  function lastLog() {
    return JSON.parse(readFileSync(`${home}/logs/memory-mcp.log`, "utf8").trim().split("\n").at(-1)!);
  }

  it.each([
    ["saved:fixture", "saved:fixture has 1 page (0-based)."],
    ["session:fixture", "Session has 1 pages. Use page 0 through 0."],
  ])("classifies an out-of-range page for %s as a caller error", async (id, message) => {
    const client = await connect();
    const result = await client.callTool({ name: "fetch", arguments: { id, page: 1 } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: message }] });
    expect(lastLog()).toMatchObject({ tool: "fetch", status: 400 });
    const normal = await client.callTool({ name: "fetch", arguments: { id, page: 0 } });
    expect(normal.isError).not.toBe(true);
    expect(normal.structuredContent).toMatchObject({ id, page: 0, pages: 1 });
    expect(lastLog()).toMatchObject({ tool: "fetch", status: "ok" });
  });

  it.each([
    ["fetch", { id: "saved:absent" }, "Nothing in memory has id saved:absent."],
    ["fetch", { id: "session:" }, "Expected session:<id>#<entry>."],
    ["fetch", { id: "session:absent" }, "No session is available at that pointer."],
    ["fetch", { id: "saved:fixture#999" }, "No chunk saved:fixture#999 is available."],
    ["skill_get", { name: "nbrain/write-skill", page: 999 }, "out of range"],
    ["changes", { since: "invalid-date" }, "Not a since date"],
    ["sql", { sql: "SELECT FROM" }, "syntax error"],
    ["sql", { sql: "SELECT nonexistent_column FROM items" }, "does not exist"],
    ["sql", { sql: "   " }, "Give a read-only SQL query."],
    ["search", { query: "x", from: "2026-10-22-00-00" }, "Not a date"],
    ["sql", { sql: "SELECT 1/0" }, "division by zero"],
    ["fetch", { id: "card:absent" }, "No card transport-test may open has id card:absent."],
  ])("returns corrective messages for %s %j", async (name, args, message) => {
    const client = await connect();
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(message) }]);
    expect(lastLog()).toMatchObject({ tool: name, status: 400 });
  });

  it("keeps missing server archives as internal failures", async () => {
    await pool.query("INSERT INTO memory.sessions(id,root_id,harness,original_path,archive_path,source_fingerprint,source_bytes,scope,prompt_count,part_count) VALUES('broken','broken','omp','/broken.jsonl',$1,'fixture',0,'work',0,1)", [`${home}/missing.jsonl.zst`]);
    const client = await connect();
    const result = await client.callTool({ name: "fetch", arguments: { id: "session:broken" } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Memory call failed; see memory-mcp.log on the server." }] });
    expect(lastLog()).toMatchObject({ tool: "fetch", status: "error" });
  });

  it("rejects unsupported GET instead of advertising an already-dead SSE stream", async () => {
    const response = await fetch(url, { headers: { ...headers, accept: "text/event-stream" } });
    await response.body?.cancel();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await fetch(url)).status).toBe(401);
  });

  it("keeps concurrent POST responses isolated when a client reinitializes with reader calls in flight", async () => {
    const old = await connect();
    const calls = Array.from({ length: 4 }, () => old.callTool({ name: "sql", arguments: { sql: "SELECT pg_sleep(0.1)" } }));
    const fresh = await connect();
    calls.push(...Array.from({ length: 12 }, (_, i) => (i % 2 ? old : fresh).callTool({ name: "fetch", arguments: { id: "now" } })));
    const results = await Promise.all(calls);
    expect(results).toHaveLength(16);
    expect(results.every(result => !result.isError)).toBe(true);
    for (const result of results.slice(4)) expect(result.structuredContent).toMatchObject({ id: "now", metadata: { blocks: [] } });
  });
});
