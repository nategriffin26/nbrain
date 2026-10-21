// The one writer of brain.events and brain.cursors for the connectors. An event is deduped on (source, external_id);
// a read that sees the same source item again changes nothing unless its content changed.
import type { Pool } from "pg";
/** What the connectors and captures write. */
export type EventKind = "mail.received" | "mail.sent" | "text.received" | "text.sent" | "calendar.changed" | "x.bookmark" | "capture" | "chat.turn" | "work.turn" | "source.silent";
export type EventRoute = "memory" | "knowledge" | "ledger" | "brief" | "drop";

export interface NewEvent {
  kind: EventKind;
  source: string;
  external_id: string;
  at: Date | string | number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  data?: Record<string, unknown>;
  /** Already settled, never sent to a gate (a first read seeding the store, not news). */
  route?: EventRoute;
}

/**
 * skip: an existing event is left alone.
 * update: an existing event whose title, body or data changed takes the new ones (a text edited, a reaction added).
 * reroute: as update, and the gate reads it again (a calendar event moved).
 */
export type OnSeen = "skip" | "update" | "reroute";

/** Insert; returns whether a row was created, changed, or left alone. */
export async function insertEvent(pool: Pool, event: NewEvent, onSeen: OnSeen = "skip"): Promise<"inserted" | "changed" | "same"> {
  const at = new Date(event.at).toISOString();
  const values = [event.kind, event.source, event.external_id, at, event.title ?? null, event.body ?? null, event.url ?? null, JSON.stringify(event.data ?? {}), event.route ?? null];
  const conflict =
    onSeen === "skip"
      ? "DO NOTHING"
      : `DO UPDATE SET title = excluded.title, body = excluded.body, url = excluded.url, data = excluded.data${
          onSeen === "reroute" ? ", at = excluded.at, route = null, triage = null, routed_at = null" : ""
        } WHERE (brain.events.title, brain.events.body, brain.events.url, brain.events.data) IS DISTINCT FROM (excluded.title, excluded.body, excluded.url, excluded.data)`;
  const { rows } = await pool.query<{ inserted: boolean }>(
    `INSERT INTO brain.events (kind, source, external_id, at, title, body, url, data, route, routed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::text, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (source, external_id) ${conflict} RETURNING (xmax = 0) AS inserted`,
    values,
  );
  return rows.length === 0 ? "same" : rows[0]!.inserted ? "inserted" : "changed";
}

export async function readCursor(pool: Pool, source: string): Promise<string | null> {
  const { rows } = await pool.query<{ cursor: string | null }>("SELECT cursor FROM brain.cursors WHERE source = $1", [source]);
  return rows[0]?.cursor ?? null;
}

/** A successful read: the new position (kept as is when omitted) and the time. */
export async function cursorOk(pool: Pool, source: string, cursor?: string): Promise<void> {
  await pool.query(
    `INSERT INTO brain.cursors (source, cursor, last_ok_at, last_error, updated_at) VALUES ($1, $2, now(), null, now())
     ON CONFLICT (source) DO UPDATE SET cursor = coalesce($2, brain.cursors.cursor), last_ok_at = now(), last_error = null, updated_at = now()`,
    [source, cursor ?? null],
  );
}

export async function cursorFailed(pool: Pool, source: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await pool.query(
    `INSERT INTO brain.cursors (source, last_error, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (source) DO UPDATE SET last_error = $2, updated_at = now()`,
    [source, message],
  );
}
