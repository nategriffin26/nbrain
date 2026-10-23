// The library: one card per X bookmark or saved page worth keeping. triageCards reads each item once per version (its
// hash) on the reading model with the owner's profile and now.md in hand, and writes a card (memory.cards) or notes the
// item as not worth one (memory.uncarded). A saved page's enrichment (capture/enrich.ts) comes from the same call. The
// card's what and why become every chunk's context line, so plain search finds the item by what it is and why it was kept.
// findCards is search over carded items (search's cards filter), each result with its card.
import type { Pool } from "pg";
import { OWNER } from "../config.js";
import { ENRICH_PROMPT, type Enriched, enrichedChunks, enrichmentInput, parseEnrichment, usedTags } from "../capture/enrich.js";
import { canonicalUrl } from "../capture/read.js";
import { readNow, readProfile } from "../context/profile.js";
import { CARD_KINDS } from "../mcp/contract.js";
import { search } from "../memory/search.js";
import { type ItemInput, writeItems } from "../memory/store.js";
import { chunkBody, sha256 } from "../memory/text.js";
import { complete, replyJson, roleChoice } from "../models.js";
import type { Card, CardKind, FindCards, FoundCards } from "./types.js";

/** What gets carded: bookmarks and saved pages. Research notes and everything else stay record only. */
export const CARD_SOURCES = ["x", "saved"];
/** Items read side by side. */
const PARALLEL = 6;
/** A bookmark's post and the start of what it links: enough to say what it is. */
const CLIP_CHARS = 12_000;
/** Unusable answers before an item is let go as uncarded. */
const FAILURES = 3;
/** The profile files that say what a bookmark could be for; how the owner works with agents does not. */
const FIT_FILES = new Set(["basics.md", "tastes.md", "goals.md", "projects.md", "outputs.md"]);
const WHAT_CHARS = 300;
const WHY_CHARS = 400;
const CRAFT_CHARS = 500;
/** Raw matches the library adds when no card is strong. */
const UNCARDED_LIMIT = 5;

const O = OWNER.name;
const PROMPT = `You keep ${O}'s library: one card for each bookmark or saved page worth coming back to. You read one item (an X post ${OWNER.they} bookmarked, with the posts and pages it links, or a page ${OWNER.they} saved) and decide.
Keep it when it holds something ${OWNER.they} could use or learn from later: a tool, library, app or service; a technique or how-to; a design or craft reference (a site, app, interface, animation, typeface or layout worth studying); an idea or argument worth having; a long read worth reading in full; or a person worth following for their work.
Skip jokes, memes, news and launch announcements with nothing to use, hot takes, predictions and speculation, engagement bait, giveaways, and threads with no takeaway.
Answer with one JSON object and nothing else.
To skip: {"keep": false, "reason": "a few words"}
To keep: {"keep": true,
 "kind": "tool | technique | reference | idea | read | person",
 "what": "one sentence under 30 words: what the thing is, by name, in plain words (what it is, not what the post says about it)",
 "why": "one sentence under 30 words: why it fits ${O}, concretely: the project it bears on or the taste or goal it matches; claim nothing about ${OWNER.them} the profile below does not say; never generic praise",
 "projects": ["names from the project list below that it bears on, most relevant first; [] when none"],
 "url": "the full address of the thing itself (the tool's site or repo, the article, the demo; never a short link) when the item is a post pointing at it; omit when there is none",
 "craft": "references only: what is good about it in craft terms (type, layout, motion, density, colour), in one or two sentences"}
Kinds (exactly one of these six): tool = software, a library, app or service to use; technique = a method, pattern or tip to apply; reference = something to study for how it looks, moves or is made; idea = an argument or concept; read = a long piece worth reading in full; person = someone worth following.`;

export type Draft = Pick<Card, "kind" | "what" | "why" | "projects"> & { url?: string; craft?: string };
export type Triage = { keep: false; reason: string } | { keep: true; card: Draft };

const line = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The model's answer as a Triage, or undefined when it is not one (retried): no JSON, no keep, an unknown kind, no
 *  what or why. Projects not in `projects` are dropped (names come back as listed); craft is kept for references only;
 *  a url that is not a web address, or a t.co short link, is dropped. */
export function parseTriage(answer: string, projects: readonly string[]): Triage | undefined {
  let json: unknown;
  try { json = replyJson(answer); } catch { return undefined; }
  if (typeof json !== "object" || json === null) return undefined;
  const reply = json as Record<string, unknown>;
  if (reply.keep === false) return { keep: false, reason: line(reply.reason, 200) };
  if (reply.keep !== true || !CARD_KINDS.includes(reply.kind as CardKind)) return undefined;
  const kind = reply.kind as CardKind;
  const what = line(reply.what, WHAT_CHARS), why = line(reply.why, WHY_CHARS);
  if (what === "" || why === "") return undefined;
  const known = new Map(projects.map(name => [name.toLowerCase(), name]));
  const named = Array.isArray(reply.projects) ? reply.projects.flatMap(each => typeof each === "string" && known.has(each.trim().toLowerCase()) ? [known.get(each.trim().toLowerCase())!] : []) : [];
  let url: string | undefined;
  try { url = typeof reply.url === "string" && reply.url.trim() !== "" ? canonicalUrl(reply.url) : undefined; } catch { url = undefined; }
  if (url !== undefined && new URL(url).hostname === "t.co") url = undefined;
  const craft = kind === "reference" ? line(reply.craft, CRAFT_CHARS) : "";
  return { keep: true, card: { kind, what, why, projects: [...new Set(named)], ...(url ? { url } : {}), ...(craft ? { craft } : {}) } };
}

/** Project names cards may carry: now.md's blocks (but Life) and the names projects.md lines lead with ("- nbrain: …"). */
export function projectNames(): string[] {
  const fromNow = readNow(["work"]).blocks.map(block => block.name);
  const fromProfile = readProfile(["work"]).filter(each => each.file === "projects.md").flatMap(each => /^\**([\w.-]+(?: \/ [\w.-]+)*)\**:\s/.exec(each.text)?.[1] ?? []);
  return [...new Map([...fromNow, ...fromProfile].map(name => [name.toLowerCase(), name])).values()];
}

/** The system message: the rules, then who the owner is and what is in flight, which every item's call shares (cached). */
function systemPrompt(projects: readonly string[]): string {
  const files = new Map<string, string[]>();
  for (const each of readProfile(["work"]).filter(each => FIT_FILES.has(each.file))) files.set(each.file, [...files.get(each.file) ?? [], `- ${each.text}`]);
  const now = readNow(["work"]);
  return [
    PROMPT, ENRICH_PROMPT,
    `# ${O}'s profile`, ...[...files].map(([file, lines]) => `## ${file}\n${lines.join("\n")}`),
    `# In flight now${now.day ? ` (${now.day})` : ""}`, ...now.blocks.map(block => `## ${block.name}\n${block.lines.join("\n")}`),
    `# Project list\n${projects.join(", ") || "(none)"}`,
  ].join("\n\n");
}

export interface ItemRow { id: string; source: string; kind: string; ext_id: string | null; thread: string | null; thread_title: string | null; title: string; at: Date; sender: string | null; sender_name: string | null; recipients: string[] | null; from_me: boolean | null; url: string | null; body: string; meta: Record<string, unknown>; origin: ItemInput["origin"]; event_id: string | null }
export interface Setup { system: string; projects: string[]; tags: string[]; model: string }

export async function triageSetup(pool: Pool): Promise<Setup> {
  const projects = projectNames();
  return { system: systemPrompt(projects), projects, tags: await usedTags(pool), model: (await roleChoice("cards")).model };
}

const textOf = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** One item read on the model: its triage and, for a saved page, its enrichment; undefined parts when the answer was unusable. */
export async function readItem(row: ItemRow, setup: Setup): Promise<{ triage?: Triage; enriched?: Enriched; answer: string }> {
  const saved = row.source === "saved";
  const chunks = saved ? enrichedChunks(row.body) : [];
  const why = textOf(row.meta.why), project = textOf(row.meta.project);
  const user = [
    `<item source=${JSON.stringify(row.source)} title=${JSON.stringify(row.title)}${row.url ? ` url=${JSON.stringify(row.url)}` : ""}>`,
    row.body.slice(0, CLIP_CHARS), row.body.length > CLIP_CHARS ? "[clipped]" : "", "</item>",
    why ? `Saved because: ${why}` : "", project ? `Saved for the project: ${project}` : "",
    saved ? enrichmentInput(chunks, setup.tags) : "",
  ].filter(Boolean).join("\n");
  const answer = await complete({ role: "cards", session: "library-triage", maxTokens: saved ? 8000 : 1000, messages: [{ role: "system", content: setup.system }, { role: "user", content: user }] });
  return { triage: parseTriage(answer, setup.projects), ...(saved ? { enriched: parseEnrichment(answer, new Set(chunks.map(chunk => chunk.part))) } : {}), answer };
}

const failures = new Map<string, number>();

async function triageOne(pool: Pool, row: ItemRow, setup: Setup): Promise<void> {
  const saved = row.source === "saved";
  const { triage, enriched, answer } = await readItem(row, setup);
  if (triage === undefined || (saved && enriched === undefined)) {
    const count = (failures.get(row.id) ?? 0) + 1;
    failures.set(row.id, count);
    console.error(`${new Date().toISOString()} library triage ${row.id} (${count}/${FAILURES}): unusable answer: ${answer.slice(0, 120).replace(/\s+/g, " ")}`);
    if (count >= FAILURES) { failures.delete(row.id); await uncarded(pool, row.id); }
    return;
  }
  failures.delete(row.id);
  const card = triage.keep ? triage.card : undefined;
  const project = textOf(row.meta.project);
  if (card && project) card.projects = [project, ...card.projects.filter(name => name.toLowerCase() !== project.toLowerCase())];
  // what a correction set stays as it set it
  const { rows: [kept] } = await pool.query<{ what: string; why: string; corrected: Record<string, string> }>("SELECT what, why, corrected FROM memory.cards WHERE item_id = $1", [row.id]);
  if (card && kept) for (const field of ["what", "why"] as const) if (kept.corrected[field]) card[field] = kept[field];
  if (card || enriched) await rewrite(pool, row, card, enriched, setup.model);
  if (!card) return uncarded(pool, row.id);
  await pool.query(
    `INSERT INTO memory.cards (id, item_id, kind, what, why, craft, projects, url, model, hash, at)
     SELECT 'card:' || i.id, i.id, $2, $3, $4, $5, $6, $7, $8, i.hash, i.at FROM memory.items i WHERE i.id = $1
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, what = excluded.what, why = excluded.why, craft = excluded.craft, projects = excluded.projects, url = excluded.url, model = excluded.model, hash = excluded.hash, at = excluded.at, updated_at = now()`,
    [row.id, card.kind, card.what, card.why, card.craft ?? null, card.projects, card.url && card.url !== row.url ? card.url : null, setup.model]);
  await pool.query("DELETE FROM memory.uncarded WHERE item_id = $1", [row.id]);
}

/** Notes the item's current version as read and not worth a card. */
async function uncarded(pool: Pool, id: string): Promise<void> {
  await pool.query("INSERT INTO memory.uncarded (item_id, hash) SELECT id, hash FROM memory.items WHERE id = $1 ON CONFLICT (item_id) DO UPDATE SET hash = excluded.hash, at = now()", [id]);
}

/** Rewrites the item's chunk contexts: the card's what and why on every chunk, then a saved page's own context, tags and reason. */
async function rewrite(pool: Pool, row: ItemRow, card: Draft | undefined, enriched: Enriched | undefined, model: string): Promise<void> {
  const cardLine = card ? `${card.what} ${card.why}` : "";
  const tagLine = enriched ? `Tags: ${enriched.tags.join(", ")}.` : "";
  const why = textOf(row.meta.why);
  const contexts = new Map(chunkBody(row.body).map(chunk => [`${chunk.part}:${sha256(chunk.text)}`,
    [cardLine, enriched?.contexts.get(chunk.part), tagLine, why ? `Saved because: ${why}` : ""].filter(Boolean).join(" ")]));
  const meta = enriched ? { ...row.meta, summary: enriched.summary, tags: enriched.tags, enriched: { model, at: new Date().toISOString() } } : row.meta;
  await writeRow(pool, row, meta, contexts);
}

/** Writes the item again with new chunk contexts (and meta); chunks whose embedding input changed are embedded again. */
async function writeRow(pool: Pool, row: ItemRow, meta: Record<string, unknown>, contexts: Map<string, string>): Promise<void> {
  await writeItems(pool, [{
    id: row.id, source: row.source, kind: row.kind, ext_id: row.ext_id, thread: row.thread, thread_title: row.thread_title, title: row.title, at: row.at, sender: row.sender,
    sender_name: row.sender_name, recipients: row.recipients ?? [], from_me: row.from_me ?? false, url: row.url, body: row.body, meta, origin: row.origin,
    event_id: row.event_id === null ? null : Number(row.event_id), contexts, force: true,
  }]);
}

/** A correction's new what and/or why for a card (`by`: correction:<id>). The card takes them and keeps them through
 *  later triage, and every chunk of its item gets the new card line in its context and a new embedding, so search stops
 *  repeating what was wrong. */
export async function correctCard(pool: Pool, id: string, fields: { what?: string | undefined; why?: string | undefined }, by: string): Promise<void> {
  const next = { what: line(fields.what, WHAT_CHARS), why: line(fields.why, WHY_CHARS) };
  const set = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== "").map(([field]) => [field, by]));
  const { rows: [old] } = await pool.query<ItemRow & { what: string; why: string }>(`SELECT ${ITEM_COLUMNS}, c.what, c.why FROM memory.cards c JOIN memory.items i ON i.id = c.item_id WHERE c.id = $1`, [id]);
  if (!old || !Object.keys(set).length) return;
  const what = next.what || old.what, why = next.why || old.why;
  await pool.query("UPDATE memory.cards SET what = $2, why = $3, corrected = corrected || $4::jsonb, updated_at = now() WHERE id = $1", [id, what, why, JSON.stringify(set)]);
  // every context starts with the card line triage wrote (rewrite above); the rest of it stays
  const { rows: chunks } = await pool.query<{ part: number; text: string; context: string }>("SELECT part, text, context FROM memory.chunks WHERE item_id = $1", [old.id]);
  const before = `${old.what} ${old.why}`, after = `${what} ${why}`;
  const contexts = new Map(chunks.map(chunk => [`${chunk.part}:${sha256(chunk.text)}`,
    chunk.context.startsWith(before) ? `${after}${chunk.context.slice(before.length)}` : [after, chunk.context].filter(Boolean).join(" ")]));
  await writeRow(pool, old, old.meta, contexts);
}

const ITEM_COLUMNS = "i.id, i.source, i.kind, i.ext_id, i.thread, i.thread_title, i.title, i.at, i.sender, i.sender_name, i.recipients, i.from_me, i.url, i.body, i.meta, i.origin, i.event_id";

const PRIVATE = (i: string) => `EXISTS (SELECT 1 FROM memory.private p WHERE p.target = ${i}.id OR p.target = 'thread:' || ${i}.source || ':' || ${i}.thread)`;

/** Bookmarks and saved pages not yet read at their current version, newest first; private ones never. */
export async function pendingItems(pool: Pool, limit: number): Promise<ItemRow[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}
     FROM memory.items i
     WHERE i.source = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM memory.cards c WHERE c.item_id = i.id AND c.hash = i.hash)
       AND NOT EXISTS (SELECT 1 FROM memory.uncarded u WHERE u.item_id = i.id AND u.hash = i.hash)
       AND NOT ${PRIVATE("i")}
     ORDER BY i.at DESC LIMIT $2`, [CARD_SOURCES, limit]);
  return rows;
}

/** Cards (or skips) for bookmarks and saved pages not yet read, a few side by side, until `deadline` (epoch ms) or none
 *  are left. Answers how many items were read. A failing model endpoint or embedder stops the run (retried next tick). */
export async function triageCards(pool: Pool, deadline: number): Promise<number> {
  let read = 0;
  let setup: Setup | undefined;
  while (Date.now() < deadline) {
    const rows = await pendingItems(pool, PARALLEL);
    if (rows.length === 0) break;
    setup ??= await triageSetup(pool);
    await Promise.all(rows.map(row => triageOne(pool, row, setup!)));
    read += rows.length;
  }
  return read;
}

interface CardRow { id: string; item_id: string; kind: CardKind; title: string; source: string; what: string; why: string; craft: string | null; projects: string[]; url: string | null; status: Card["status"]; status_note: string | null; capture: { screenshot?: string; recording?: string }; at: Date }

const CARD_SELECT = `SELECT c.id, c.item_id, c.kind, i.title, i.source, c.what, c.why, c.craft, c.projects, coalesce(c.url, i.url) AS url, c.status, c.status_note, c.capture, c.at
  FROM memory.cards c JOIN memory.items i ON i.id = c.item_id`;

const cardOf = (row: CardRow): Omit<Card, "strength"> => ({
  id: row.id, item_id: row.item_id, kind: row.kind, title: row.title, source: row.source, what: row.what, why: row.why, ...(row.craft ? { craft: row.craft } : {}),
  projects: row.projects, ...(row.url ? { url: row.url } : {}), status: row.status, ...(row.status_note ? { status_note: row.status_note } : {}),
  ...(row.capture.screenshot ? { screenshot: row.capture.screenshot } : {}), ...(row.capture.recording ? { recording: row.capture.recording } : {}), at: row.at.toISOString(),
});

/** One card by id (card:…), or undefined when there is none or its item is private. */
export async function readCard(pool: Pool, id: string): Promise<Omit<Card, "strength"> | undefined> {
  const { rows } = await pool.query<CardRow>(`${CARD_SELECT} WHERE c.id = $1 AND NOT ${PRIVATE("i")}`, [id]);
  return rows[0] && cardOf(rows[0]);
}

/** Cards for a plain description, best first, each strong or weak as search judged its item. With no strong card, `uncarded`
 *  adds the strong raw matches among the bookmarks and saves (up to five): with no card strong for the same query, they
 *  are items without one, and the model that read them judged 901 of 2,590 bookmarks not worth a card, which a person may
 *  still look for. A kind, status or project filter asks for cards, which an item with none can never match, so it adds none. */
export async function findCards(pool: Pool, input: FindCards): Promise<FoundCards> {
  const limit = Math.min(20, Math.max(1, Math.round(input.limit ?? 8)));
  const sources = CARD_SOURCES.filter(source => input.sources === undefined || input.sources.includes(source));
  if (sources.length === 0) return { cards: [], nothing_strong: true };
  const filters = { ...(input.kind ? { kind: input.kind } : {}), ...(input.status ? { status: input.status } : {}), ...(input.project ? { project: input.project } : {}) };
  const found = await search(pool, { query: input.query, source: sources, limit, ...(input.to ? { to: input.to } : {}), cards: filters });
  const { rows } = await pool.query<CardRow>(`${CARD_SELECT} WHERE c.item_id = ANY($1) AND NOT ${PRIVATE("i")}`, [found.results.map(result => result.id)]);
  const byItem = new Map(rows.map(row => [row.item_id, cardOf(row)]));
  const cards = found.results.flatMap(result => byItem.has(result.id) ? [{ ...byItem.get(result.id)!, strength: result.strength }] : []);
  if (cards.some(card => card.strength === "strong")) return { cards };
  // strength is relative to the result set, so a card weak under the card filter can be strong here: drop every item that has one
  const raw = Object.keys(filters).length > 0 ? [] : (await search(pool, { query: input.query, source: sources, limit: UNCARDED_LIMIT * 2, ...(input.to ? { to: input.to } : {}) })).results.filter(result => result.strength === "strong");
  const { rows: carded } = await pool.query<{ item_id: string }>("SELECT item_id FROM memory.cards WHERE item_id = ANY($1)", [raw.map(result => result.id)]);
  const hasCard = new Set(carded.map(row => row.item_id));
  const uncarded = raw.filter(result => !hasCard.has(result.id)).slice(0, UNCARDED_LIMIT);
  return { cards, nothing_strong: true, ...(uncarded.length ? { uncarded } : {}) };
}
