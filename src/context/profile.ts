// The profile and now files in the context repo ($BRAIN_CONTEXT): their format, and how the brief, fetch and the curator
// take them apart. One format, shared, so the curator writes exactly what the brief reads.
//
// Profile files (PROFILE_FILES): markdown with `# Title` and `## Section` headings and one statement per `- ` line, each
// ending in where it came from and when: `- Plain words, outcome first. <!-- omp:abc123#4 2026-10-22 -->`. The source is
// an item id (the owner's words in a chat, session or note), correction:<id>, or owner (written by hand); several are
// comma-separated. A line with no comment is the owner's own. Lines under a `## Always` heading are in every brief of the
// file's scope; the rest are picked by how near they are to the task. life.md is life scope, every other file work scope.
// Closed lines are never deleted: they move to closed.md as `- <text> <!-- closed <day> by <source>: <reason>; was <source> <day> -->`.
//
// now.md: rewritten whole each day (now.ts), never edited by hand: `# Now · <day>`, then one `## <name>` block per
// project, desk or area, the directories and names it answers to in `<!-- dirs: ~/Projects/nbrain, nbrain -->` right
// under its heading, then `- ` lines. The block named Life is life scope.
import { readFileSync } from "node:fs";
import { CONTEXT } from "../config.js";
import type { Scope } from "../mcp/types.js";

export const PROFILE_FILES = [
  { file: "basics.md", scope: "work" },
  { file: "work-style.md", scope: "work" },
  { file: "principles.md", scope: "work" },
  { file: "tastes.md", scope: "work" },
  { file: "goals.md", scope: "work" },
  { file: "projects.md", scope: "work" },
  { file: "outputs.md", scope: "work" },
  { file: "life.md", scope: "life" },
] as const satisfies readonly { file: string; scope: Scope }[];
export const CLOSED_FILE = "closed.md";
export const NOW_FILE = "now.md";
export const ALWAYS = "Always";

export interface ProfileLine {
  file: string;
  /** The `## ` heading it sits under ("" before the first). */
  section: string;
  text: string;
  /** Item ids, correction:<id> or owner. */
  sources: string[];
  day?: string;
  always: boolean;
  /** 1-based line number in its file. */
  line: number;
}

const SOURCE = /\s*<!--\s*(.*?)\s*-->\s*$/;

/** One profile line as written: the statement, then its sources and day. */
export function formatLine(text: string, sources: readonly string[], day: string): string {
  return `- ${text.replace(/\s+/g, " ").replace(/<!--|-->/g, "").trim()} <!-- ${sources.join(", ")} ${day} -->`;
}

/** The statements of one profile file, in order. */
export function parseProfile(file: string, text: string): ProfileLine[] {
  const lines: ProfileLine[] = [];
  let section = "";
  for (const [index, raw] of text.split("\n").entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) { section = heading[1]!; continue; }
    if (!/^\s*[-*]\s+\S/.test(raw)) continue;
    const comment = SOURCE.exec(raw)?.[1];
    const body = raw.replace(SOURCE, "").replace(/^\s*[-*]\s+/, "").trim();
    let sources = ["owner"], day: string | undefined;
    if (comment) {
      const at = /(\d{4}-\d{2}-\d{2})$/.exec(comment);
      day = at?.[1];
      const ids = (at ? comment.slice(0, at.index) : comment).split(",").map(each => each.trim()).filter(Boolean);
      if (ids.length) sources = ids;
    }
    lines.push({ file, section, text: body, sources, ...(day ? { day } : {}), always: section === ALWAYS, line: index + 1 });
  }
  return lines;
}

const read = (name: string) => { try { return readFileSync(`${CONTEXT}/${name}`, "utf8"); } catch { return ""; } };

/** The profile files a caller with `scopes` may read, with their text. */
export function profileFiles(scopes: readonly Scope[]): { file: string; text: string }[] {
  return PROFILE_FILES.filter(each => scopes.includes(each.scope)).map(({ file }) => ({ file, text: read(file) })).filter(each => each.text.trim() !== "");
}

/** Every statement a caller with `scopes` may read. */
export function readProfile(scopes: readonly Scope[]): ProfileLine[] {
  return profileFiles(scopes).flatMap(({ file, text }) => parseProfile(file, text));
}

/** Markdown without its source comments, for a reader who needs the statements only. */
export const stripSources = (markdown: string) => markdown.replace(/[ \t]*<!--[\s\S]*?-->/g, "");

export interface NowBlock { name: string; dirs: string[]; lines: string[]; life: boolean }

export function parseNow(text: string): { day?: string; blocks: NowBlock[] } {
  const day = /^#\s+Now\s*·\s*(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1];
  const blocks: NowBlock[] = [];
  for (const raw of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) { blocks.push({ name: heading[1]!, dirs: [], lines: [], life: heading[1]!.toLowerCase() === "life" }); continue; }
    const block = blocks.at(-1);
    if (!block) continue;
    const dirs = /^<!--\s*dirs:\s*(.*?)\s*-->$/.exec(raw.trim());
    if (dirs) block.dirs = dirs[1]!.split(",").map(each => each.trim()).filter(Boolean);
    else if (/^\s*[-*]\s+\S/.test(raw)) block.lines.push(raw.trim());
  }
  return { ...(day ? { day } : {}), blocks };
}

/** now.md's blocks a caller with `scopes` may read: Life needs life scope, the rest work scope. */
export function readNow(scopes: readonly Scope[]): { day?: string; blocks: NowBlock[] } {
  const now = parseNow(read(NOW_FILE));
  return { ...now, blocks: now.blocks.filter(block => scopes.includes(block.life ? "life" : "work")) };
}
