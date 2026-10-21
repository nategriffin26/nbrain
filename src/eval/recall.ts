// Retrieval eval: asks memory search (as memory_search does: every source, reranked, 10 hits) each question of a
// question file and checks whether every expected fact is in the hits. A miss names where it was lost: the items holding
// the answer (expected ids, the current notes descended from an expected note, items quoting its rarest fact) never
// reached a channel ("candidates"), sat below the hits ("fused N"), or were shown without the fact ("quote").
// The question file and results are the owner's (BRAIN_HOME/eval); results land beside it as recall-<date>.json.
// Run: nbrain eval [questions.json]
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { BRAIN_HOME } from "../config.js";
import { renderHits, search } from "../memory/search.js";

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
      stage = gold.length === 0 ? "no gold" : hits.some(hit => gold.includes(hit.id)) ? "quote" : Number.isFinite(fused) ? `fused ${fused}` : "candidates";
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
  return { n: results.length, ok: results.filter(each => each.ok).length, medianMs: ms[Math.floor(ms.length / 2)] ?? 0, p90Ms: ms[Math.floor(ms.length * 0.9)] ?? 0, bySet: tally(each => each.set || "-"), byCategory: tally(each => each.category), stages };
}

export async function evalCommand(args: string[]): Promise<void> {
  const file = args[0] ?? process.env.EVAL_QUESTIONS ?? `${BRAIN_HOME}/eval/memory-v2.json`;
  const { questions } = JSON.parse(await readFile(file, "utf8")) as { questions: Question[] };
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const results = await runRecall(pool, questions);
    const summary = summarize(results);
    const out = `${BRAIN_HOME}/eval/recall-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    await writeFile(out, JSON.stringify({ summary: { ...summary, questions: file }, results }, null, 1));
    console.info(JSON.stringify(summary, null, 1));
    for (const each of results.filter(result => !result.ok)) console.info(`${each.id} ${each.stage} missing ${JSON.stringify(each.missing)}`);
    console.info(`→ ${out}`);
  } finally {
    await pool.end();
  }
}
