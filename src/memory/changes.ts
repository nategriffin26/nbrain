import type { Pool } from "pg";
import { OWNER } from "../config.js";
import { cleanText, quoteOf } from "./text.js";
import { currentSql, personSql, resolvePerson, visibleSql } from "./search.js";

/** Relative days and bare dates start at midnight in the owner's process zone, including DST changes. */
export function parseSince(value: string, now = new Date()): Date {
  const text = value.trim().toLowerCase();
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(text.replace(/^since\s+/, ""));
  if (weekday >= 0) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() - weekday + 7) % 7);
  const ago = /^(\d+) days? ago$/.exec(text);
  if (text === "yesterday" || text === "this morning" || ago) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (ago ? Number(ago[1]) : text === "yesterday" ? 1 : 0));
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?=$|t\d{2}:\d{2})/.exec(text);
  if (parts) {
    const day = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    if (day.getFullYear() === Number(parts[1]) && day.getMonth() === Number(parts[2]) - 1 && day.getDate() === Number(parts[3])) {
      const date = text.length === 10 ? day : new Date(value.trim());
      if (Number.isFinite(date.getTime())) return date;
    }
  }
  throw new Error(`Not a since date: ${value}. Use ISO, YYYY-MM-DD, a weekday, yesterday, this morning, or N days ago.`);
}

export async function changes(pool: Pool, input: { since: string; source?: string[]; person?: string; limit?: number; private?: boolean }, now = new Date()): Promise<{ since: string; counts: Record<string, number>; threads: { source: string; thread?: string; title: string; who: string; first: string; last: string; count: number; latest: { id: string; quote: string } }[] }> {
  const since = parseSince(input.since, now).toISOString();
  const params: unknown[] = [since, now];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where = ["i.at >= $1", "i.at <= $2", "i.source <> 'memory'", currentSql("i")];
  if (!input.private) where.push(visibleSql("i"));
  if (input.source?.length) where.push(`i.source = ANY(${add(input.source)})`);
  if (input.person) {
    const people = await resolvePerson(pool, input.person);
    if (!people.length) return { since, counts: {}, threads: [] };
    where.push(personSql("i", add(people.map(person => person.id))));
  }
  const { rows } = await pool.query<{ source: string; thread: string | null; title: string; who: string; first: Date; last: Date; count: string; total: string; id: string; body: string }>(`
    WITH grouped AS (
      SELECT i.source, i.thread, (array_agg(coalesce(nullif(i.title,''),i.thread_title,i.source) ORDER BY i.at DESC, i.id))[1] AS title,
        string_agg(DISTINCT CASE WHEN i.from_me THEN ${add(OWNER.name)} ELSE coalesce((SELECT p.name FROM memory.item_people r JOIN memory.people p ON p.id = r.person_id WHERE r.item_id = i.id AND r.role = 'sender' AND NOT (p.kind = 'person' AND i.source = 'imessage' AND i.sender ~ '^[0-9]{1,6}$') LIMIT 1), i.sender_name, i.sender, '') END, ', ') AS who,
        min(i.at) AS first, max(i.at) AS last, count(*) AS count,
        (array_agg(i.id ORDER BY i.at DESC, i.id))[1] AS id,
        (array_agg(i.body ORDER BY i.at DESC, i.id))[1] AS body
      FROM memory.items i WHERE ${where.join(" AND ")} GROUP BY i.source, i.thread, CASE WHEN i.thread IS NULL THEN i.id END
    ) SELECT *, sum(count) OVER (PARTITION BY source) AS total FROM grouped ORDER BY last DESC, id`, params);
  const counts = Object.fromEntries(rows.map(row => [row.source, Number(row.total)]));
  const threads = rows.slice(0, Math.max(1, Math.min(100, Math.round(input.limit ?? 30)))).map(row => ({
    source: row.source, ...(row.thread ? { thread: row.thread } : {}), title: cleanText(row.title), who: row.who,
    first: new Date(row.first).toISOString(), last: new Date(row.last).toISOString(), count: Number(row.count), latest: { id: row.id, quote: quoteOf(row.body, [], 400) },
  }));
  return { since, counts, threads };
}
