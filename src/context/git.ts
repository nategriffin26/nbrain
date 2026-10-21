// The curated layer ($BRAIN_CONTEXT) is a git repo: every change an agent or the gardener makes there is its own commit,
// signed with who made it, so `git log -p` is the audit trail and any change reverts. Two processes commit here (memory-mcp
// for skills and styles, ingest for the gardener) on different paths; a commit that meets the other's index lock waits.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { CONTEXT } from "../config.js";

const run = promisify(execFile);
async function git(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try { return (await run("git", ["-C", CONTEXT, ...args], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(`git ${args[0]}: ${(error as { stderr?: string }).stderr?.trim() || String(error)}`); }
}

/** Make the context directory a repo if it is not one yet. */
export async function ensureRepo(): Promise<void> {
  if (!existsSync(`${CONTEXT}/.git`)) await git(["init", "--quiet"]);
}

/** Commit `paths` (added, changed or deleted) as `author`; answers the commit id, or undefined when nothing changed. */
export async function commit(paths: readonly string[], message: string, author: string): Promise<string | undefined> {
  await ensureRepo();
  const who = { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@nbrain.local`, GIT_COMMITTER_NAME: "nbrain", GIT_COMMITTER_EMAIL: "nbrain@nbrain.local" };
  for (let attempt = 0; ; attempt++) {
    try {
      await git(["add", "--all", "--", ...paths]);
      if (!(await git(["status", "--porcelain", "--", ...paths]))) return undefined;
      await git(["commit", "--quiet", "--no-verify", "-m", message, "--", ...paths], who);
      return await git(["rev-parse", "--short", "HEAD"]);
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("index.lock")) throw error;
      await sleep(250);
    }
  }
}

/** The commits that touched `path` since `since` (git date syntax), newest first: "abc1234 2026-10-21 omp: message". */
export async function history(path: string, since?: string): Promise<string[]> {
  if (!existsSync(`${CONTEXT}/.git`)) return [];
  const out = await git(["log", "--format=%h %ad %an: %s", "--date=short", ...(since ? [`--since=${since}`] : []), "--", path]);
  return out ? out.split("\n") : [];
}
