// `nbrain connect <client>`: give a client its own token (its name is the agent every write is signed with) and write
// the brain into that client's MCP config. HTTP where the client sends headers; the stdio relay (`nbrain mcp`) where it
// only starts local commands. --remote points it at PUBLIC_URL instead of loopback (cloud and other machines).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { BRAND } from "./config.js";
import { mintToken } from "./mcp/auth.js";
import { SCOPES, type Scope } from "./mcp/types.js";

const run = promisify(execFile);
const RELAY = new URL("../bin/nbrain", import.meta.url).pathname;

/** Merge one server into a JSON config's `mcpServers`, keeping a dated copy of the file it replaces. */
async function mergeJson(file: string, entry: Record<string, unknown>): Promise<string> {
  const config = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) as { mcpServers?: Record<string, unknown> } : {};
  if (existsSync(file)) await copyFile(file, `${file}.bak-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
  config.mcpServers = { ...config.mcpServers, [BRAND]: entry };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

const CLIENTS: Record<string, (url: string, token: string) => Promise<string>> = {
  omp: (url, token) => mergeJson(`${homedir()}/.omp/agent/mcp.json`, { type: "http", url, headers: { Authorization: `Bearer ${token}` } }),
  cursor: (url, token) => mergeJson(`${homedir()}/.cursor/mcp.json`, { url, headers: { Authorization: `Bearer ${token}` } }),
  "claude-desktop": (url, token) => mergeJson(`${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`, { command: RELAY, args: ["mcp"], env: { NBRAIN_URL: url, NBRAIN_TOKEN: token } }),
  "claude-code": async (url, token) => {
    await run("claude", ["mcp", "remove", "--scope", "user", BRAND]).catch(() => undefined);
    await run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", BRAND, url, "--header", `Authorization: Bearer ${token}`]);
    return "claude mcp (user scope)";
  },
  codex: async (url, token) => {
    await run("codex", ["mcp", "remove", BRAND]).catch(() => undefined);
    await run("codex", ["mcp", "add", BRAND, "--env", `NBRAIN_URL=${url}`, "--env", `NBRAIN_TOKEN=${token}`, "--", RELAY, "mcp"]);
    return "~/.codex/config.toml";
  },
  json: async (url, token) => {
    console.log(JSON.stringify({ mcpServers: { [BRAND]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2));
    console.log(JSON.stringify({ mcpServers: { [BRAND]: { command: RELAY, args: ["mcp"], env: { NBRAIN_URL: url, NBRAIN_TOKEN: token } } } }, null, 2));
    return "stdout (HTTP form, then the stdio form)";
  },
};

const USAGE = `usage: connect <${Object.keys(CLIENTS).join("|")}> [--agent name] [--scopes ${SCOPES.join(",")}] [--remote]`;

export async function connectCommand(args: string[]): Promise<void> {
  const [client] = args;
  const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const write = client ? CLIENTS[client] : undefined;
  if (!client || !write) throw new Error(USAGE);
  const scopes = (flag("scopes") ?? "work,write").split(",").map(scope => scope.trim());
  const unknown = scopes.filter(scope => !(SCOPES as readonly string[]).includes(scope));
  if (unknown.length) throw new Error(`unknown scope ${unknown.join(", ")}; ${USAGE}`);
  const base = args.includes("--remote") ? process.env.PUBLIC_URL : `http://127.0.0.1:${process.env.MEMORY_MCP_PORT ?? "8830"}`;
  if (!base) throw new Error("--remote needs PUBLIC_URL in the env file");
  const agent = flag("agent") ?? client;
  const token = await mintToken(agent, scopes as Scope[], agent);
  const where = await write(`${base}/mcp`, token);
  console.error(`${client}: ${BRAND} at ${base}/mcp as agent "${agent}" (${scopes.join(", ")}) → ${where}`);
}
