// Reads through Executor's MCP (code mode). One program per read: it finds each tool by name (Executor's tool paths carry
// the app's profile id), calls it and unwraps MCP-style `{content:[{text}]}` answers, then returns only what the caller
// needs, since Executor cuts a returned value past 64 KB. The API key is Executor's CLI key (~/.executor/v2/cli/keys.json).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PRELUDE = `
const normalised = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
const callable = path => { let fn = tools; for (const m of path.slice(5).matchAll(/\\.([A-Za-z_$][\\w$-]*)|\\["([^"]+)"\\]/g)) fn = fn[m[1] ?? m[2]]; return fn; };
const find = async (ns, name) => { const hit = (await tools.search({ namespace: ns, query: name.replace(/[._]/g, " "), limit: 20 })).items.find(x => normalised(x.path).endsWith(normalised(name))); if (!hit) throw new Error("ToolNotFound: " + ns + "." + name); return hit; };
const call = async (ns, name, input) => {
  const raw = await callable((await find(ns, name)).path)(input);
  if (raw?.isError) throw new Error(JSON.stringify(raw));
  if (raw?.structuredContent) return raw.structuredContent;
  if (Array.isArray(raw?.content)) { const text = raw.content.filter(x => x?.type === "text").map(x => String(x.text)).join("\\n"); return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
  return raw;
};
`;

let client: Promise<Client> | undefined;
async function connect(): Promise<Client> {
  const { apiKey } = JSON.parse(await readFile(`${homedir()}/.executor/v2/cli/keys.json`, "utf8"));
  const next = new Client({ name: "nbrain-connectors", version: "0.1.0" });
  next.onclose = () => { client = undefined; };
  await next.connect(new StreamableHTTPClientTransport(new URL(process.env.EXECUTOR_MCP_URL ?? "http://127.0.0.1:4312/mcp"), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return next;
}

/** Run `body` (an async program with `call(app, tool, input)` in scope that `return`s a JSON value) and give back its value. */
export async function executorProgram<T>(body: string): Promise<T> {
  const connection = client ??= connect();
  const mcp = await connection.catch(error => { if (client === connection) client = undefined; throw error; });
  const result = await mcp.callTool({ name: "execute", arguments: { code: `${PRELUDE}\n${body}` } }, undefined, { timeout: 120_000 }).catch((error: unknown) => {
    // A restarted Executor no longer knows this MCP session and refuses every later call on it: connect afresh next time.
    if (client === connection) client = undefined;
    throw error;
  });
  const text = (result.content as { type: string; text?: string }[] | undefined)?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  const run = (result.structuredContent ?? JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))) as { status: string; execution?: { ok: boolean; value: T; error?: { message?: string } } };
  if (result.isError || run.status !== "completed") throw new Error(`Executor: ${text.slice(0, 400)}`);
  if (!run.execution?.ok) throw new Error(run.execution?.error?.message ?? `Executor: ${text.slice(0, 400)}`);
  return run.execution.value;
}
