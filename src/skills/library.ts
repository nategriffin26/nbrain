// Skills and styles: how the owner wants a kind of work done and how their things should look, as Agent Skills
// directories (agentskills.io: SKILL.md with YAML frontmatter, plus examples/, assets/, references/). Models write them
// into the brain from finished work; agents load the one that fits before that kind of work.
//   skills/<name>/  styles/<name>/   the owner's, in the context repo ($BRAIN_CONTEXT); every save is a signed commit
//   nbrain/<name>/                   built-ins shipped in this repo's skills/ (read-only): the guides for writing the others
// Our extras live in frontmatter `metadata` (a string map, per the spec): kind, default, author, source, updated.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { CONTEXT, ZONE } from "../config.js";
import { commit } from "../context/git.js";
import { ScopeError } from "../mcp/types.js";

export const KINDS = ["skill", "style"] as const;
export type Kind = (typeof KINDS)[number];
/** Each skill path's first segment and the directory it lives in. */
const ROOTS = { skills: `${CONTEXT}/skills`, styles: `${CONTEXT}/styles`, nbrain: fileURLToPath(new URL("../../skills", import.meta.url)) } as const;
type Prefix = keyof typeof ROOTS;
const PREFIXES = Object.keys(ROOTS) as Prefix[];
const OWN: Record<Kind, Prefix> = { skill: "skills", style: "styles" };

// Per-skill limits of the MCP Skills extension (SEP-2640): what every conforming host must accept.
export const MAX_FILES = 512;
export const MAX_BYTES = 16 * 1024 * 1024;
/** Agent Skills recommends a SKILL.md body under 500 lines; SkillsBench measured compact/standard skills at +19-21pp
 *  and comprehensive ones at +0.7pp (arxiv.org/pdf/2602.12670). */
export const BODY_LINES = 500;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A refusal the calling agent can act on (bad name, stale base, too big), shown to it verbatim. */
export class SkillError extends Error {}

export interface Frontmatter { name: string; description: string; metadata?: Record<string, string>; [key: string]: unknown }
export interface FileEntry { path: string; uri: string; size: number; digest: string }
export interface Entry {
  /** `skills/explainer`, `styles/dashboard`, `nbrain/write-skill` */
  path: string;
  uri: string;
  dir: string;
  kind: Kind;
  name: string;
  description: string;
  default: boolean;
  updated?: string;
  author?: string;
  files: number;
  frontmatter: Frontmatter;
}

export const digestOf = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const uriOf = (path: string, file = "SKILL.md") => `skill://${path}/${file.split("/").map(encodeURIComponent).join("/")}`;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: ZONE });
export const firstSentence = (text: string) => (/^.*?[.!?](?=\s|$)/s.exec(text.trim())?.[0] ?? text.trim()).replace(/\s+/g, " ").slice(0, 200);

export interface ParsedSkill { frontmatter: Frontmatter; body: string }

/** SKILL.md as its frontmatter (verbatim, as the YAML says) and its markdown body. */
export function parseSkill(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new SkillError("SKILL.md must start with YAML frontmatter between --- lines.");
  let frontmatter: unknown;
  try { frontmatter = YAML.parse(match[1]!); } catch (error) { throw new SkillError(`SKILL.md frontmatter is not valid YAML: ${(error as Error).message}`); }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new SkillError("SKILL.md frontmatter must be a YAML mapping.");
  return { frontmatter: frontmatter as Frontmatter, body: text.slice(match[0].length).replace(/^\s*\n/, "") };
}

/** What is wrong with a skill's frontmatter for the directory `dirName`, per the Agent Skills spec and our metadata. */
export function problems(frontmatter: Record<string, unknown>, dirName: string): string[] {
  const out: string[] = [];
  const { name, description, compatibility, metadata } = frontmatter;
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64) out.push(`name must be 1-64 lowercase letters, digits and single hyphens (not at either end); got ${JSON.stringify(name)}`);
  else if (name !== dirName) out.push(`name "${name}" must equal its directory name "${dirName}"`);
  if (typeof description !== "string" || !description.trim() || description.length > 1024) out.push("description must be 1-1024 characters: what it does and when to use it");
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) out.push("compatibility must be a string of at most 500 characters");
  if (metadata !== undefined) {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== "string")) out.push("metadata must map keys to strings (quote values like \"true\" and dates)");
    else {
      const { kind, default: isDefault } = metadata as Record<string, string>;
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) out.push(`metadata.kind must be ${KINDS.join(" or ")}`);
      if (isDefault !== undefined && isDefault !== "true" && isDefault !== "false") out.push("metadata.default must be \"true\" or \"false\"");
    }
  }
  return out;
}

/** A path inside a skill, `/`-separated, with no way out of it: no absolute paths, `..`, `.`, empty or hidden segments
 *  (hidden files are left out of manifests, so a saved one would be invisible). */
export function safeRelative(path: string): string {
  const parts = path.split("/");
  if (!path || isAbsolute(path) || /[\\\0]/.test(path) || parts.some(part => part === "" || part.startsWith("."))) throw new SkillError(`Not a file path inside a skill: ${JSON.stringify(path)} (use a relative path like examples/page.md; no "..", hidden or empty segments).`);
  return path;
}

/** Every file of the skill at `dir` (hidden files and anything not a regular file left out), by path, with digests. */
export async function manifest(path: string, dir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { const bytes = await readFile(join(dir, file)); out.push({ path: file, uri: uriOf(path, file), size: bytes.length, digest: digestOf(bytes) }); }
    }
  };
  await walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** `explainer`, `styles/dashboard`, `skill://styles/dashboard/SKILL.md` or `skill://styles/dashboard` → the skill's path and directory.
 *  A bare name is looked up in skills/, then styles/, then the built-ins. */
export async function locate(name: string): Promise<{ path: string; dir: string } | undefined> {
  const bare = name.trim().replace(/^skill:\/\//, "").replace(/\/SKILL\.md$/, "").replace(/\/+$/, "");
  const parts = bare.split("/");
  const candidates = parts.length === 1 ? PREFIXES.map(prefix => [prefix, parts[0]!] as const) : parts.length === 2 && (PREFIXES as string[]).includes(parts[0]!) ? [[parts[0] as Prefix, parts[1]!] as const] : [];
  for (const [prefix, skill] of candidates) {
    if (!NAME.test(skill)) continue;
    const dir = `${ROOTS[prefix]}/${skill}`;
    if (await isFile(`${dir}/SKILL.md`)) return { path: `${prefix}/${skill}`, dir };
  }
  return undefined;
}
const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };

/** A `skill://<prefix>/<name>/<file>` URI as its skill path and file. */
export function splitUri(uri: string): { path: string; file: string } | undefined {
  const match = /^skill:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || !(PREFIXES as string[]).includes(match[1]!)) return undefined;
  return { path: `${match[1]}/${match[2]}`, file: decodeURIComponent(match[3]!) };
}

function entryOf(path: string, dir: string, frontmatter: Frontmatter, files: number): Entry {
  const metadata = frontmatter.metadata ?? {};
  return {
    path, uri: uriOf(path), dir, kind: metadata.kind === "style" || path.startsWith("styles/") ? "style" : "skill", name: frontmatter.name, description: frontmatter.description,
    default: metadata.default === "true", ...(metadata.updated ? { updated: metadata.updated } : {}), ...(metadata.author ? { author: metadata.author } : {}), files, frontmatter,
  };
}

/** Every skill, style and built-in: frontmatter and file counts only. A directory whose SKILL.md is unreadable or
 *  invalid is listed in `problems`, not served. */
export async function catalog(): Promise<{ skills: Entry[]; problems: { path: string; problem: string }[] }> {
  const skills: Entry[] = [];
  const bad: { path: string; problem: string }[] = [];
  for (const prefix of PREFIXES) {
    let names: string[] = [];
    try { names = (await readdir(ROOTS[prefix], { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name).sort(); } catch { continue; }
    for (const name of names) {
      const path = `${prefix}/${name}`, dir = `${ROOTS[prefix]}/${name}`;
      try {
        const { frontmatter } = parseSkill(await readFile(`${dir}/SKILL.md`, "utf8"));
        const wrong = problems(frontmatter, name);
        if (wrong.length) { bad.push({ path, problem: wrong.join("; ") }); continue; }
        skills.push(entryOf(path, dir, frontmatter, (await manifest(path, dir)).length));
      } catch (error) {
        bad.push({ path, problem: error instanceof SkillError ? error.message : (error as NodeJS.ErrnoException).code === "ENOENT" ? "no SKILL.md" : String(error) });
      }
    }
  }
  return { skills, problems: bad };
}

/** One skill: its entry, body and every file with its digest. */
export async function getSkill(name: string): Promise<{ entry: Entry; body: string; files: FileEntry[] }> {
  const found = await locate(name);
  if (!found) throw new SkillError(`No skill or style "${name}". Call skill_get with no name for the catalog.`);
  const { frontmatter, body } = parseSkill(await readFile(`${found.dir}/SKILL.md`, "utf8"));
  const wrong = problems(frontmatter, basename(found.dir));
  if (wrong.length) throw new SkillError(`${found.path}/SKILL.md is invalid: ${wrong.join("; ")}`);
  const files = await manifest(found.path, found.dir);
  return { entry: entryOf(found.path, found.dir, frontmatter, files.length), body, files };
}

const TYPES: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json", yaml: "application/yaml", yml: "application/yaml",
  html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", py: "text/x-python", sh: "text/x-shellscript", csv: "text/csv",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};
const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** Text when the bytes are UTF-8 without NULs; else binary. */
export function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return UTF8.decode(bytes); } catch { return undefined; }
}
export const mimeOf = (file: string, text: boolean) => TYPES[file.split(".").pop()!.toLowerCase()] ?? (text ? "text/plain" : "application/octet-stream");

/** One file of a skill, its bytes and manifest entry. */
export async function readSkillFile(name: string, file: string): Promise<{ path: string; local: string; bytes: Buffer; entry: FileEntry; mimeType: string; text?: string }> {
  const found = await locate(name);
  if (!found) throw new SkillError(`No skill or style "${name}".`);
  const rel = safeRelative(file);
  const local = `${found.dir}/${rel}`;
  if (!(await isFile(local))) throw new SkillError(`${found.path} has no file ${rel}. Its manifest (skill_get with just the name) lists every file.`);
  const bytes = await readFile(local);
  const text = textOf(bytes);
  return { path: found.path, local, bytes, entry: { path: rel, uri: uriOf(found.path, rel), size: bytes.length, digest: digestOf(bytes) }, mimeType: mimeOf(rel, text !== undefined), ...(text !== undefined ? { text } : {}) };
}

/** Text in pages of `size` characters, each ending at a line break where one falls in its second half. */
export function pageOf(text: string, page = 0, size = 32 * 1024): { text: string; page: number; pages: number } {
  const starts = [0];
  for (let start = 0; text.length - start > size; ) {
    const cut = text.lastIndexOf("\n", start + size);
    start = cut > start + size / 2 ? cut + 1 : start + size;
    starts.push(start);
  }
  if (!Number.isInteger(page) || page < 0 || page >= starts.length) throw new SkillError(`page ${page} is out of range: ${starts.length} page${starts.length === 1 ? "" : "s"} (0-based).`);
  return { text: text.slice(starts[page], starts[page + 1]), page, pages: starts.length };
}

export interface SaveFile { path: string; content?: string; base64?: string; from?: string }
export interface SaveInput { name: string; kind: Kind; description: string; body: string; default?: boolean; source?: string; base?: string; files?: SaveFile[]; remove?: string[] }
export interface Saved { path: string; uri: string; dir: string; created: boolean; commit?: string; files: FileEntry[]; warnings: string[] }

// one save at a time per skill, so a base check and the write it guards cannot interleave with another save
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.then(work, work);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

/**
 * Create or update one of the owner's skills or styles and commit it as `signer`. An update must name the digest of the
 * SKILL.md it read (`base`): a save never overwrites what its writer has not seen, and writers merge into the current
 * body instead of rewriting from memory (ACE measured one whole rewrite collapsing 18,282 tokens of context to 122).
 * `from` copies a file from this machine and is for `local` callers only.
 */
export async function saveSkill(input: SaveInput, signer: string, local: boolean): Promise<Saved> {
  if (!NAME.test(input.name) || input.name.length > 64) throw new SkillError(`name must be 1-64 lowercase letters, digits and single hyphens; got ${JSON.stringify(input.name)}.`);
  if (!(KINDS as readonly string[]).includes(input.kind)) throw new SkillError(`kind must be ${KINDS.join(" or ")}.`);
  const path = `${OWN[input.kind]}/${input.name}`;
  const dir = `${ROOTS[OWN[input.kind]]}/${input.name}`;
  return serial(path, async () => {
    const current = await readFile(`${dir}/SKILL.md`).catch(() => undefined);
    if (current && !input.base) throw new SkillError(`${path} exists. Read it first (skill_get {"name":"${path}"}), merge your change into its body, and pass its digest as base.`);
    if (current && input.base !== digestOf(current)) throw new SkillError(`${path} changed since you read it (base ${input.base}, now ${digestOf(current)}). Read it again with skill_get, merge your change into the current body, and save with the new digest as base.`);
    if (!current && input.base) throw new SkillError(`${path} does not exist, so there is nothing for base to match. Check name and kind (a style lives under styles/), or leave base out to create it.`);

    const old = current ? parseSkill(current.toString("utf8")).frontmatter : undefined;
    const { name: _name, description: _description, metadata: oldMetadata, ...rest } = old ?? ({} as Partial<Frontmatter>);
    const metadata: Record<string, string> = { ...oldMetadata, kind: input.kind, author: signer, updated: today() };
    if (input.source !== undefined) metadata.source = input.source;
    if (input.default === true) metadata.default = "true";
    else if (input.default === false) delete metadata.default;
    const frontmatter: Frontmatter = { name: input.name, description: input.description.trim(), ...rest, metadata };
    const wrong = problems(frontmatter, input.name);
    if (wrong.length) throw new SkillError(wrong.join("; "));
    const body = input.body.trim();
    if (/^---\r?\n/.test(body)) throw new SkillError("body is the markdown after the frontmatter: give name, description, default and source as their own fields.");
    const skillMd = Buffer.from(`---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`);

    // what the save writes and removes, checked whole before anything touches the disk
    const writes = new Map<string, Buffer>();
    for (const file of input.files ?? []) {
      const rel = safeRelative(file.path);
      if (rel === "SKILL.md") throw new SkillError("SKILL.md is written from description and body; files are its supporting files.");
      const given = [file.content, file.base64, file.from].filter(value => value !== undefined).length;
      if (given !== 1) throw new SkillError(`${rel}: give exactly one of content (text), base64 or from (a local path).`);
      if (file.from !== undefined) {
        if (!local) throw new ScopeError(`${rel}: from reads a path on the brain's machine, which only a local agent may give; send the file as content or base64.`);
        if (!isAbsolute(file.from)) throw new SkillError(`${rel}: from must be an absolute path.`);
        writes.set(rel, await readFile(file.from).catch(() => { throw new SkillError(`${rel}: cannot read ${file.from}.`); }));
      } else writes.set(rel, file.content !== undefined ? Buffer.from(file.content) : Buffer.from(file.base64!, "base64"));
    }
    const before = current ? await manifest(path, dir) : [];
    const removes = (input.remove ?? []).map(safeRelative);
    for (const rel of removes) {
      if (rel === "SKILL.md") throw new SkillError("SKILL.md cannot be removed.");
      if (!before.some(file => file.path === rel)) throw new SkillError(`${path} has no file ${rel} to remove.`);
    }
    const after = new Map(before.map(file => [file.path, file.size]));
    for (const rel of removes) after.delete(rel);
    for (const [rel, bytes] of writes) after.set(rel, bytes.length);
    after.set("SKILL.md", skillMd.length);
    const total = [...after.values()].reduce((sum, size) => sum + size, 0);
    if (after.size > MAX_FILES) throw new SkillError(`${path} would have ${after.size} files; a skill holds at most ${MAX_FILES}.`);
    if (total > MAX_BYTES) throw new SkillError(`${path} would be ${total} bytes; a skill holds at most ${MAX_BYTES} (16 MiB).`);

    for (const rel of removes) {
      await rm(`${dir}/${rel}`);
      for (let parent = dirname(rel); parent !== "."; parent = dirname(parent)) { try { await rmdir(`${dir}/${parent}`); } catch { break; } }
    }
    for (const [rel, bytes] of writes) { await mkdir(dirname(`${dir}/${rel}`), { recursive: true }); await writeFile(`${dir}/${rel}`, bytes); }
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/SKILL.md`, skillMd);

    const lines = body.split("\n").length;
    const warnings = lines > BODY_LINES ? [`SKILL.md body is ${lines} lines; keep it under ${BODY_LINES} and move detail into references/ (compact skills beat comprehensive ones).`] : [];
    const id = await commit([path], `${input.kind} ${input.name}: ${current ? "updated" : "created"} by ${signer}`, signer);
    return { path, uri: uriOf(path), dir, created: !current, ...(id ? { commit: id } : {}), files: await manifest(path, dir), warnings };
  });
}

/** Validate a skill directory as a host would load it: frontmatter, name, limits and the body-length guidance. */
export async function checkDir(dir: string): Promise<{ problems: string[]; warnings: string[]; files: number; bytes: number; frontmatter?: Frontmatter }> {
  let text: string;
  try { text = await readFile(`${dir}/SKILL.md`, "utf8"); } catch { return { problems: [`no SKILL.md in ${dir}`], warnings: [], files: 0, bytes: 0 }; }
  let parsed: ParsedSkill;
  try { parsed = parseSkill(text); } catch (error) { return { problems: [(error as Error).message], warnings: [], files: 0, bytes: 0 }; }
  const files = await manifest(basename(dir), dir);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const found = problems(parsed.frontmatter, basename(dir));
  if (files.length > MAX_FILES) found.push(`${files.length} files; a skill holds at most ${MAX_FILES}`);
  if (bytes > MAX_BYTES) found.push(`${bytes} bytes; a skill holds at most ${MAX_BYTES}`);
  const lines = parsed.body.trimEnd().split("\n").length;
  return { problems: found, warnings: lines > BODY_LINES ? [`body is ${lines} lines; keep SKILL.md under ${BODY_LINES} and move detail into references/`] : [], files: files.length, bytes, frontmatter: parsed.frontmatter };
}
