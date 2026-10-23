// memory_events: indexes every connector event that carries something the owner's life touched (mail, texts, calendar,
// bookmarks, chat turns) into memory.items/chunks within a minute of arrival, and again when a connector rewrites the row.
import type { Pool } from "pg";
import { OWNER } from "../config.js";
import { researchId, savedId, whyContexts } from "../capture/id.js";
import { cursorOk, readCursor, type NewEvent } from "../events/store.js";
import { type ItemInput, writeItems } from "./store.js";
import { cleanText, foldHandle } from "./text.js";

/** A brain.events row as the indexer reads it. */
interface EventRow { id: number; kind: NewEvent["kind"]; external_id: string | null; at: string; title: string | null; body: string | null; url: string | null; data: Record<string, unknown>; rev: string }

const KINDS = ["mail.received", "mail.sent", "text.received", "text.sent", "calendar.changed", "x.bookmark", "chat.turn", "work.turn", "capture"];
const BATCH = 32;
const CURSOR = "memory.events";
const OVERLAP = 100;

/** The raw thing an event carries, as a memory item. `id` is the event row's, absent for a thing read straight from its source (the backfill). */
export function itemOfEvent(event: Pick<NewEvent, "kind" | "at" | "title" | "body" | "url" | "data"> & { id?: number; external_id: string | null }): ItemInput | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);
  const body = cleanText(event.body ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const base = { ext_id: event.external_id, title: event.title ?? "", at: new Date(event.at), url: event.url, body, meta: { kind: event.kind, ...data }, origin: "event" as const, event_id: event.id };
  switch (event.kind) {
    case "mail.received":
    case "mail.sent": {
      const from = text(data.from);
      const to = [...list(data.to), ...list(data.cc)];
      return { ...base, id: `gmail:${event.external_id}`, source: "gmail", kind: "message", thread: text(data.thread_id) ?? text(data.threadId), sender: from, recipients: to, from_me: event.kind === "mail.sent",
        handles: [...(from ? [{ handle: foldHandle(from.replace(/^.*<([^>]+)>.*$/, "$1")), role: "sender" }] : []), ...to.map(each => ({ handle: foldHandle(each.replace(/^.*<([^>]+)>.*$/, "$1")), role: "recipient" }))] };
    }
    case "text.received":
    case "text.sent": {
      const from = text(data.from);
      const participants = list(data.participants);
      return { ...base, id: `imessage:${event.external_id}`, source: "imessage", kind: "message", title: "", thread: data.chat_id === undefined ? null : String(data.chat_id), thread_title: data.group === true ? text(event.title) : null, sender: from, recipients: participants, from_me: event.kind === "text.sent",
        handles: [...(from ? [{ handle: foldHandle(from), role: "sender" }] : []), ...participants.filter(each => each !== from).map(each => ({ handle: foldHandle(each), role: "recipient" }))] };
    }
    case "calendar.changed": {
      const start = text(data.start);
      const lines = [event.title, event.body, text(data.location) && `Location: ${data.location}`, text(data.notes)].filter(Boolean);
      return { ...base, id: `calendar:${event.external_id}`, source: "calendar", kind: "event", at: start ? new Date(start) : base.at, body: lines.join("\n") };
    }
    case "x.bookmark":
      return { ...base, id: `x:${event.external_id}`, source: "x", kind: "post", sender: text(data.author) && `@${data.author}` };
    case "chat.turn":
      return { ...base, id: `chat:${event.external_id}`, source: "chat", kind: "message", thread: text(data.threadId), thread_title: text(data.bot), sender: text(data.bot) };
    case "work.turn":
      return { ...base, id: `omp:${event.external_id}`, source: "omp", kind: "message", thread: text(data.session), thread_title: text(event.title) ?? text(data.project), sender: OWNER.name, from_me: true };
    case "capture":
      // the owner's reason for saving it is searchable at once (each chunk's context line); enrichment adds the rest
      return { ...base, id: data.as === "research" ? researchId(event.external_id ?? "") : savedId(event.external_id ?? ""), source: data.as === "research" ? "research" : "saved", kind: data.as === "research" || data.form === "note" ? "note" : data.form === "pdf" || data.form === "file" ? "doc" : "page", sender: text(data.by), contexts: whyContexts(body, text(data.why)) };
    default:
      return undefined;
  }
}

/**
 * Index events new or changed since the last run (brain.events.rev, schema.sql); answers how many items were written.
 * A row committed late can carry a rev below one already seen, so each run starts a little behind where the last one reached;
 * writeItems skips what it already holds by hash.
 */
export async function indexEvents(pool: Pool): Promise<number> {
  const reached = Number(await readCursor(pool, CURSOR) ?? 0);
  let after = Math.max(0, reached - OVERLAP);
  let written = 0;
  for (;;) {
    const { rows } = await pool.query<EventRow>(
      `SELECT * FROM brain.events WHERE rev > $1 AND kind = ANY($2) ORDER BY rev LIMIT ${BATCH}`,
      [after, KINDS],
    );
    if (rows.length === 0) break;
    after = Number(rows[rows.length - 1]!.rev);
    const items = rows.flatMap(row => itemOfEvent(row) ?? []);
    written += await writeItems(pool, items);
    // an event whose copy was not rewritten (unchanged content) still takes over the item's link to its row
    await pool.query("UPDATE memory.items i SET event_id = x.event_id FROM jsonb_to_recordset($1) AS x(id text, source text, ext_id text, event_id bigint) WHERE (i.id = x.id OR (i.source = x.source AND i.ext_id = x.ext_id)) AND i.event_id IS DISTINCT FROM x.event_id",
      [JSON.stringify(items.map(item => ({ id: item.id, source: item.source, ext_id: item.ext_id, event_id: item.event_id })))]);
    // each batch moves the cursor: a big backlog (a connector's first read) shows progress and a restart resumes it
    if (after > reached) await cursorOk(pool, CURSOR, String(after));
  }
  return written;
}

