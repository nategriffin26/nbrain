// nbrain from a shell (bin/nbrain loads $BRAIN_HOME/env first). Each command lives with its module; this only routes,
// importing lazily so `nbrain mcp` (a client's stdio server) starts without the database code.
type Command = [summary: string, load: () => Promise<(args: string[]) => Promise<void>>];

const COMMANDS: Record<string, Command> = {
  init: ['set up a brain: env file, folders, context repo, database and roles  [--name "Full Name"]', async () => (await import("./setup.js")).initCommand],
  doctor: ["check the database, models, connectors, memory-mcp and the public door", async () => (await import("./setup.js")).doctorCommand],
  connect: ["give a client (omp, claude-code, codex, cursor, claude-desktop, json) a token and the brain", async () => (await import("./connect.js")).connectCommand],
  token: ["list, add or revoke agent tokens and OAuth grants", async () => (await import("./mcp/auth.js")).tokenCommand],
  mcp: ["stdio MCP server relaying to memory-mcp (NBRAIN_TOKEN, NBRAIN_URL)", async () => (await import("./mcp/stdio.js")).mcpCommand],
  save: ['save a URL, or - for text on stdin  [--why "…"] [--title "…"]', async () => { const { captureCommand } = await import("./capture/save.js"); return args => captureCommand(["save", ...args]); }],
  search: ["search the brain  <query> [--source a,b] [--limit n]", async () => searchCommand],
  skill: ["skills and styles: list | show <name> | check <dir>", async () => (await import("./skills/cli.js")).skillsCommand],
  garden: ["garden one day now  [--day YYYY-MM-DD] [--dry-run]", async () => (await import("./garden.js")).gardenCommand],
  omp: ["read new omp sessions now", async () => (await import("./connectors/omp.js")).ompCommand],
  eval: ["retrieval eval: facts found in the top 10  [questions.json]", async () => (await import("./eval/recall.js")).evalCommand],
};

async function searchCommand(args: string[]): Promise<void> {
  const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args.splice(at, 2)[1]; };
  const source = flag("source")?.split(",");
  const limit = flag("limit");
  if (!args.length) throw new Error("usage: search <query> [--source a,b] [--limit n]");
  const [{ default: pg }, { search, renderHits }] = await Promise.all([import("pg"), import("./memory/search.js")]);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const result = await search(pool, { query: args.join(" "), ...(source ? { source } : {}), ...(limit ? { limit: Number(limit) } : {}) });
    console.log(renderHits(result.hits));
  } finally {
    await pool.end();
  }
}

const [name, ...args] = process.argv.slice(2);
const command = name ? COMMANDS[name] : undefined;
if (!command) {
  console.log(`nbrain <command>\n\n${Object.entries(COMMANDS).map(([key, [summary]]) => `  ${key.padEnd(8)} ${summary}`).join("\n")}`);
  process.exit(name && name !== "help" ? 1 : 0);
}
try {
  await (await command[1]())(args);
} catch (error) {
  console.error(`nbrain ${name}: ${(error as Error).message}`);
  process.exitCode = 1;
}
