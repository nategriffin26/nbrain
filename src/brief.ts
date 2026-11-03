// The brief: what an agent reads at the start of a task, built per call and kept under 1,500 tokens. In order: the rules
// for this kind of work (the caller's profile lines under `## Always`, then the lines a model picks for the task), the
// project's block of now.md (with no block for the project, the one block the model picks, or none), up to three strong
// record results for the task (so an agent does not redo what was already done or misread what was already settled),
// and at most three things worth loading (skills and styles, then the library cards of strong bookmarks and saved
// pages), each with how. When it runs long, the picked lines go first, then the record results, then the tail of the
// block; Always lines and pointers stay.
// `nbrain brief` asks memory-mcp for one over HTTP, so the token's scopes apply.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";
import * as z from "zod";
import { BRAND, OWNER, ZONE } from "./config.js";
import { type NowBlock, type ProfileLine, readNow, readProfile } from "./context/profile.js";
import { type Agent, sourcesFor } from "./mcp/types.js";
import { search } from "./memory/search.js";
import { complete, replyJson } from "./models.js";
import { catalog } from "./skills/library.js";

/** 1,500 tokens: real briefs run ~3.8 characters a token (o200k). */
export const BUDGET = 5600;
/** Profile lines a brief shows beyond the Always ones. Filling the budget by embedding nearness (up to 40 lines) gave
 *  briefs where half the lines were other projects' catalog entries, while a line the task needed ranked past the cut. */
export const PICKED = 12;
const POINTERS = 3;
const EARLIER = 3;
const QUOTE = 160;
/** Characters of the task a search gets. */
const QUERY = 300;
/** A brief is waited on: the pick gives up after this and the brief goes out without it. */
const PICK_DEADLINE = 10_000;
/** Record sources that are work on a project (a session, a bot chat, research, a saved page): ahead of texts and mail
 *  when the brief knows the project. */
const WORK_RECORD = ["omp", "chat", "research", "saved"];
const VISUAL = /\b(ui|ux|css|html|layout|design|visual|screens?|pages?|dashboards?|components?|styles?|styling|themes?|colou?rs?|fonts?|typography|landing|website|app icon|mockups?|figma|tailwind|swiftui)\b/i;
/** The model reads every profile line, so a line that bears on the task without sharing its words (the phone his apps
 *  must work on, for a phone-app feature) is found. */
const PICK = `You choose what an agent should be told about ${OWNER.name} before a task. You get the task, the profile lines about ${OWNER.them} (numbered; each with its file and the day it was written), and sometimes the blocks of what is in flight this week.
Pick the lines that would change how the agent does this task: a preference or decision it would otherwise get wrong, or a fact about ${OWNER.them}, ${OWNER.their} setup or ${OWNER.their} projects that the task needs. Leave out lines about other projects, lines that only state general good practice, and lines whose subject the task never touches. When two lines disagree, keep only the later one. Pick at most ${PICKED}, most important first; an empty list is a good answer when none bear on it.
When blocks are given, pick the one block that is about this task's own work, or none.
Answer with JSON only: {"lines": [numbers], "block": "block name" or null}`;

export interface BriefInput { task: string; project?: string }
export interface BriefParts {
  always: string[];
  /** The profile lines picked for the task, most important first. */
  picked: string[];
  /** now.md's block for the task. */
  now?: { day?: string; name: string; lines: string[] };
  /** Strong record results for the task, one line each. */
  earlier: string[];
  pointers: string[];
}

/** The brief as markdown within `budget` characters. Room goes first to the pointers and Always lines, then the now
 *  block, then what came before on this in the record, then the picked lines; each section keeps its own order. */
export function compose(parts: BriefParts, budget = BUDGET): string {
  const rules = `## ${OWNER.name}'s rules for this work`, earlier = "## Earlier on this", load = "## Worth loading";
  const now = parts.now ? `## Now${parts.now.day ? ` (${parts.now.day})` : ""}\n\n### ${parts.now.name}` : "## Now";
  const kept = new Map<string, string[]>([rules, now, earlier, load].map(heading => [heading, []]));
  let used = 0;
  const add = (heading: string, line: string) => {
    const lines = kept.get(heading)!;
    const cost = line.length + 1 + (lines.length ? 0 : heading.length + 2);
    if (used + cost > budget) return;
    lines.push(line);
    used += cost;
  };
  for (const line of parts.pointers.slice(0, POINTERS)) add(load, line);
  for (const line of parts.always) add(rules, `- ${line}`);
  for (const line of parts.now?.lines ?? []) add(now, line);
  for (const line of parts.earlier.slice(0, EARLIER)) add(earlier, line);
  for (const line of parts.picked.slice(0, PICKED)) add(rules, `- ${line}`);
  return [...kept].filter(([, lines]) => lines.length).map(([heading, lines]) => `${heading}\n${lines.join("\n")}`).join("\n\n");
}

const Pick = z.object({ lines: z.array(z.number().int()), block: z.string().nullable().optional() });

/** A pick reply as indices into the `lines` offered (numbered from 1) and one of the `blocks` offered by name: numbers
 *  outside the list, repeats and unknown block names are dropped, and at most PICKED lines are kept. */
export function readPick(reply: string, lines: number, blocks: readonly string[]): { lines: number[]; block?: string } {
  const answer = Pick.parse(replyJson(reply));
  const indices = [...new Set(answer.lines)].filter(number => number >= 1 && number <= lines).map(number => number - 1).slice(0, PICKED);
  const block = blocks.find(name => name.toLowerCase() === answer.block?.trim().toLowerCase());
  return { lines: indices, ...(block ? { block } : {}) };
}

/** The profile lines and the now block a model says bear on the task. */
async function pick(task: string, project: string | undefined, lines: readonly ProfileLine[], blocks: readonly NowBlock[]) {
  const listed = lines.map((line, at) => `${at + 1}. (${line.file}${line.day ? `, ${line.day}` : ""}) ${line.text}`).join("\n");
  const offered = blocks.map(block => `- ${block.name}: ${block.lines[0]?.replace(/^- /, "") ?? ""}`).join("\n");
  const content = `Task: ${task}${project?.trim() ? `\nProject: ${project.trim()}` : ""}\n\nProfile lines:\n${listed}${offered ? `\n\nBlocks:\n${offered}` : ""}`;
  const reply = await complete({ role: "brief", maxTokens: 200, signal: AbortSignal.timeout(PICK_DEADLINE), messages: [{ role: "system", content: PICK }, { role: "user", content }] });
  return readPick(reply, lines.length, blocks.map(block => block.name));
}

const expand = (path: string) => path.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "");

/** The now.md block a project names: its block name, one of its dirs, or a directory inside one of them (a cwd). */
export function projectBlock(blocks: readonly NowBlock[], project: string | undefined): NowBlock | undefined {
  if (!project?.trim()) return undefined;
  const full = expand(project.trim());
  const name = basename(full).toLowerCase();
  return blocks.find(block => block.name.toLowerCase() === name || block.dirs.some(dir => {
    const at = expand(dir);
    return at.includes("/") ? full === at || full.startsWith(`${at}/`) : at.toLowerCase() === name;
  }));
}

/** Strong record results as the brief shows them: a bookmark or saved page with a library card is a thing worth loading
 *  (in search's order), never also a record result; the rest are what came before, with a project its own sessions
 *  first, then other work on record, then texts and mail. */
export function sortFound<T extends { id: string; source: string }>(found: readonly T[], carded: ReadonlySet<string>, own: ReadonlySet<string>, project: boolean): { earlier: T[]; cards: T[] } {
  const rank = (each: T) => own.has(each.id) ? 0 : project && WORK_RECORD.includes(each.source) ? 1 : 2;
  return { earlier: found.filter(each => !carded.has(each.id)).sort((a, b) => rank(a) - rank(b)), cards: found.filter(each => carded.has(each.id)) };
}

/** `to`: only record items dated before it (the A/B cuts the record at a past task's start); not a tool input. */
export async function brief(agent: Agent, input: BriefInput, pool: Pool, { to }: { to?: string } = {}): Promise<string> {
  const task = input.task.trim();
  const profile = readProfile(agent.scopes);
  const { day, blocks } = readNow(agent.scopes);
  const rest = profile.filter(line => !line.always);
  const matched = projectBlock(blocks, input.project);
  const sources = sourcesFor(agent);
  // searches get the task's opening: the local cross-encoder search had before its judge marked the explainer skill weak
  // for a 1,300-character nTop request and strong for its first 300 characters
  const query = task.length <= QUERY ? task : task.slice(0, task.lastIndexOf(" ", QUERY));
  const cut = to ? { to } : {};
  // with no block for the project the model may pick one: every block, shown whole, took up to 90% of the budget on
  // tasks the project's block missed (a new repo, a worktree, "chef-design-lab" against "chef desk")
  const picking = pick(task, input.project, rest, matched ? [] : blocks).catch((error: unknown) => {
    console.warn(`${new Date().toISOString()} brief pick: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  const [chosen, { skills }, skillHits, record] = await Promise.all([
    picking,
    catalog(),
    search(pool, { query, source: ["skill"], limit: POINTERS, ...cut }),
    // library cards come from this search too: a card search of their own judged 30 more hits and found the same cards on
    // library tasks
    search(pool, { query, limit: 10, ...cut, ...(sources ? { source: sources.filter(source => source !== "skill") } : {}) }),
  ]);

  // without the pick (failed, or past its deadline) the profile keeps its own order and no other project's block shows
  const picked = chosen ? chosen.lines.map(at => rest[at]!.text) : rest.map(line => line.text);
  const block = matched ?? blocks.find(each => each.name === chosen?.block);
  const now = block ? { ...(day ? { day } : {}), name: block.name, lines: block.lines } : undefined;

  const found = record.results.filter(result => result.strength === "strong" && result.source !== "skill");
  const ids = found.map(result => result.id);
  const dir = input.project?.trim() ? expand(input.project.trim()) : undefined;
  const [{ rows: cardRows }, { rows: ownRows }] = await Promise.all([
    pool.query<{ id: string; item_id: string; kind: string; what: string; status: string }>("SELECT id, item_id, kind, what, status FROM memory.cards WHERE item_id = ANY($1)", [ids]),
    dir ? pool.query<{ id: string }>("SELECT id FROM memory.items WHERE id = ANY($1) AND (meta->>'cwd' = $2 OR meta->>'cwd' LIKE $3)", [ids, dir, `${dir}/%`]) : { rows: [] },
  ]);
  const card = new Map(cardRows.map(row => [row.item_id, row]));
  const split = sortFound(found, new Set(card.keys()), new Set(ownRows.map(row => row.id)), dir !== undefined);
  const short = (text: string, chars = 160) => text.length <= chars ? text : `${text.slice(0, text.lastIndexOf(" ", chars))}…`;
  const earlier = split.earlier.slice(0, EARLIER).map(result => {
    const day = new Date(result.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ZONE });
    return `- ${day} · ${result.source} · ${short(result.title.replace(/\s+/g, " "), 80)}: ${short(result.quote.replace(/\s+/g, " "), QUOTE)} [${result.id}]`;
  });
  // the default style for screen work, then skills search finds strong for the task (never the brain's own guides,
  // which skill_get points to when saving), then strong library cards
  const style = VISUAL.test(task) ? skills.find(entry => entry.kind === "style" && entry.default) : undefined;
  const strong = new Set(skillHits.results.filter(hit => hit.strength === "strong").map(hit => hit.id));
  const shown = [...(style ? [style] : []), ...skills.filter(entry => entry !== style && !entry.path.startsWith("nbrain/") && strong.has(`skill:${entry.path}`))];
  const pointers = [
    ...shown.map(entry => `- ${entry.path} (${entry.kind}${entry.default ? ", the default" : ""}): ${short(entry.description.split(/(?<=[.!?])\s/)[0]!)} Load: skill_get {"name":"${entry.path}"}`),
    ...split.cards.map(result => card.get(result.id)!).map(each => `- ${short(each.what)} (${each.kind}${each.status === "new" ? "" : `, ${each.status}`}) Load: fetch {"id":"${each.id}"}`),
  ];
  return compose({ always: profile.filter(line => line.always).map(line => line.text), picked, ...(now ? { now } : {}), earlier, pointers });
}

type OmpServers = Record<string, { url?: string; headers?: Record<string, string> }>;
/** The bearer token omp's mcp.json holds for the brain at `url`: the server entry whose url has the same origin and
 *  path (omp may name it anything), else the one named BRAND. */
export function ompToken(servers: OmpServers | undefined, url: URL): string | undefined {
  const same = (each: { url?: string }) => { try { const at = new URL(each.url ?? ""); return at.origin === url.origin && at.pathname.replace(/\/+$/, "") === url.pathname.replace(/\/+$/, ""); } catch { return false; } };
  const entry = Object.values(servers ?? {}).find(same) ?? servers?.[BRAND];
  return /^Bearer\s+(\S+)$/.exec(entry?.headers?.Authorization ?? "")?.[1];
}

/** `nbrain brief --task "…" [--project …]`: a brief from memory-mcp on stdout, as the token in NBRAIN_TOKEN, else the
 *  one omp's mcp.json holds for the brain. */
export async function briefCommand(args: string[]): Promise<void> {
  const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const task = flag("task"), project = flag("project");
  if (!task) throw new Error('usage: brief --task "…" [--project <name or dir>]');
  const url = new URL(process.env.NBRAIN_URL ?? `http://127.0.0.1:${process.env.MEMORY_MCP_PORT ?? "8830"}/mcp`);
  let token = process.env.NBRAIN_TOKEN;
  if (!token) {
    const config = JSON.parse(await readFile(`${homedir()}/.omp/agent/mcp.json`, "utf8").catch(() => "{}")) as { mcpServers?: OmpServers };
    token = ompToken(config.mcpServers, url);
    if (!token) throw new Error(`NBRAIN_TOKEN is not set and omp's mcp.json has no token for ${url.href} (nbrain connect omp gives it one)`);
  }
  const client = new Client({ name: "nbrain-brief", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try {
    const result = await client.callTool({ name: "brief", arguments: { task, ...(project ? { project } : {}) } });
    const text = (result.content as { type: string; text?: string }[]).map(part => part.text ?? "").join("");
    if (result.isError) throw new Error(text);
    console.log(text);
  } finally {
    await client.close();
  }
}
