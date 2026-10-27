// `nbrain init` sets up a new brain (env file, folders, context repo, schema, memory-mcp's database roles) and is safe to
// run again: it never overwrites a file or resets a role that exists. `nbrain doctor` checks every moving part.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { BRAIN_HOME, CONTEXT, LOGS, OWNER, MEMORY_POOL, connectionLimit } from "./config.js";
import { ensureRepo, commit } from "./context/git.js";
import { prepareReader } from "./memory/records.js";
import { EMBED_MODEL } from "./memory/store.js";
import { modelsCheck } from "./weekly.js";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const ENV_FILE = `${BRAIN_HOME}/env`;

async function writeEnv(name: string | undefined): Promise<boolean> {
  if (existsSync(ENV_FILE)) return false;
  const [first] = (name ?? "").split(" ");
  let text = await readFile(`${ROOT}env.example`, "utf8");
  if (name) text = text.replace(/^OWNER_NAME=.*$/m, `OWNER_NAME=${first}`).replace(/^OWNER_FULL_NAME=.*$/m, `OWNER_FULL_NAME="${name}"`);
  text = text.replace(/^TZ=.*$/m, `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  await writeFile(ENV_FILE, text, { mode: 0o600 });
  return true;
}

async function seedContext(): Promise<boolean> {
  if (existsSync(`${CONTEXT}/README.md`)) return false;
  await mkdir(CONTEXT, { recursive: true });
  await cp(`${ROOT}templates/context`, CONTEXT, { recursive: true, force: false, errorOnExist: false });
  const fill = (text: string) => text.replaceAll("{{OWNER_FULL}}", OWNER.fullName).replaceAll("{{OWNER}}", OWNER.name);
  const files = (await readdir(CONTEXT, { recursive: true })).filter(file => file.endsWith(".md"));
  for (const file of files) await writeFile(`${CONTEXT}/${file}`, fill(await readFile(`${CONTEXT}/${file}`, "utf8")));
  await ensureRepo();
  await commit(files, "context: started from the nbrain template", "nbrain");
  return true;
}

/** memory-mcp's two login roles, created once with random passwords kept in the Keychain (KEYCHAIN_PREFIX) or the env file. */
async function roles(pool: pg.Pool): Promise<string[]> {
  const done: string[] = [];
  const db = (await pool.query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db;
  const at = (process.env.DATABASE_URL ?? "").replace(/^[^@]*@/, "");
  for (const [role, member, suffix, envName] of [["memory_ro", true, "ro", "MEMORY_RO_DATABASE_URL"], ["memory_writer", false, "writer", "MEMORY_WRITER_DATABASE_URL"]] as const) {
    if ((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount) continue;
    const password = randomBytes(24).toString("base64url");
    await pool.query(`CREATE ROLE ${role} LOGIN CONNECTION LIMIT ${connectionLimit(role)} PASSWORD '${password}'${member ? " IN ROLE memory_reader" : ""}`);
    await pool.query(`GRANT CONNECT ON DATABASE "${db}" TO ${role}`);
    if (process.env.KEYCHAIN_PREFIX) await run("/usr/bin/security", ["add-generic-password", "-U", "-a", role, "-s", `${process.env.KEYCHAIN_PREFIX}-${suffix}`, "-w", password]);
    else await appendFile(ENV_FILE, `${envName}=postgres://${role}:${password}@${at}\n`);
    done.push(role);
  }
  return done;
}

export async function initCommand(args: string[]): Promise<void> {
  const at = args.indexOf("--name");
  const name = at >= 0 ? args[at + 1] : undefined;
  await mkdir(BRAIN_HOME, { recursive: true, mode: 0o700 });
  if (await writeEnv(name)) {
    console.log(`wrote ${ENV_FILE}: check OWNER_*, TZ, DATABASE_URL, CLOUDFLARE_* and LLM_URLS, then run \`nbrain init\` again`);
    return;
  }
  for (const dir of [LOGS, `${BRAIN_HOME}/eval`, `${BRAIN_HOME}/captures`, `${BRAIN_HOME}/memory-mcp`]) await mkdir(dir, { recursive: true });
  if (await seedContext()) console.log(`context repo started at ${CONTEXT}`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(await readFile(new URL("./memory/schema.sql", import.meta.url), "utf8"));
    await prepareReader(pool);
    const made = await roles(pool);
    // schema.sql grants memory_writer its inserts only once the role exists
    if (made.includes("memory_writer")) await pool.query(await readFile(new URL("./memory/schema.sql", import.meta.url), "utf8"));
    console.log(`database ready${made.length ? `; created ${made.join(", ")} (passwords in ${process.env.KEYCHAIN_PREFIX ? "the login Keychain" : ENV_FILE})` : ""}`);
  } finally {
    await pool.end();
  }
  await chmod(ENV_FILE, 0o600);
  console.log(`next: ollama pull ${EMBED_MODEL}; bin/install-launchd.sh (macOS) and load the jobs; nbrain connect <client>; nbrain doctor`);
}

type Check = [ok: boolean | undefined, what: string, detail?: string];

async function reach(url: string, init?: RequestInit): Promise<Response | undefined> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(4000) }); } catch { return undefined; }
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [[existsSync(ENV_FILE), "env file", ENV_FILE], [process.env.OWNER_NAME !== undefined, "owner", OWNER.fullName]];
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_search')");
    checks.push([rows.length === 2, "postgres", `extensions: ${rows.map(row => row.extname).join(", ") || "none"}`]);
    const { rows: limits } = await pool.query<{ rolname: keyof typeof MEMORY_POOL; rolconnlimit: number }>("SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = ANY($1)", [Object.keys(MEMORY_POOL)]);
    for (const { rolname: role, rolconnlimit: limit } of limits) {
      const short = limit >= 0 && limit < MEMORY_POOL[role];
      checks.push([!short, `${role} limit`, short ? `${limit} is below memory-mcp's pool of ${MEMORY_POOL[role]}: ALTER ROLE ${role} CONNECTION LIMIT ${connectionLimit(role)}` : `${limit < 0 ? "none" : limit} (pool ${MEMORY_POOL[role]})`]);
    }
    const { rows: items } = await pool.query<{ source: string; n: number }>("SELECT source, count(*)::int AS n FROM memory.items GROUP BY source ORDER BY n DESC");
    checks.push([true, "items", items.map(row => `${row.source} ${row.n}`).join(", ") || "none yet"]);
    const { rows: cursors } = await pool.query<{ source: string; ago: string; last_error: string | null }>("SELECT source, coalesce(to_char(now() - last_ok_at, 'DD\"d\" HH24\"h\" MI\"m\"'), 'never') AS ago, last_error FROM brain.cursors ORDER BY source");
    for (const cursor of cursors) checks.push([cursor.last_error === null, `connector ${cursor.source}`, cursor.last_error ? `error: ${cursor.last_error.slice(0, 120)}` : `ok ${cursor.ago} ago`]);
  } catch (error) {
    checks.push([false, "postgres", String((error as Error).message)]);
  } finally {
    await pool.end();
  }
  const failed = await modelsCheck();
  checks.push([!failed.embeddings, "embeddings", failed.embeddings ? `ollama: ${failed.embeddings}` : `ollama ${EMBED_MODEL}`]);
  checks.push([!failed.judge, "search judge", failed.judge ?? "workers ai @cf/cloudflare/clef"]);
  const llm = (process.env.LLM_URLS ?? "").split(",")[0]?.trim();
  if (llm) {
    const key = process.env.LLM_API_KEY ?? (process.env.LLM_API_KEY_FILE && existsSync(process.env.LLM_API_KEY_FILE) ? (await readFile(process.env.LLM_API_KEY_FILE, "utf8")).trim() : "");
    const answer = await reach(`${llm}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    checks.push([answer?.ok ?? false, "chat models", `${llm}: ${answer ? answer.status : "unreachable"}`]);
  }
  const port = process.env.MEMORY_MCP_PORT ?? "8830";
  checks.push([(await reach(`http://127.0.0.1:${port}/healthz`))?.ok ?? false, "memory-mcp", `http://127.0.0.1:${port}/mcp`]);
  if (process.env.PUBLIC_URL) checks.push([(await reach(`${process.env.PUBLIC_URL}/mcp`, { method: "POST" }))?.status === 401, "public door", `${process.env.PUBLIC_URL}/mcp answers 401 without a token`]);
  checks.push([existsSync(`${CONTEXT}/.git`), "context repo", CONTEXT]);
  for (const [ok, what, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${what.padEnd(14)} ${detail ?? ""}`);
  if (checks.some(([ok]) => ok === false)) process.exitCode = 1;
}
