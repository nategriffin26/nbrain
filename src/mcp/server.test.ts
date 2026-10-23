import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Uses the production HTTP entry point and real Postgres, never the owner's brain.
describe.runIf(!!process.env.TEST_DATABASE_URL)("stateless HTTP lifecycle", () => {
  let child: ChildProcess, home: string;
  const url = new URL("http://127.0.0.1:8932/mcp");
  const token = randomBytes(32).toString("hex");
  const headers = { authorization: `Bearer ${token}` };
  const clients: Client[] = [];
  beforeAll(async () => {
    const database = process.env.TEST_DATABASE_URL!;
    if (!new URL(database).pathname.startsWith("/nbrain_t_")) throw new Error("Use a throwaway nbrain_t_ database.");
    home = mkdtempSync(`${tmpdir()}/nbrain-transport-`);
    mkdirSync(`${home}/memory-mcp`);
    writeFileSync(`${home}/memory-mcp/tokens.json`, JSON.stringify({ tokens: [{ agent: "transport-test", sha256: createHash("sha256").update(token).digest("hex"), scopes: ["work", "archive"] }] }));
    child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
      env: { ...process.env, BRAIN_HOME: home, MEMORY_MCP_HOME: `${home}/memory-mcp`, MEMORY_MCP_PORT: "8932", MEMORY_RO_DATABASE_URL: database, MEMORY_WRITER_DATABASE_URL: "", PUBLIC_URL: "", OWNER_TAILSCALE_LOGIN: "" },
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
  });
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
    if (home) rmSync(home, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: "transport-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  }

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
