import type { Pool } from "pg";
import { archiveSessions, pruneSupersededArchives, type ArchiveOptions } from "./archive.js";
import { redactTexts, RedactionError } from "./redact.js";
import type { ArchivedSession } from "./types.js";
import { cursorFailed, cursorOk } from "../events/store.js";
import { sha256 } from "../memory/text.js";

class SessionProjectionError extends Error {
  constructor(error: unknown) {
    const code = error && typeof error === "object" && "code" in error && /^[A-Z0-9]{5}$/.test(String(error.code)) ? String(error.code) : "unknown";
    super(`Session projection failed (SQLSTATE ${code}).`);
    this.name = "SessionProjectionError";
  }
}

/** Clip only after redaction, without splitting a UTF-8 character or a secret marker. */
export function clipToolResult(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= 2048) return text;
  const start = bytes.subarray(0, 1739).toString("utf8").replace(/\ufffd$/, "").replace(/\[REDACTED:[^\]]*$/, "");
  const end = bytes.subarray(bytes.length - 300).toString("utf8").replace(/^\ufffd+/, "");
  return `${start}\n…\n${end}`;
}

export async function storeSession(pool: Pool, archived: ArchivedSession): Promise<void> {
  const s = archived.transcript;
  const texts = await redactTexts([s.title ?? "", s.project ?? "", s.cwd ?? "", ...s.parts.map(part => part.text)]);
  const parts = s.parts.map((part, index) => ({ ...part, text: (part.kind === "tool_result" ? clipToolResult(texts[index + 3]!) : texts[index + 3]!).replaceAll("\u0000", "").toWellFormed() }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO memory.sessions
      (id,root_id,harness,original_path,archive_path,source_fingerprint,source_bytes,parent_id,cwd,project,title,started,ended,scope,scratch,prompt_count,part_count)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (id) DO UPDATE SET harness=excluded.harness,original_path=excluded.original_path,archive_path=excluded.archive_path,
      source_fingerprint=excluded.source_fingerprint,source_bytes=excluded.source_bytes,parent_id=excluded.parent_id,cwd=excluded.cwd,
      project=excluded.project,title=excluded.title,started=excluded.started,ended=excluded.ended,scope=excluded.scope,scratch=excluded.scratch,
      prompt_count=excluded.prompt_count,part_count=excluded.part_count,updated_at=now()`,
    [s.id, s.harness, s.originalPath, archived.archivePath, archived.sourceFingerprint, archived.sourceBytes, s.parentId,
      texts[2] || null, texts[1] || null, texts[0] || null, s.started, s.ended, s.scope, s.scratch,
      parts.filter(part => part.kind === "prompt").length, parts.length]);
    // Publish ancestry with the parts, so a new child cannot escape its parent's private mark.
    await client.query(`UPDATE memory.sessions SET
      root_id=coalesce((SELECT root_id FROM memory.sessions WHERE id=$2),$2,id),
      ancestor_ids=ARRAY[id] || coalesce((SELECT ancestor_ids FROM memory.sessions WHERE id=$2),CASE WHEN $2::text IS NULL THEN '{}'::text[] ELSE ARRAY[$2] END)
      WHERE id=$1`, [s.id, s.parentId]);
    await client.query("DELETE FROM memory.session_parts WHERE session_id=$1", [s.id]);
    for (let offset = 0; offset < parts.length; offset += 1000) {
      await client.query(`INSERT INTO memory.session_parts (session_id,entry,ordinal,at,role,kind,tool,scope,text)
        SELECT $1,x.entry,x.ordinal,x.at,x.role,x.kind,x.tool,x.scope,x.text
        FROM jsonb_to_recordset($2::jsonb) AS x(entry text,ordinal integer,at timestamptz,role text,kind text,tool text,scope text,text text)`,
      [s.id, JSON.stringify(parts.slice(offset, offset + 1000))]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Database errors can include a transcript-bearing row in their detail.
    throw new SessionProjectionError(error);
  } finally { client.release(); }
}

export async function resolveSessionRoots(pool: Pool): Promise<void> {
  await pool.query(`WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,id AS root_id,ARRAY[id] AS path FROM memory.sessions
    UNION ALL
    SELECT a.id,s.parent_id,s.id,a.path || s.id FROM ancestors a JOIN memory.sessions s ON s.id=a.parent_id
    WHERE NOT s.id=ANY(a.path)
  ), roots AS (SELECT DISTINCT ON (id) id,root_id,path FROM ancestors ORDER BY id,cardinality(path) DESC)
  UPDATE memory.sessions s SET root_id=r.root_id,ancestor_ids=r.path FROM roots r WHERE s.id=r.id AND (s.root_id IS DISTINCT FROM r.root_id OR s.ancestor_ids IS DISTINCT FROM r.path)`);
}

/** The existing ingest scheduler owns retries; the catalog fingerprint advances only with committed parts. */
export async function ingestSessions(pool: Pool, options: ArchiveOptions): Promise<number> {
  const lock = await pool.connect();
  let acquired = false;
  try {
    acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext('brain.sessions')) AS acquired")).rows[0].acquired;
    if (!acquired) return 0;
    const { rows } = await pool.query<{ original_path: string; source_fingerprint: string }>("SELECT original_path,source_fingerprint FROM memory.sessions");
    const known = new Map(rows.map(row => [row.original_path, row.source_fingerprint]));
    let count = 0, failures = 0;
    for await (const archived of archiveSessions({ ...options, onError: failure => {
      failures++;
      options.onError?.(failure);
      console.error(`sessions: ${failure.harness} source ${sha256(failure.originalPath).slice(0, 12)} failed (${failure.name})`);
    } }, known)) {
      try {
        await storeSession(pool, archived);
        count++;
        if (count % 100 === 0) console.info(`sessions: projected ${count}`);
      } catch (error) {
        failures++;
        const reason = error instanceof RedactionError || error instanceof SessionProjectionError ? error.message : "projection failed";
        console.error(`sessions: ${archived.transcript.harness} source ${sha256(archived.transcript.originalPath).slice(0, 12)}: ${reason}`);
      }
    }
    await resolveSessionRoots(pool);
    const { rows: heads } = await pool.query<{ archive_path: string; updated_at: Date }>("SELECT archive_path,updated_at FROM memory.sessions");
    const pruned = await pruneSupersededArchives(heads.map(head => ({ archivePath: head.archive_path, changedAt: new Date(head.updated_at) })));
    if (pruned.pruned) console.info(`sessions: pruned ${pruned.pruned} redundant versions (${pruned.bytes} bytes)`);
    if (failures) {
      const error = new Error(`${failures} session sources failed; ${count} projected. Failed sources remain retryable.`);
      throw error;
    }
    await cursorOk(pool, "sessions", String(count));
    return count;
  } catch (cause) {
    const error = new Error(cause instanceof Error && /^\d+ session sources failed;/.test(cause.message)
      ? cause.message : "Session discovery or maintenance failed; source archives and prior catalog commits are retained.");
    await cursorFailed(pool, "sessions", error);
    throw error;
  } finally {
    if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext('brain.sessions'))");
    lock.release();
  }
}
