// The Sunday message (09:00 local, once a week): the week's profile changes, each with the id that takes it back, the
// library digest, and a short checkup, sent to the owner through notify. Plain lines a phone shows whole.
import { readdir, readFile } from "node:fs/promises";
import pg, { type Pool } from "pg";
import * as z from "zod";
import { ASSISTANT, BRAIN_HOME, OWNER, ZONE } from "./config.js";
import { git } from "./context/git.js";
import { NOT_PRIVATE } from "./curator.js";
import { cursorOk, readCursor } from "./events/store.js";
import { CARD_SOURCES } from "./library/cards.js";
import { libraryDigest } from "./library/digest.js";
import { judge } from "./memory/search.js";
import { embed } from "./memory/store.js";
import { notify } from "./notify.js";
import { localTime } from "./time.js";
import { workersAiSet } from "./workers-ai.js";

const DAY = 86_400_000;
const CURSOR = "weekly";
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric" });

/** The curator's and the corrections' commits in the context repo since `since`, newest first, in plain words. */
async function profileChanges(since: Date): Promise<string[]> {
  const log = await git(["log", `--since=${since.toISOString()}`, "--format=%h%x09%an%x09%s"]).catch(() => "");
  return log.split("\n").filter(Boolean).flatMap(line => {
    const [id, author, subject] = line.split("\t") as [string, string, string];
    const curator = /^curator: (add|close) ([\w-]+)\.md: (.*?)(?: \([^()]*\))?$/.exec(subject);
    if (curator) return [`- ${curator[1] === "add" ? "Added to" : "Closed in"} ${curator[2]}: ${curator[3]} · ${id}`];
    const correction = /^correction \d+: (.*)$/.exec(subject);
    if (!correction) return [];
    const undone = /^undo ([0-9a-f]+)$/.exec(correction[1]!);
    return [`- ${undone ? `Took back ${undone[1]}` : correction[1]} (asked by ${author}) · ${id}`];
  });
}

/** The recall eval's latest score beside the one a week before it, and how many questions with no answer got nothing
 *  strong, from $BRAIN_HOME/eval/recall-<time>.json. */
export async function recallLine(): Promise<string | undefined> {
  const names = (await readdir(`${BRAIN_HOME}/eval`).catch(() => [] as string[])).filter(name => /^recall-\d{4}-\d{2}-\d{2}/.test(name)).sort();
  const Run = z.object({ summary: z.object({ ok: z.number(), n: z.number(), abstain: z.object({ ok: z.number(), n: z.number() }).optional() }) });
  const runs = await Promise.all(names.map(async name => ({
    at: Date.parse(`${name.slice(7, 17)}T12:00:00Z`),
    summary: Run.parse(JSON.parse(await readFile(`${BRAIN_HOME}/eval/${name}`, "utf8"))).summary,
  })));
  const latest = runs.at(-1);
  if (!latest) return undefined;
  const before = runs.filter(run => run.at <= latest.at - 6 * DAY).at(-1);
  const abstain = latest.summary.abstain;
  return `- Recall: ${latest.summary.ok} of ${latest.summary.n} found on ${shortDay(latest.at)}${before ? `, ${before.summary.ok} of ${before.summary.n} the week before` : ""}.${abstain ? ` ${abstain.ok} of ${abstain.n} questions with no answer got nothing strong.` : ""}`;
}

/** Why search's two models failed a one-line call, nothing when they answered: the judge on Workers AI (not set is a
 *  failure too), the embeddings on Ollama. */
export async function modelsCheck(): Promise<{ judge?: string; embeddings?: string }> {
  const why = (error: unknown): string => {
    // fetch hides why behind "fetch failed": its cause says refused, unknown host or bad port
    const cause = error instanceof Error ? error.cause : undefined;
    const detail = cause instanceof Error ? "code" in cause && typeof cause.code === "string" ? cause.code : cause.message : undefined;
    return (detail ?? (error instanceof Error ? error.message : String(error))).slice(0, 120);
  };
  const [judged, embedded] = await Promise.all([
    workersAiSet() ? judge("checkup", ["checkup"]).then(() => undefined, why) : "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN not set",
    embed(["checkup"]).then(() => undefined, why),
  ]);
  return { ...(judged ? { judge: judged } : {}), ...(embedded ? { embeddings: embedded } : {}) };
}

/** Without the judge search still answers, on fused rank alone, and nothing else says so; without embeddings search and
 *  the brief run without meaning, and nothing new is indexed. */
export async function modelsLine(): Promise<string> {
  const failed = await modelsCheck();
  if (!failed.judge && !failed.embeddings) return "- Search judge and embeddings answered.";
  return [
    ...(failed.judge ? [`- Search judge did not answer (${failed.judge}): search is running without it.`] : []),
    ...(failed.embeddings ? [`- Ollama's embeddings did not answer (${failed.embeddings}): search is running without meaning, and nothing new is indexed.`] : []),
  ].join("\n");
}

/** The week's message, as the owner reads it. */
export async function weeklyMessage(pool: Pool, now = new Date()): Promise<string> {
  const changes = await profileChanges(new Date(now.getTime() - 7 * DAY));
  const connectors = (process.env.CONNECTORS ?? "").split(",").map(name => name.trim()).filter(Boolean);
  const { rows: cursors } = await pool.query<{ source: string; last_ok_at: Date | null; last_error: string | null }>(
    "SELECT source, last_ok_at, last_error FROM brain.cursors WHERE source = ANY($1)", [connectors]);
  const stale = connectors.flatMap(name => {
    const row = cursors.find(each => each.source === name);
    const age = row?.last_ok_at ? now.getTime() - row.last_ok_at.getTime() : Infinity;
    if (age < DAY && !row?.last_error) return [];
    return [`${name} ${row?.last_ok_at ? `last read ${shortDay(row.last_ok_at.getTime())}` : "never read"}${row?.last_error ? ` (${row.last_error.slice(0, 80)})` : ""}`];
  });
  const { rows: [backlog] } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM memory.items i WHERE i.source = ANY($1) AND ${NOT_PRIVATE}
       AND NOT EXISTS (SELECT 1 FROM memory.cards c WHERE c.item_id = i.id) AND NOT EXISTS (SELECT 1 FROM memory.uncarded u WHERE u.item_id = i.id)`, [CARD_SOURCES]);
  const [score, models] = await Promise.all([recallLine(), modelsLine()]);
  return [
    `Your brain this week, ${shortDay(now.getTime())}`,
    ["Profile changes", ...(changes.length ? [...changes, `To take one back, tell ${ASSISTANT} "undo <id>".`] : ["None this week."])].join("\n"),
    ["Library", (await libraryDigest(pool, now)).trim()].join("\n"),
    ["Checkup",
      ...(score ? [score] : []),
      stale.length ? `- Connectors behind: ${stale.join("; ")}.` : "- Every connector read in the last day.",
      models,
      ...(backlog!.n ? [`- ${backlog!.n} bookmarks and saves still to card.`] : []),
    ].join("\n"),
  ].join("\n\n");
}

/** The loop's tick: sends the message once a week, at the first tick from 09:00 on Sunday. With BRAIN_NOTIFY unset the
 *  message goes to the log instead, once, and the week counts as done. */
export async function weeklyTick(pool: Pool, now = new Date()): Promise<boolean> {
  const local = localTime(now.getTime());
  const sunday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay() === 0;
  if (!sunday || local.slice(11, 16) < "09:00" || (await readCursor(pool, CURSOR)) === local.slice(0, 10)) return false;
  if (process.env.BRAIN_NOTIFY?.trim()) await sendWeekly(pool, now);
  else console.log(`weekly: BRAIN_NOTIFY is not set, so this week's message is here instead of sent:\n${await weeklyMessage(pool, now)}`);
  await cursorOk(pool, CURSOR, local.slice(0, 10));
  return true;
}

/** Send the week's message; the assistant's channel is asked to pass it on as written. */
export async function sendWeekly(pool: Pool, now = new Date()): Promise<void> {
  await notify(`${ASSISTANT}: please pass this to ${OWNER.name} word for word.\n\n${await weeklyMessage(pool, now)}`);
}

/** `weekly [--send]`: print this week's message (or send it now). */
export async function weeklyCommand(args: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    if (args.includes("--send")) await sendWeekly(pool);
    else console.log(await weeklyMessage(pool));
  } finally {
    await pool.end();
  }
}
