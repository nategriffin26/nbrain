// Enrichment of what was saved: one reading-model call per item answers a summary, tags and, for each chunk, a context line
// that situates it in the whole document. The lines are embedded and indexed with the chunk (contextual retrieval: Anthropic
// measured 35% fewer retrieval failures with embeddings, 49% with BM25 too, 67% with reranking; a generic summary alone
// helped little), so the item is rewritten with them.
import type { Pool } from "pg";
import { complete, replyJson, roleChoice } from "../models.js";
import { type ItemInput, writeItems } from "../memory/store.js";
import { chunkBody, sha256 } from "../memory/text.js";

/** Items per run; the loop runs every minute. */
const PER_RUN = 3;
const FAILURES = 3;
const CLIP_CHARS = 24_000;
const MAX_CHUNKS = 60;
const CHUNK_PEEK = 200;
const MAX_TAGS = 5;
const CONTEXT_CHARS = 600;

const PROMPT = `You index a document someone saved to their personal knowledge base, so they can find it later by searching.
You get the document (possibly clipped), the reason it was saved if known, its chunks (part number and opening words), and the tags already in use.
Answer with one JSON object and nothing else:
{"summary": "2-3 sentences: what this is and its main point or finding",
 "tags": ["1-5 lowercase-hyphenated topic tags; reuse an existing tag whenever it fits, coin a new one only when none does"],
 "contexts": [{"part": 0, "context": "one sentence of 50-100 tokens"}]}
Give one context for every chunk listed. A context situates that chunk in the whole document so it can be found on its own: name the document, its subject and the section or argument the chunk belongs to, and say what the chunk covers using the words someone would search with (names, products, numbers, concepts), including terms the chunk implies but does not state. Never repeat the chunk's text and never use "this chunk" or "the document" without saying which.`;

export interface Enriched { summary: string; tags: string[]; contexts: Map<number, string> }

/** The model's answer as an Enriched, or undefined when it is not one: no JSON, no summary, no usable tag, or a context for no chunk. Unknown parts are dropped, tags beyond five too. */
export function parseEnrichment(answer: string, parts: ReadonlySet<number>): Enriched | undefined {
  let json: unknown;
  try { json = replyJson(answer); } catch { return undefined; }
  if (typeof json !== "object" || json === null) return undefined;
  const { summary, tags, contexts } = json as { summary?: unknown; tags?: unknown; contexts?: unknown };
  if (typeof summary !== "string" || summary.trim() === "" || !Array.isArray(tags)) return undefined;
  const cleaned = [...new Set(tags.flatMap(tag => typeof tag === "string" ? [tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")] : []).filter(Boolean))].slice(0, MAX_TAGS);
  if (cleaned.length === 0) return undefined;
  const lines = new Map<number, string>();
  for (const each of Array.isArray(contexts) ? contexts : []) {
    const { part, context } = (each ?? {}) as { part?: unknown; context?: unknown };
    if (typeof part !== "number" || !parts.has(part) || typeof context !== "string" || context.trim() === "" || lines.has(part)) continue;
    lines.set(part, context.replace(/\s+/g, " ").trim().slice(0, CONTEXT_CHARS));
  }
  if (lines.size === 0 && parts.size > 0) return undefined;
  return { summary: summary.replace(/\s+/g, " ").trim(), tags: cleaned, contexts: lines };
}

interface Row { id: string; source: string; kind: string; ext_id: string | null; title: string; at: Date; sender: string | null; url: string | null; body: string; meta: Record<string, unknown>; event_id: string | null }

/** Enrich a few saved items not yet enriched. Answers how many were rewritten. */
export async function enrichCaptures(pool: Pool): Promise<number> {
  const { rows } = await pool.query<Row>("SELECT id, source, kind, ext_id, title, at, sender, url, body, meta, event_id FROM memory.items WHERE source = 'saved' AND NOT meta ? 'enriched' ORDER BY at LIMIT $1", [PER_RUN]);
  const done = await Promise.all(rows.map(async row => {
    try { return await enrich(pool, row); }
    catch (error) {
      const failures = Number(row.meta.enrich_failures ?? 0) + 1;
      console.error(`${new Date().toISOString()} capture enrich ${row.id} (${failures}/${FAILURES}):`, error instanceof Error ? error.message : error);
      const update = failures >= FAILURES ? { enrich_failures: failures, enriched: { failed: error instanceof Error ? error.message.slice(0, 200) : "failed", at: new Date().toISOString() } } : { enrich_failures: failures };
      await pool.query("UPDATE memory.items SET meta = meta || $2::jsonb WHERE id = $1", [row.id, JSON.stringify(update)]);
      return 0;
    }
  }));
  return done.reduce((sum, each) => sum + each, 0);
}

/** The 50 tags saved items use most, to be reused. */
async function usedTags(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tag: string }>("SELECT t AS tag FROM memory.items, jsonb_array_elements_text(CASE WHEN jsonb_typeof(meta->'tags') = 'array' THEN meta->'tags' ELSE '[]' END) AS t WHERE source = 'saved' GROUP BY t ORDER BY count(*) DESC, t LIMIT 50");
  return rows.map(row => row.tag);
}

async function enrich(pool: Pool, row: Row): Promise<number> {
  const chunks = chunkBody(row.body.replace(/\0/g, "")).slice(0, MAX_CHUNKS);
  const why = typeof row.meta.why === "string" ? row.meta.why : "";
  const user = [
    `<document title=${JSON.stringify(row.title)}${row.url ? ` url=${JSON.stringify(row.url)}` : ""}>`, row.body.slice(0, CLIP_CHARS), row.body.length > CLIP_CHARS ? "[clipped]" : "", "</document>",
    why === "" ? "" : `Saved because: ${why}`,
    "Chunks:", ...chunks.map(chunk => `[${chunk.part}] ${chunk.text.slice(0, CHUNK_PEEK).replace(/\s+/g, " ")}`),
    `Existing tags: ${(await usedTags(pool)).join(", ") || "(none yet)"}`,
  ].filter(Boolean).join("\n");
  const model = await roleChoice("reading");
  const answer = await complete({ role: "reading", maxTokens: 8000, messages: [{ role: "system", content: PROMPT }, { role: "user", content: user }] });
  const parsed = parseEnrichment(answer, new Set(chunks.map(chunk => chunk.part)));
  if (parsed === undefined) throw new Error(`unusable answer: ${answer.slice(0, 120).replace(/\s+/g, " ")}`);
  const tagLine = `Tags: ${parsed.tags.join(", ")}.`;
  const contexts = new Map(chunks.map(chunk => [`${chunk.part}:${sha256(chunk.text)}`, [parsed.contexts.get(chunk.part), tagLine, why === "" ? "" : `Saved because: ${why}`].filter(Boolean).join(" ")]));
  const item: ItemInput = {
    id: row.id, source: row.source, kind: row.kind, ext_id: row.ext_id, title: row.title, at: row.at, sender: row.sender, url: row.url, body: row.body, origin: "event", event_id: row.event_id === null ? null : Number(row.event_id),
    meta: { ...row.meta, summary: parsed.summary, tags: parsed.tags, enriched: { model: model.model, at: new Date().toISOString() } }, contexts, force: true,
  };
  return writeItems(pool, [item]);
}
