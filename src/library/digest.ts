// The library's part of the Sunday message: cards that bear on what now.md says is in flight (this week's first, then
// older ones nobody has tried), and how many cards the week added. Plain markdown, short enough for a phone.
import type { Pool } from "pg";
import { readNow } from "../context/profile.js";

const SHOWN = 5;
const WEEK_MS = 7 * 24 * 3600_000;

export async function libraryDigest(pool: Pool, now: Date): Promise<string> {
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const inFlight = readNow(["work"]).blocks.map(block => block.name);
  const notPrivate = "NOT EXISTS (SELECT 1 FROM memory.private p WHERE p.target = i.id OR p.target = 'thread:' || i.source || ':' || i.thread)";
  const { rows: [counted] } = await pool.query<{ added: number }>(
    `SELECT count(*)::int AS added FROM memory.cards c JOIN memory.items i ON i.id = c.item_id WHERE c.at >= $1 AND c.at <= $2 AND ${notPrivate}`, [weekAgo, now]);
  // each card under the first of its projects that is in flight; one per project before any project gets a second
  const { rows } = inFlight.length === 0 ? { rows: [] } : await pool.query<{ what: string; why: string; url: string | null; project: string }>(
    `SELECT what, why, url, project FROM (
       SELECT c.what, c.why, coalesce(c.url, i.url) AS url, p.name AS project, p.block, c.at >= $2 AS fresh,
              row_number() OVER (PARTITION BY p.name ORDER BY c.at >= $2 DESC, c.at DESC) AS turn
       FROM memory.cards c JOIN memory.items i ON i.id = c.item_id
       CROSS JOIN LATERAL (SELECT f.name, f.block FROM unnest(c.projects) WITH ORDINALITY AS x(name, rank)
         JOIN unnest($1::text[]) WITH ORDINALITY AS f(name, block) ON lower(f.name) = lower(x.name) ORDER BY x.rank LIMIT 1) p
       WHERE c.at <= $3 AND c.status = 'new' AND ${notPrivate}) picked
     ORDER BY turn, fresh DESC, block LIMIT ${SHOWN}`, [inFlight, weekAgo, now]);
  const added = counted?.added ?? 0;
  const lines = [`${added} ${added === 1 ? "card" : "cards"} added this week.`];
  if (rows.length > 0) lines.push("", ...rows.map(row => `- **${row.project}**: ${row.what} ${row.why}${row.url ? ` ${row.url}` : ""}`));
  return lines.join("\n");
}
