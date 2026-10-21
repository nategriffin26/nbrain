// Calendar changes through Executor's Apple Calendar app: seven local
// days behind and thirty ahead, read whole each poll. Each occurrence is one event `<event id>@<start ms>`; a new or
// changed one is written (and read again by the gate), a missing upcoming one is marked deleted. The first poll seeds
// the store already routed: what is on the calendar then is state, not news. Now reads today's calendar from these rows.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { cursorOk, insertEvent, readCursor } from "../events/store.js";
import { ZONE } from "../config.js";
import { dayBounds, localTime } from "../time.js";
import { guarded } from "./common.js";
import { executorProgram } from "./executor.js";

const SOURCE = "calendar";
const DAY_MS = 86_400_000;

interface Occurrence {
  id: string; title: string; calendar: string; location?: string; notes?: string; recurring: boolean; all_day: boolean;
  start: string; end: string;
}

const LIST = (from: string, through: string) => `
const answer = await call("apple-calendar", "list_events", { start_date: ${JSON.stringify(from)}, end_date: ${JSON.stringify(through)}, detail_level: "standard", sort: "asc", display_timezone: ${JSON.stringify(ZONE)} });
if (answer.more === true || answer.truncated === true || (typeof answer.event_count === "number" && answer.event_count !== answer.events.length)) throw new Error("Calendar answered an incomplete snapshot");
return answer.events.map(e => ({ id: String(e.id), title: String(e.title ?? ""), calendar: String(e.calendar ?? ""), location: e.location || undefined, notes: e.notes ? String(e.notes).slice(0, 500) : undefined, recurring: e.is_recurring === true, all_day: e.is_all_day === true,
  start: e.is_all_day ? String(e.start_date_local ?? e.start_date).slice(0, 10) : e.start_date, end: e.is_all_day ? String(e.end_date_local ?? e.end_date).slice(0, 10) : e.end_date }));`;

/** All-day dates are local wall dates, not UTC midnights. */
const instant = (value: string, allDay: boolean): number => (allDay ? Date.parse(dayBounds(Date.parse(`${value}T12:00:00Z`))[0]) : Date.parse(value));

export async function pollCalendar(pool: Pool): Promise<void> {
  await guarded(pool, SOURCE, async () => {
    const now = Date.now();
    const first = (await readCursor(pool, SOURCE)) === null;
    const [today] = dayBounds(now);
    const from = new Date(Date.parse(dayBounds(now - 7 * DAY_MS)[0])).toISOString().replace(".000Z", "Z");
    const through = new Date(Date.parse(dayBounds(now + 30 * DAY_MS)[0])).toISOString().replace(".000Z", "Z");
    const seen = new Set<string>();
    for (const event of await executorProgram<Occurrence[]>(LIST(from, through))) {
      const start = instant(event.start, event.all_day);
      const end = instant(event.end, event.all_day);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Calendar answered ${event.id} without times`);
      const ref = `${event.id}@${start}`;
      seen.add(ref);
      const data = { title: event.title, calendar: event.calendar, location: event.location, notes: event.notes, recurring: event.recurring, all_day: event.all_day, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
      await insertEvent(pool, {
        kind: "calendar.changed", source: SOURCE, external_id: ref, at: now, title: event.title,
        body: `${localTime(start)} to ${localTime(end)} (${event.calendar})${event.location ? ` at ${event.location}` : ""}${event.notes ? `\n\n${event.notes}` : ""}`,
        data: { ...data, hash: createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16) },
        ...(first ? { route: "drop" as const } : {}),
      }, "reroute");
    }
    // An upcoming occurrence Calendar no longer lists was deleted or moved (a move shows up as a new occurrence).
    await pool.query(
      `UPDATE brain.events SET data = data || '{"deleted": true}'::jsonb
       WHERE source = $1 AND kind = 'calendar.changed' AND NOT (external_id = ANY($2::text[])) AND (data->>'start')::timestamptz >= $3::timestamptz AND (data->>'start')::timestamptz < $4::timestamptz AND coalesce(data->>'deleted', 'false') <> 'true'`,
      [SOURCE, [...seen], today, through],
    );
    await cursorOk(pool, SOURCE, new Date(now).toISOString());
  });
}
