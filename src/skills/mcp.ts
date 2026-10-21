// Skills and styles over MCP, four ways, because hosts differ in what they read (no host consumes the Skills extension yet):
// - tools skill_get / skill_save, which every host can call;
// - every skill file as a skill:// resource (resources/list shows each SKILL.md; the template reads any file);
// - the MCP Skills extension (io.modelcontextprotocol/skills, SEP-2640): skills/list and skills/get with digest manifests;
// - a short catalog in the server instructions and the top matches in context_get.
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { MCP_TOOLS } from "../mcp/contract.js";
import { type Agent, type Call, has, type Tool } from "../mcp/types.js";
import type { SearchInput, SearchResult } from "../memory/search.js";
import { catalog, type Entry, firstSentence, getSkill, manifest, pageOf, readSkillFile, type SaveInput, saveSkill, SkillError, splitUri } from "./library.js";

/** MCP image content is base64 inline; past this an image is described, not sent. */
const IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXTENSION = "io.modelcontextprotocol/skills";
const LIST_PAGE = 50;
/** Skills sit behind a token, so caches keep them per authorization ("private"); a minute keeps a fresh save visible. */
const CACHE = { ttlMs: 60_000, cacheScope: "private" } as const;
const INSTRUCTION_CHARS = 1500;

const reads = (agent: Agent) => has(agent, "work") || has(agent, "life");
const label = (entry: Entry) => `${entry.path} (${entry.kind}${entry.default ? `, the default when no ${entry.kind} is named` : ""})`;

/** A refusal the agent can act on comes back as its message; anything else is the server's failure. */
async function answer(work: () => Promise<unknown>): Promise<unknown> {
  try { return await work(); }
  catch (error) { if (error instanceof SkillError) return { isError: true, content: [{ type: "text", text: error.message }] }; throw error; }
}

async function fileOf(call: Call, name: string, file: string, page: number | undefined) {
  const found = await readSkillFile(name, file);
  const meta = { skill: found.path, path: found.entry.path, uri: found.entry.uri, size: found.entry.size, digest: found.entry.digest, mimeType: found.mimeType, ...(call.local ? { local: found.local } : {}) };
  if (found.text !== undefined) { const part = pageOf(found.text, page); return { ...meta, page: part.page, pages: part.pages, text: part.text }; }
  if (IMAGES.has(found.mimeType) && found.bytes.length <= IMAGE_BYTES) return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", data: found.bytes.toString("base64"), mimeType: found.mimeType }] };
  return { ...meta, binary: true, note: call.local ? "Binary: open it at local." : "Binary: not sent over MCP." };
}

async function get(call: Call, args: Record<string, unknown>) {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const page = typeof args.page === "number" ? args.page : undefined;
  if (!name) {
    const { skills, problems } = await catalog();
    return {
      skills: skills.map(entry => ({ path: entry.path, kind: entry.kind, name: entry.name, description: entry.description, default: entry.default, updated: entry.updated, author: entry.author, files: entry.files })),
      ...(problems.length ? { problems } : {}),
      load: 'skill_get {"name":"<path>"} loads one; at most 1-3 per task.',
    };
  }
  if (typeof args.file === "string" && args.file) return fileOf(call, name, args.file, page);
  const { entry, body, files } = await getSkill(name);
  const part = pageOf(body, page);
  return {
    path: entry.path, uri: entry.uri, kind: entry.kind, frontmatter: entry.frontmatter, body: part.text, ...(part.pages > 1 ? { page: part.page, pages: part.pages } : {}),
    files, ...(call.local ? { dir: entry.dir } : {}),
    open: 'skill_get {"name":"' + entry.path + '","file":"<path>"} opens a file; references in the body are relative to the skill.',
  };
}

async function save(call: Call, args: Record<string, unknown>) {
  const saved = await saveSkill(args as unknown as SaveInput, call.agent.signer, call.local);
  return { uri: saved.uri, name: saved.path, ...(call.local ? { path: saved.dir } : {}), created: saved.created, commit: saved.commit ?? null, files: saved.files, warnings: saved.warnings };
}

export const SKILL_TOOLS: Record<string, Tool> = {
  skill_get: { ...MCP_TOOLS.skill_get, scopes: ["work", "life"], run: (call, args) => answer(() => get(call, args)) },
  skill_save: { ...MCP_TOOLS.skill_save, scopes: ["write"], write: true, run: (call, args) => answer(() => save(call, args)) },
};

/** One skill file as resources/read contents: text, or base64 blob. */
async function readResource(uri: string) {
  const at = splitUri(uri);
  if (!at) throw new McpError(ErrorCode.InvalidParams, `Not a skill file: ${uri}`);
  try {
    const found = await readSkillFile(at.path, at.file);
    return { contents: [found.text !== undefined ? { uri, mimeType: found.mimeType, text: found.text } : { uri, mimeType: found.mimeType, blob: found.bytes.toString("base64") }] };
  } catch (error) {
    if (error instanceof SkillError) throw new McpError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}

/** The extension's Skill entry: the SKILL.md URI, its frontmatter verbatim, and every file with digest and size. */
async function skillEntry(entry: Entry) {
  return { uri: entry.uri, frontmatter: entry.frontmatter, resources: (await manifest(entry.path, entry.dir)).map(({ uri, digest, size }) => ({ uri, digest, size })) };
}

// SDK 1.30 has no typed Skills API (typescript-sdk PR #2818), so the two methods get hand-written schemas
const ListSkillsRequest = z.object({ method: z.literal("skills/list"), params: z.object({ cursor: z.string().optional() }).loose().optional() });
const GetSkillRequest = z.object({ method: z.literal("skills/get"), params: z.object({ uri: z.string() }).loose() });

/** skill:// resources and the Skills extension, for tokens that may read skills. Call before the server connects. */
export function registerSkills(server: McpServer, agent: Agent): void {
  if (!reads(agent)) return;
  server.registerResource("skill-files", new ResourceTemplate("skill://{+path}", {
    list: async () => ({ resources: (await catalog()).skills.map(entry => ({ uri: entry.uri, name: entry.name, title: label(entry), description: entry.description, mimeType: "text/markdown" })) }),
  }), { title: "Skill and style files", description: "Every file of a skill or style: skill://<skills|styles|nbrain>/<name>/<file>; relative references in a SKILL.md resolve against its directory" }, uri => readResource(uri.href));
  server.server.registerCapabilities({ extensions: { [EXTENSION]: {} } });
  server.server.setRequestHandler(ListSkillsRequest, async request => {
    const cursor = request.params?.cursor;
    const start = cursor === undefined ? 0 : Number(cursor);
    const { skills } = await catalog();
    if (!Number.isInteger(start) || start < 0 || start > skills.length) throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${cursor}`);
    const page = skills.slice(start, start + LIST_PAGE);
    return { resultType: "complete", skills: await Promise.all(page.map(skillEntry)), ...(start + LIST_PAGE < skills.length ? { nextCursor: String(start + LIST_PAGE) } : {}), ...CACHE };
  });
  server.server.setRequestHandler(GetSkillRequest, async request => {
    const at = splitUri(request.params.uri);
    const entry = at?.file === "SKILL.md" ? (await catalog()).skills.find(each => each.path === at.path) : undefined;
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Not a skill this server serves: ${request.params.uri}`);
    return { resultType: "complete", skill: await skillEntry(entry), ...CACHE };
  });
}

/** The catalog for the server instructions, so hosts that show them know what exists; names only past ~1.5 KB. */
export async function skillsInstructions(agent: Agent): Promise<string> {
  if (!reads(agent)) return "";
  const { skills } = await catalog();
  if (!skills.length) return "";
  let text = "\n\nSkills and styles: before work one covers, load it with skill_get (or resources/read of its skill:// URI) and follow it; 1-3 per task.";
  const rest: string[] = [];
  for (const entry of skills) {
    const line = `\n- ${label(entry)}: ${firstSentence(entry.description)}`;
    if (rest.length || text.length + line.length > INSTRUCTION_CHARS) rest.push(entry.path);
    else text += line;
  }
  return rest.length ? `${text}\n- Also: ${rest.join(", ")}` : text;
}

/** context_get's `## Skills and styles for this`: the 3 that best match the topic (memory search over source skill), then
 *  the defaults, each with how to load it. */
export async function skillsSection(agent: Agent, topic: string | undefined, find: (input: SearchInput) => Promise<SearchResult>): Promise<string> {
  if (!reads(agent)) return "";
  const { skills } = await catalog();
  const byId = new Map(skills.map(entry => [`skill:${entry.path}`, entry]));
  let top: Entry[] = [];
  if (topic) {
    try { top = (await find({ query: topic, source: ["skill"], limit: 3 })).hits.flatMap(hit => byId.get(hit.id) ?? []); }
    catch { /* search is a bonus here; the defaults still show */ }
  }
  const shown = [...top, ...skills.filter(entry => entry.default && !top.includes(entry))];
  if (!shown.length) return "";
  return `## Skills and styles for this\nLoad the one that fits before that work (skill_get {"name":"<path>"}) and follow it.\n${shown.map(entry => `- ${label(entry)}: ${firstSentence(entry.description)}`).join("\n")}`;
}
