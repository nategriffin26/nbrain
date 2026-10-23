// now.md: what is in flight, rewritten whole every morning (05:30) and by `nbrain now`, never edited (format in
// context/profile.ts). One block per repo with commits in the last week under NOW_ROOTS, per desk with fresh work under
// NOW_DESKS, and Life. The material is read here; one model call says what each block is doing and what comes next, and
// the code keeps the shape: ≤ 5 lines a block, ≤ 4 KB in all, oldest blocks dropped first.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import pg, { type Pool } from "pg";
import * as z from "zod";
import { CONTEXT, OWNER, ZONE } from "./config.js";
import { commit } from "./context/git.js";
import { NOW_FILE } from "./context/profile.js";
import { NOT_PRIVATE, ownerTurns, privateRef } from "./curator.js";
import { complete, replyJson } from "./models.js";
import { localTime } from "./time.js";

const O = OWNER.name;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const BUDGET = 4000;
const BLOCK_LINES = 5;
const run = promisify(execFile);

/** What one block is written from. `last`: when it was last touched (ms). */
interface Material { key: string; name: string; dirs: string[]; last: number; text: string[] }

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric" });
const clip = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}…` : text).replace(/\s+/g, " ").trim();
const dirsIn = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => join(path, entry.name));

/** A ledger's head as a reader needs it: everything before its log and archive, then the last log lines. */
export function ledgerHead(text: string): string {
  const body = text.split(/\n## Archive\b/)[0]!;
  const log = /\n## Log\n([\s\S]*?)(?=\n## |$)/.exec(body)?.[1]?.split("\n").filter(line => line.trim()).slice(-5) ?? [];
  const head = body.replace(/\n## Log\n[\s\S]*?(?=\n## |$)/, "").trim().slice(0, 1500);
  return [head, ...(log.length ? ["Last log lines:", ...log] : [])].join("\n");
}

/** Repos under NOW_ROOTS (each root and its children) with commits in the last week, with their nstack ledgers. */
async function repos(roots: readonly string[], since: number): Promise<Material[]> {
  const candidates = (await Promise.all(roots.map(async root => [root, ...await dirsIn(root)]))).flat().filter(dir => existsSync(`${dir}/.git`));
  const found = await Promise.all(candidates.map(async (dir): Promise<Material | undefined> => {
    const log = await run("git", ["-C", dir, "log", "--all", `--since=@${Math.floor(since / 1000)}`, "--format=%h%x09%ct%x09%s", "-n", "20"]).then(out => out.stdout.trim(), () => "");
    if (!log) return undefined;
    const commits = log.split("\n").map(line => line.split("\t") as [string, string, string]);
    const ledgers = await Promise.all((await readdir(`${dir}/local/nstack`).catch(() => [] as string[])).filter(name => name.endsWith(".md")).map(async name => {
      const path = `${dir}/local/nstack/${name}`;
      return { name, path, mtime: (await stat(path)).mtimeMs };
    }));
    const fresh = ledgers.filter(each => each.mtime >= since).sort((a, b) => b.mtime - a.mtime).slice(0, 2);
    return {
      key: `repo:${tilde(dir)}`, name: basename(dir), dirs: [tilde(dir), basename(dir)], last: Math.max(...commits.map(([, at]) => Number(at) * 1000)),
      text: [
        "Commits:", ...commits.map(([hash, at, subject]) => `${shortDay(Number(at) * 1000)} ${hash} ${clip(subject, 160)}`),
        ...(await Promise.all(fresh.map(async each => `Ledger ${each.name}:\n${ledgerHead(await readFile(each.path, "utf8"))}`))),
      ],
    };
  }));
  return found.filter(each => each !== undefined);
}

/** The owner's prompts in coding sessions this week, onto the repo they ran in; a session in a folder under a root with no
 *  commits makes its own block. */
async function sessions(pool: Pool, roots: readonly string[], blocks: Material[], since: number): Promise<void> {
  const { rows } = await pool.query<{ at: Date; body: string; cwd: string | null }>(
    `SELECT i.at, i.body, i.meta->>'cwd' AS cwd FROM memory.items i WHERE i.source = 'omp' AND i.at >= $1 AND ${NOT_PRIVATE} ORDER BY i.at DESC`, [new Date(since)]);
  for (const row of rows) {
    const cwd = row.cwd ?? "";
    const prompt = ownerTurns(row.body);
    if (!cwd || !prompt) continue;
    let block = blocks.filter(each => each.key.startsWith("repo:")).find(each => `${cwd}/`.startsWith(`${each.dirs[0]!.replace(/^~/, homedir())}/`));
    if (!block) {
      const root = roots.find(each => cwd.startsWith(`${each}/`));
      if (!root) continue;
      const dir = join(root, cwd.slice(root.length + 1).split("/")[0]!);
      block = { key: `repo:${tilde(dir)}`, name: basename(dir), dirs: [tilde(dir), basename(dir)], last: row.at.getTime(), text: [] };
      blocks.push(block);
    }
    if (block.text.filter(line => line.startsWith("Session prompt")).length < 6) block.text.push(`Session prompt ${shortDay(row.at.getTime())}: ${clip(prompt, 240)}`);
  }
}

/** Files under `dir` (two levels) changed since `since`, newest first. */
async function changedFiles(dir: string, since: number, depth = 2): Promise<{ path: string; mtime: number }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules").map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return depth > 1 ? changedFiles(path, since, depth - 1) : [];
    const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
    return mtime >= since ? [{ path, mtime }] : [];
  }));
  return found.flat().sort((a, b) => b.mtime - a.mtime);
}

/** Desks under NOW_DESKS (one per bot: memory/<desk>/journal.md, and its folder <desk>/ when it has one) with fresh files,
 *  chats or notes this week. */
async function desks(pool: Pool, root: string, since: number): Promise<Material[]> {
  const names = (await dirsIn(`${root}/memory`)).map(dir => basename(dir)).filter(name => name !== "shared");
  const { rows: chats } = await pool.query<{ at: Date; body: string; bot: string; source: string }>(
    `SELECT i.at, i.body, lower(coalesce(i.thread_title, i.sender_name, '')) AS bot, i.source FROM memory.items i
     WHERE i.source IN ('chat', 'note') AND i.at >= $1 AND ${NOT_PRIVATE} ORDER BY i.at DESC`, [new Date(since)]);
  const found = await Promise.all(names.map(async (name): Promise<Material | undefined> => {
    const folder = `${root}/${name}`;
    const files = existsSync(folder) ? (await changedFiles(folder, since)).slice(0, 8) : [];
    const journal = `${root}/memory/${name}/journal.md`;
    const journalAt = (await stat(journal).catch(() => undefined))?.mtimeMs ?? 0;
    const said = chats.filter(chat => chat.bot === name).slice(0, 8);
    if (!files.length && journalAt < since && !said.length) return undefined;
    const heads = await Promise.all(files.filter(file => file.path.endsWith(".md")).slice(0, 2).map(async file => `${tilde(file.path)}:\n${clip(await readFile(file.path, "utf8"), 600)}`));
    return {
      key: `desk:${name}`, name: `${name} desk`, dirs: [name, ...(existsSync(folder) ? [tilde(folder)] : [])],
      last: Math.max(files[0]?.mtime ?? 0, journalAt >= since ? journalAt : 0, said[0]?.at.getTime() ?? 0),
      text: [
        ...(files.length ? [`Files changed: ${files.map(file => `${tilde(file.path)} (${shortDay(file.mtime)})`).join(", ")}`] : []),
        ...heads,
        ...(journalAt >= since ? [`Journal (end):\n${(await readFile(journal, "utf8")).slice(-1500)}`] : []),
        ...said.map(chat => chat.source === "note"
          ? `Note ${shortDay(chat.at.getTime())}: ${clip(chat.body, 240)}`
          : `Chat ${shortDay(chat.at.getTime())}: ${O}: ${clip(ownerTurns(chat.body) || "(none)", 200)} | ${clip(chat.body.replace(/^[\s\S]*?\n\n/, ""), 200)}`),
      ],
    };
  }));
  return found.filter(each => each !== undefined);
}

/** The next 14 days of the owner's life: calendar, bills due and appointments or commitments the owner is a party to,
 *  and what the owner said to the bots this week. */
async function life(pool: Pool, now: number, since: number): Promise<Material> {
  const end = new Date(now + 14 * DAY);
  const { rows: events } = await pool.query<{ at: Date; title: string }>(
    `SELECT i.at, i.title FROM memory.items i WHERE i.source = 'calendar' AND i.at >= $1 AND i.at < $2 AND coalesce(i.meta->>'deleted', 'false') <> 'true' AND ${NOT_PRIVATE} ORDER BY i.at LIMIT 40`,
    [new Date(now), end]);
  const { rows: records } = await pool.query<{ type: string; org: string | null; title: string; amount: string | null; due_at: Date | null; start_at: Date | null; status: string | null }>(
    `SELECT r.type, r.org, r.title, r.amount, r.due_at, r.start_at, r.status FROM memory.records r JOIN memory.items i ON i.id = r.item_id
     WHERE r.superseded_by IS NULL AND i.source <> 'calendar' AND ${NOT_PRIVATE}
       AND (i.from_me OR i.source = 'gmail' OR r.people ?| (array(SELECT id FROM memory.people WHERE kind = 'self') || array[$4::text, $5::text]))
       AND ((r.type = 'bill' AND r.due_at >= $1 AND r.due_at < $3 AND coalesce(r.status, '') NOT IN ('paid', 'cancelled'))
         OR (r.type IN ('appointment', 'commitment') AND r.start_at >= $2 AND r.start_at < $3))
     ORDER BY coalesce(r.due_at, r.start_at) LIMIT 40`,
    [new Date(now - 3 * DAY), new Date(now), end, OWNER.name, OWNER.fullName]);
  const { rows: chats } = await pool.query<{ at: Date; body: string; bot: string | null }>(
    `SELECT i.at, i.body, i.thread_title AS bot FROM memory.items i WHERE i.source = 'chat' AND i.at >= $1 AND ${NOT_PRIVATE} ORDER BY i.at DESC LIMIT 200`, [new Date(since)]);
  const when = (at: Date) => localTime(at.getTime()).slice(0, 16).replace("T", " ");
  const said = chats.flatMap(chat => { const own = ownerTurns(chat.body); return own ? [`${shortDay(chat.at.getTime())} to ${chat.bot ?? "a bot"}: ${clip(own, 200)}`] : []; }).slice(0, 20);
  return {
    key: "life", name: "Life", dirs: [], last: now,
    text: [
      "Calendar:", ...events.map(event => `${when(event.at)} ${clip(event.title, 100)}`),
      "Records:", ...records.map(record => `${record.type} ${[record.org, clip(record.title, 100), record.amount && `$${record.amount}`, record.due_at && `due ${when(record.due_at)}`, record.start_at && `at ${when(record.start_at)}`, record.status].filter(Boolean).join(" · ")}`),
      `${O}'s own words to the bots:`, ...said,
    ],
  };
}

const NowReply = z.object({ blocks: z.array(z.object({ key: z.string(), lines: z.array(z.string()) })).default([]) });

const system = `You write now.md: what ${O} has in flight this week, one block per project, desk or area, read by every agent at the start of a task. You get each block's material from the last 7 days (commits, project ledgers, ${O}'s prompts in coding sessions, a desk's changed files, journal and chats, the next 14 days of ${OWNER.their} life) and the corrections agents passed on in the last two weeks, which override anything they contradict.
For each block worth showing, at most 4 lines: what is in flight and where it stands, then the next step (who does it, when known). Plain words, outcome first, absolute dates, no filler. Skip a block with nothing in flight (a stray commit, a finished one-off). Life: what is coming up in the next two weeks that ${O} has to do or be at, and money due; nothing about other people's private news.
Answer with JSON only: {"blocks":[{"key":"…","lines":["…"]}]}, keys as given.`;

/** now.md for `now`, built from the record (read-only) and the files under NOW_ROOTS and NOW_DESKS. */
export async function buildNow(pool: Pool, now = new Date()): Promise<string> {
  const at = now.getTime(), since = at - WEEK;
  const roots = (process.env.NOW_ROOTS ?? "").split(":").map(root => root.trim()).filter(Boolean);
  const blocks = await repos(roots, since);
  await sessions(pool, roots, blocks, since);
  if (process.env.NOW_DESKS) blocks.push(...await desks(pool, process.env.NOW_DESKS, since));
  blocks.push(await life(pool, at, since));
  // a correction about something private is left out with it
  const { rows: corrections } = await pool.query<{ id: string; text: string; target: string | null; at: Date }>(
    `SELECT c.id::text, c.text, c.target, c.at FROM memory.corrections c WHERE c.at >= $1 AND NOT ${privateRef("c.target")} ORDER BY c.at`, [new Date(at - 2 * WEEK)]);
  const reply = NowReply.parse(replyJson(await complete({
    role: "curator", session: "now", maxTokens: 4096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        `Today is ${shortDay(at)}, ${localTime(at).slice(0, 10)}.`,
        ...(corrections.length ? [`Corrections:\n${corrections.map(each => `- ${shortDay(each.at.getTime())}${each.target ? ` (about ${each.target})` : ""}: ${each.text}`).join("\n")}`] : []),
        ...blocks.map(block => `### ${block.key} (${block.name}${block.key === "life" ? "" : `, last touched ${shortDay(block.last)}`})\n${block.text.join("\n")}`),
      ].join("\n\n") },
    ],
  })));
  const written = new Map(reply.blocks.map(block => [block.key, block.lines.map(line => line.replace(/^\s*[-*]\s*/, "").replace(/<!--|-->/g, "").trim()).filter(Boolean)]));
  const render = (block: Material) => {
    const lines = written.get(block.key)!.slice(0, block.key === "life" ? BLOCK_LINES : BLOCK_LINES - 1);
    return [`## ${block.name}`, ...(block.dirs.length ? [`<!-- dirs: ${block.dirs.join(", ")} -->`] : []), ...lines.map(line => `- ${line}`),
      ...(block.key === "life" ? [] : [`- Last touched ${shortDay(block.last)}.`])].join("\n");
  };
  const shown = blocks.filter(block => written.get(block.key)?.length);
  const work = shown.filter(block => block.key !== "life").sort((a, b) => b.last - a.last);
  const lifeBlock = shown.filter(block => block.key === "life");
  const page = (kept: Material[]) => [`# Now · ${localTime(at).slice(0, 10)}`, ...[...kept, ...lifeBlock].map(render)].join("\n\n") + "\n";
  // past the budget, the blocks touched longest ago go first
  while (work.length && Buffer.byteLength(page(work)) > BUDGET) work.pop();
  return page(work);
}

/** Rewrite now.md and commit it as "now"; answers the commit id (undefined when nothing changed). */
export async function writeNow(pool: Pool, now = new Date()): Promise<string | undefined> {
  const text = await buildNow(pool, now);
  await writeFile(`${CONTEXT}/${NOW_FILE}`, text);
  return commit([NOW_FILE], `now ${localTime(now.getTime()).slice(0, 10)}`, "now");
}

/** `now [--dry-run]`: write now.md now (or only print it). */
export async function nowCommand(args: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    if (args.includes("--dry-run")) console.log(await buildNow(pool));
    else { const id = await writeNow(pool); console.log(`${await readFile(`${CONTEXT}/${NOW_FILE}`, "utf8")}\n${id ? `committed ${id}` : "unchanged"}`); }
  } finally {
    await pool.end();
  }
}
