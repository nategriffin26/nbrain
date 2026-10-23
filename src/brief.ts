// The brief: what an agent reads at the start of a task, built per call and kept near 1,500 tokens. In order: the rules
// for this kind of work (the caller's profile lines under `## Always`, then the lines nearest the task), the project's
// slice of now.md (with no project, all of it, nearest first), up to three strong record results for the task (so an
// agent does not redo what was already done or misread what was already settled), and at most three things worth
// loading (skills and styles, then the library cards of strong bookmarks and saved pages), each with how. When it runs
// long, the near lines go first, then the other now blocks, then the record results, then the tail of the project's
// block; Always lines and pointers stay.
// `nbrain brief` asks memory-mcp for one over HTTP, so the token's scopes apply.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";
import { BRAND, OWNER, ZONE } from "./config.js";
import { type NowBlock, readNow, readProfile } from "./context/profile.js";
import { type Agent, sourcesFor } from "./mcp/types.js";
import { search } from "./memory/search.js";
import { embed } from "./memory/store.js";
import { sha256 } from "./memory/text.js";
import { catalog } from "./skills/library.js";

/** 1,500 tokens: real briefs run ~3.8 characters a token (o200k). */
export const BUDGET = 5600;
const NEAR = 40;
const POINTERS = 3;
const EARLIER = 3;
const QUOTE = 160;
/** Characters of the task a search gets. */
const QUERY = 300;
/** Record sources that are work on a project (a session, a bot chat, research, a saved page): ahead of texts and mail
 *  when the brief knows the project. */
const WORK_RECORD = ["omp", "chat", "research", "saved"];
/** Profile lines are ranked by embedding and fill what room the budget leaves, nearest first. Each line's score is its
 *  nearness to the task less its average nearness to the other lines (its hubness), or the same few broad lines (a
 *  project list, a home folder) rank high for every task. No floor: on real tasks a floor left briefs at a third of
 *  their room, and a blind judge missed the lines it dropped. */
const INSTRUCTION = `Instruct: Given a task an agent is about to do for ${OWNER.name}, find the rules, preferences and facts about ${OWNER.them} that matter for doing it well\nQuery: `;
const VISUAL = /\b(ui|ux|css|html|layout|design|visual|screens?|pages?|dashboards?|components?|styles?|styling|themes?|colou?rs?|fonts?|typography|landing|website|app icon|mockups?|figma|tailwind|swiftui)\b/i;

export interface BriefInput { task: string; project?: string }
export interface BriefParts {
  always: string[];
  /** Nearest first. */
  near: string[];
  /** now.md's blocks, the project's (or the nearest) first. */
  now?: { day?: string; blocks: { name: string; lines: string[] }[] };
  /** Strong record results for the task, one line each. */
  earlier: string[];
  pointers: string[];
}

/** The brief as markdown within `budget` characters. Room goes first to the pointers and Always lines, then the first
 *  now block, then what came before on this in the record, then the other now blocks (where things stand beats one more
 *  rule: a blind judge missed the week's blocks when near lines took their room), then the near lines; each section
 *  keeps its own order. */
export function compose(parts: BriefParts, budget = BUDGET): string {
  const rules = `## ${OWNER.name}'s rules for this work`, earlier = "## Earlier on this", load = "## Worth loading";
  const now = `## Now${parts.now?.day ? ` (${parts.now.day})` : ""}`;
  const blocks = parts.now?.blocks ?? [];
  const kept = new Map<string, string[]>([rules, ...blocks.map(block => `### ${block.name}`), earlier, load].map(heading => [heading, []]));
  let used = 0, nowShown = false;
  const add = (heading: string, line: string) => {
    const lines = kept.get(heading)!, block = heading.startsWith("###");
    const cost = line.length + 1 + (lines.length ? 0 : heading.length + 2) + (block && !nowShown ? now.length + 2 : 0);
    if (used + cost > budget) return;
    lines.push(line);
    used += cost;
    nowShown ||= block;
  };
  for (const line of parts.pointers.slice(0, POINTERS)) add(load, line);
  for (const line of parts.always) add(rules, `- ${line}`);
  for (const line of blocks[0]?.lines ?? []) add(`### ${blocks[0]!.name}`, line);
  for (const line of parts.earlier.slice(0, EARLIER)) add(earlier, line);
  for (const block of blocks.slice(1)) for (const line of block.lines) add(`### ${block.name}`, line);
  for (const line of parts.near.slice(0, NEAR)) add(rules, `- ${line}`);
  let nowRendered = false;
  return [...kept].filter(([, lines]) => lines.length).map(([heading, lines]) => {
    const lead = heading.startsWith("###") && !nowRendered ? `${now}\n\n` : "";
    nowRendered ||= lead !== "";
    return `${lead}${heading}\n${lines.join("\n")}`;
  }).join("\n\n");
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

const vectors = new Map<string, number[]>();
/** Embeddings, kept by text hash: profile lines and now blocks change at most daily, so a brief embeds little more than
 *  its task. */
async function embedded(texts: readonly string[]): Promise<number[][]> {
  const missing = [...new Set(texts.filter(text => !vectors.has(sha256(text))))];
  if (missing.length) (await embed(missing)).forEach((vector, at) => vectors.set(sha256(missing[at]!), vector));
  return texts.map(text => vectors.get(sha256(text))!);
}
// unit vectors: the dot product is the cosine
const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, at) => sum + value * b[at]!, 0);

/** `to`: only record items dated before it (the A/B cuts the record at a past task's start); not a tool input. */
export async function brief(agent: Agent, input: BriefInput, pool: Pool, { to }: { to?: string } = {}): Promise<string> {
  const task = input.task.trim();
  const profile = readProfile(agent.scopes);
  const { day, blocks } = readNow(agent.scopes);
  const rest = profile.filter(line => !line.always);
  const matched = projectBlock(blocks, input.project);
  const candidates = matched ? [] : blocks;
  const sources = sourcesFor(agent);
  // searches get the task's opening: the reranker marked the explainer skill weak for a 1,300-character nTop request
  // and strong for its first 300 characters
  const query = task.length <= QUERY ? task : task.slice(0, task.lastIndexOf(" ", QUERY));
  const cut = to ? { to } : {};
  const [[taskVector, ...known], { skills }, skillHits, record] = await Promise.all([
    embedded([`${INSTRUCTION}${task}`, ...rest.map(line => line.text), ...candidates.map(block => [block.name, ...block.lines].join("\n"))]),
    catalog(),
    search(pool, { query, source: ["skill"], limit: POINTERS, ...cut }),
    // library cards come from this search too: a card search of their own reranked 30 more hits, a second the reranker
    // takes one after the other, and found the same cards on library tasks
    search(pool, { query, limit: 10, ...cut, ...(sources ? { source: sources.filter(source => source !== "skill") } : {}) }),
  ]);
  const lineVectors = known.slice(0, rest.length), blockVectors = known.slice(rest.length);

  const near = rest.map((line, at) => {
    const hub = lineVectors.reduce((sum, other) => sum + cosine(lineVectors[at]!, other), 0) / lineVectors.length;
    return { text: line.text, score: cosine(taskVector!, lineVectors[at]!) - hub };
  }).sort((a, b) => b.score - a.score).map(line => line.text);
  // the project's block alone; with no project, every block, nearest first, the far ones only as room allows
  const ranked = matched ? [matched] : candidates.map((block, at) => ({ block, score: cosine(taskVector!, blockVectors[at]!) })).sort((a, b) => b.score - a.score).map(each => each.block);
  const now = ranked.length ? { ...(day ? { day } : {}), blocks: ranked.map(block => ({ name: block.name, lines: block.lines })) } : undefined;

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
  return compose({ always: profile.filter(line => line.always).map(line => line.text), near, ...(now ? { now } : {}), earlier, pointers });
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
