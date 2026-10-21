// Retrieval eval: asks memory search (as memory_search does: every source, reranked, 10 hits) each question of a
// question file and checks whether every expected fact is in the hits. A miss names where it was lost: the items holding
// the answer (expected ids, the current notes descended from an expected note, items quoting its rarest fact) never
// reached a channel ("candidates"), sat below the hits ("fused N"), or were shown without the fact ("quote").
// The question file and results are the owner's (BRAIN_HOME/eval); results land beside it as recall-<date>.json (Helm
// lists them), the score on the `eval` cursor and as a line in that day's journal, where context_get and a weekly review
// read it. ingest runs it weekly (evalWeekly); `nbrain eval [questions.json]` runs it now.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import pg, { type Pool } from "pg";
import { BRAIN_HOME } from "../config.js";
import { cursorFailed, cursorOk, readCursor } from "../events/store.js";
import { noteInJournal } from "../garden.js";
import { renderHits, search } from "../memory/search.js";
import { localTime } from "../time.js";

export interface Question { id: string; category: string; set?: string; query: string; expected?: string[]; facts?: string[]; absent?: boolean }
export interface Result { id: string; category: string; set: string; ok: boolean; stage: string; missing: string[]; gold: string[]; top: string[]; ms: number }

const normal = (text: string) => text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9$@+.']+/g, " ").trim();

/** Items holding the answer: expected ids in memory, current notes descended from an expected note, items quoting the rarest fact. */
async function goldOf(pool: pg.Pool, question: Question): Promise<string[]> {
  const expected = (question.expected ?? []).map(id => id.replace(/#\d+$/, ""));
  const { rows: items } = await pool.query<{ id: string }>("SELECT id FROM memory.items WHERE id = ANY($1)", [expected]);
  const { rows: notes } = await pool.query<{ id: string }>(
    `WITH RECURSIVE chain AS (SELECT id, replaced_by FROM memory.notes WHERE sources && $1::text[]
       UNION SELECT n.id, n.replaced_by FROM memory.notes n JOIN chain c ON n.id = c.replaced_by OR n.kept_from = c.id)
     SELECT DISTINCT 'memory:' || id AS id FROM chain WHERE replaced_by IS NULL`, [expected]);
  const rarest = [...(question.facts ?? [])].sort((a, b) => b.length - a.length)[0];
  const { rows: quoting } = rarest && rarest.length >= 8
    ? await pool.query<{ item_id: string }>("SELECT DISTINCT item_id FROM memory.chunks c WHERE c.text ### $1::text AND c.text ILIKE $2 LIMIT 20", [rarest, `%${rarest}%`])
    : { rows: [] };
  return [...new Set([...items.map(row => row.id), ...notes.map(row => row.id), ...quoting.map(row => row.item_id)])];
}

/** Whether memory still holds `fact` word for word, as the eval checks hits: chunks with all of its words (BM25), then
 *  the normalised phrase; else an item's sender, recipients, title or link (a phone number shows only there), or a
 *  person page (memory_person's emails and aliases). A fact held nowhere cannot be found by any search: its question
 *  needs updating. */
async function held(pool: pg.Pool, fact: string): Promise<boolean> {
  const { rows } = await pool.query<{ text: string }>(
    "SELECT c.heading || ' ' || coalesce(c.context, '') || ' ' || c.text AS text FROM memory.chunks c WHERE (c.heading &&& $1::text OR c.context &&& $1::text OR c.text &&& $1::text) ORDER BY pdb.score(c.id) DESC LIMIT 200", [fact]);
  const want = normal(fact);
  if (rows.some(row => normal(row.text).includes(want))) return true;
  const like = `%${fact.replace(/[\\%_]/g, "\\$&")}%`;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM memory.items WHERE concat_ws(' ', sender, sender_name, recipients::text, title, thread_title, url) ILIKE $1
     UNION ALL SELECT 1 FROM memory.people WHERE concat_ws(' ', name, aliases::text, handles::text, relationship) ILIKE $1 LIMIT 1`, [like]);
  return (rowCount ?? 0) > 0;
}

export async function runRecall(pool: pg.Pool, questions: readonly Question[]): Promise<Result[]> {
  const results: Result[] = [];
  for (const question of questions.filter(each => !each.absent && (each.facts?.length ?? 0) > 0)) {
    const started = Date.now();
    const { hits, trace } = await search(pool, { query: question.query, limit: 10, trace: true });
    const ms = Date.now() - started;
    const shown = normal(renderHits(hits));
    const missing = question.facts!.filter(fact => !shown.includes(normal(fact)));
    const ok = missing.length === 0;
    let stage = "ok";
    let gold: string[] = [];
    if (!ok) {
      gold = await goldOf(pool, question);
      const fused = Math.min(...gold.map(id => trace!.fused.indexOf(id)).filter(rank => rank >= 0)) + 1;
      // a fact no longer anywhere in memory (a note rewritten as the truth changed, an item gone) is the question's fault
      const gone = (await Promise.all(missing.map(fact => held(pool, fact)))).some(found => !found);
      stage = gone ? "stale" : gold.length === 0 ? "no gold" : hits.some(hit => gold.includes(hit.id)) ? "quote" : Number.isFinite(fused) ? `fused ${fused}` : "candidates";
    }
    results.push({ id: question.id, category: question.category, set: question.set ?? "", ok, stage, missing, gold, top: hits.slice(0, 5).map(hit => hit.id), ms });
  }
  return results;
}

export function summarize(results: readonly Result[]) {
  const tally = (key: (result: Result) => string) => {
    const out: Record<string, string> = {};
    for (const [name, group] of Object.entries(Object.groupBy(results, key))) out[name] = `${group!.filter(each => each.ok).length}/${group!.length}`;
    return out;
  };
  const ms = results.map(each => each.ms).sort((a, b) => a - b);
  const stages: Record<string, number> = {};
  for (const each of results.filter(result => !result.ok)) { const kind = each.stage.replace(/ \d+$/, ""); stages[kind] = (stages[kind] ?? 0) + 1; }
  const stale = results.filter(each => each.stage === "stale").map(each => each.id);
  return {
    n: results.length, ok: results.filter(each => each.ok).length, stale: stale.length,
    // Helm shows a summary's short strings: the questions to update, by id
    ...(stale.length ? { needsUpdate: stale.join(", ").slice(0, 120) } : {}),
    medianMs: ms[Math.floor(ms.length / 2)] ?? 0, p90Ms: ms[Math.floor(ms.length * 0.9)] ?? 0, bySet: tally(each => each.set || "-"), byCategory: tally(each => each.category), stages,
  };
}

const QUESTIONS = process.env.EVAL_QUESTIONS ?? `${BRAIN_HOME}/eval/memory-v2.json`;
const CURSOR = "eval";
const DAY = 86_400_000;

interface Score { at: string; ok: number; n: number }

/** Run the eval over `file`, write recall-<time>.json, record the score and journal it next to the last one. */
export async function evaluate(pool: Pool, file = QUESTIONS) {
  const { questions } = JSON.parse(await readFile(file, "utf8")) as { questions: Question[] };
  const results = await runRecall(pool, questions);
  const summary = summarize(results);
  const out = `${BRAIN_HOME}/eval/recall-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ summary: { ...summary, questions: file }, results }, null, 1));
  const last = await readCursor(pool, CURSOR).then(text => (text ? JSON.parse(text) as Score : undefined));
  await cursorOk(pool, CURSOR, JSON.stringify({ at: new Date().toISOString(), ok: summary.ok, n: summary.n } satisfies Score));
  const sets = Object.entries(summary.bySet).map(([name, score]) => `${name} ${score}`).join(", ");
  const stale = summary.stale ? `; ${summary.stale} question${summary.stale === 1 ? "" : "s"} to update (answer no longer in memory): ${summary.needsUpdate}` : "";
  await noteInJournal(localTime(Date.now()).slice(0, 10),
    `Recall eval: ${summary.ok}/${summary.n} answers found in the top 10 (${sets})${stale}; median ${(summary.medianMs / 1000).toFixed(1)} s${last ? `; previous ${last.ok}/${last.n} on ${last.at.slice(0, 10)}` : ""}.`, "eval");
  return { summary, results, out };
}

/** Due once a week: the first tick after 04:00 local on a Sunday, or the first morning once the last run is more than
 *  eight days old (a missed Sunday); never before 04:00. */
export function evalDue(last: number | undefined, now: number): boolean {
  const local = localTime(now);
  if (Number(local.slice(11, 13)) < 4) return false;
  if (last === undefined) return true;
  const sunday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay() === 0;
  return sunday ? localTime(last).slice(0, 10) !== local.slice(0, 10) : now - last > 8 * DAY;
}

/** The weekly run; without a question file there is nothing to run. */
export async function evalWeekly(pool: Pool, now = Date.now()): Promise<void> {
  if (!existsSync(QUESTIONS)) return;
  const last = await readCursor(pool, CURSOR).then(text => (text ? Date.parse((JSON.parse(text) as Score).at) : undefined));
  if (!evalDue(last, now)) return;
  await evaluate(pool).catch(async error => { await cursorFailed(pool, CURSOR, error); throw error; });
}

export async function evalCommand(args: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const { summary, results, out } = await evaluate(pool, args[0]);
    console.info(JSON.stringify(summary, null, 1));
    for (const each of results.filter(result => !result.ok)) console.info(`${each.id} ${each.stage} missing ${JSON.stringify(each.missing)}`);
    console.info(`→ ${out}`);
  } finally {
    await pool.end();
  }
}
