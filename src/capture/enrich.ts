// Enrichment of what was saved: the library triage (library/cards.ts) asks, in the same reading-model call as the card,
// for a summary, tags and, for each chunk, a context line that situates it in the whole document. The lines are embedded
// and indexed with the chunk (contextual retrieval: Anthropic measured 35% fewer retrieval failures with embeddings, 49%
// with BM25 too, 67% with reranking; a generic summary alone helped little), so the item is rewritten with them.
import type { Pool } from "pg";
import { replyJson } from "../models.js";
import { chunkBody } from "../memory/text.js";

const MAX_CHUNKS = 60;
const CHUNK_PEEK = 200;
const MAX_TAGS = 5;
const CONTEXT_CHARS = 600;

export const ENRICH_PROMPT = `A saved page (its chunks are listed) was kept on purpose: keep it unless it holds nothing at all. Whether you keep it or not, your JSON object also carries these three keys:
 "summary": "2-3 sentences: what this is and its main point or finding",
 "tags": ["1-5 lowercase-hyphenated topic tags; reuse an existing tag whenever it fits, coin a new one only when none does"],
 "contexts": [{"part": 0, "context": "one sentence of 50-100 tokens"}]
Give one context for every chunk listed. A context situates that chunk in the whole document so it can be found on its own: name the document, its subject and the section or argument the chunk belongs to, and say what the chunk covers using the words someone would search with (names, products, numbers, concepts), including terms the chunk implies but does not state. Never repeat the chunk's text and never use "this chunk" or "the document" without saying which.`;

/** The chunks a saved item's contexts are asked for (the first MAX_CHUNKS). */
export const enrichedChunks = (body: string) => chunkBody(body.replace(/\0/g, "")).slice(0, MAX_CHUNKS);

/** The part of the model's input that asks for enrichment: each chunk's part and opening words, and the tags in use. */
export const enrichmentInput = (chunks: readonly { part: number; text: string }[], tags: readonly string[]) =>
  ["Chunks:", ...chunks.map(chunk => `[${chunk.part}] ${chunk.text.slice(0, CHUNK_PEEK).replace(/\s+/g, " ")}`), `Existing tags: ${tags.join(", ") || "(none yet)"}`, 'This is a saved page: kept or not, your one JSON object also has "summary", "tags" and "contexts".'].join("\n");

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

/** The 50 tags saved items use most, to be reused. */
export async function usedTags(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tag: string }>("SELECT t AS tag FROM memory.items, jsonb_array_elements_text(CASE WHEN jsonb_typeof(meta->'tags') = 'array' THEN meta->'tags' ELSE '[]' END) AS t WHERE source = 'saved' GROUP BY t ORDER BY count(*) DESC, t LIMIT 50");
  return rows.map(row => row.tag);
}
