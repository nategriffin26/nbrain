// Run against an isolated server: NBRAIN_URL, NBRAIN_TOKEN, MEMORY_RO_DATABASE_URL.
// Reports timings only, never memory content or credentials.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";

const url = new URL(process.env.NBRAIN_URL ?? "http://127.0.0.1:8932/mcp");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, "8932", "Only the isolated transport test port is allowed");
const token = process.env.NBRAIN_TOKEN;
assert(token, "NBRAIN_TOKEN is required");
const headers = { authorization: `Bearer ${token}` };
const monitor = new pg.Pool({ connectionString: process.env.MEMORY_RO_DATABASE_URL, max: 1, application_name: "transport-monitor" });
const clients: Client[] = [];
let gets = 0;
async function connect() {
  const client = new Client({ name: "transport-probe", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: async (input, init) => {
    if (init?.method === "GET") gets++;
    return fetch(input, init);
  } });
  await client.connect(transport);
  clients.push(client);
  assert.equal(transport.sessionId, undefined, "The server is stateless; client lifecycles are not server sessions");
  return client;
}
const timing: Record<string, number[]> = {};
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
  assert(!result.isError, `${name} returned a tool error (see isolated server log)`);
  (timing[name] ??= []).push(Math.round(performance.now() - start));
  return result;
}
async function batch(label: string, connected: Client[], count = 16) {
  const start = performance.now();
  await Promise.all(Array.from({ length: count }, (_, i) => {
    const client = connected[i % connected.length]!;
    switch (i % 4) {
      case 0: return call(client, "search", { query: "software project architecture", limit: 2 });
      case 1: return call(client, "fetch", { id: itemId });
      case 2: return call(client, "brief", { task: "software project architecture" });
      default: return call(client, "person", { name: "zztransportfixturezz" });
    }
  }));
  console.log(`${label}: ${count}/${count} calls completed in ${Math.round(performance.now() - start)} ms`);
}
let itemId: string;
try {
  const { rows } = await monitor.query("SELECT id FROM memory.items WHERE source = 'x' LIMIT 1");
  assert(rows[0], "Probe needs one readable item");
  itemId = rows[0].id;
  const a = await connect();
  const response = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal: AbortSignal.timeout(2000) });
  const stream = response.status === 200 ? await response.body!.getReader().read() : undefined;
  console.log(`standalone GET: HTTP ${response.status}${stream ? `, first read done=${stream.done}` : ""}`);
  await batch("one client", [a]);
  const b = await connect(), c = await connect();
  await batch("three clients", [a, b, c], 24);
  const sleeping = Array.from({ length: 4 }, () => call(a, "sql", { sql: "SELECT pg_sleep(2)" }));
  const deadline = Date.now() + 5000;
  let active = 0;
  while (Date.now() < deadline && active < 4) {
    const result = await monitor.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'nbrain-transport-probe' AND state = 'active' AND wait_event = 'PgSleep'");
    active = result.rows[0].n;
    if (active < 4) await delay(20);
  }
  assert.equal(active, 4, "All four reader connections must actually be saturated");
  console.log("reader saturation: 4/4 connections observed in PgSleep");
  const inFlight = batch("old clients during re-init and saturation", [a, b], 16);
  const reconnected = await connect();
  await Promise.all([...sleeping, inFlight, batch("new client during saturation", [reconnected], 16)]);
  const abandoned = a.callTool({ name: "sql", arguments: { sql: "SELECT pg_sleep(1)" } }, undefined, { timeout: 5000 }).then(() => "completed", () => "disconnected");
  await delay(100);
  await a.close();
  const afterClose = await connect();
  await batch("after disconnect with a call in flight", [afterClose, b], 16);
  console.log(`abandoned call: ${await abandoned}`);
  await delay(1200);
  console.log(`automatic GET attempts: ${gets}`);
  for (const [name, values] of Object.entries(timing)) console.log(`${name}: n=${values.length}, max=${Math.max(...values)} ms`);
} finally {
  await Promise.all(clients.map(client => client.close()));
  await monitor.end();
}
