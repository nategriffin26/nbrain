import { beforeEach, expect, it, vi } from "vitest";
import type { Result, SearchInput } from "../memory/search.js";
import { freshDatabase } from "../testdb.js";
import { findCards } from "./cards.js";

// Search needs the embedder and reranker, which do not run here: it is faked over a fixed set of items, honouring the
// source list and the cards filter the way the real one does. Cards and the card lookup are the real tables.
// rawStrength: the strength the item has in a search without the cards filter, where the result set differs
const items: Record<string, { source: string; strength: Result["strength"]; rawStrength?: Result["strength"]; carded: boolean }> = {
  "x:strong-card": { source: "x", strength: "strong", carded: true },
  "x:weak-card": { source: "x", strength: "weak", carded: true },
  "x:weak-card-strong-raw": { source: "x", strength: "weak", rawStrength: "strong", carded: true },
  "x:skipped-1": { source: "x", strength: "strong", carded: false },
  "x:skipped-2": { source: "x", strength: "strong", carded: false },
  "x:skipped-weak": { source: "x", strength: "weak", carded: false },
  "saved:skipped": { source: "saved", strength: "strong", carded: false },
};
const result = (id: string, input: SearchInput): Result => ({ id, chunk: `${id}#0`, title: id, date: "2026-10-01", who: "", source: items[id]!.source, kind: "post", quote: "", strength: (!input.cards && items[id]!.rawStrength) || items[id]!.strength, why: "" });
let order: string[] = [];
const calls: SearchInput[] = [];

vi.mock("../memory/search.js", () => ({
  search: async (_pool: unknown, input: SearchInput) => {
    calls.push(input);
    const ids = order.filter(id => (input.source ?? [items[id]!.source]).includes(items[id]!.source) && (!input.cards || items[id]!.carded));
    const results = ids.slice(0, input.limit).map(id => result(id, input));
    return { results, ...(results.some(each => each.strength === "strong") ? {} : { nothing_strong: true }), ms: 0, channels: {} };
  },
}));

beforeEach(() => { calls.length = 0; });

async function library() {
  const { pool } = await freshDatabase("find");
  for (const [id, item] of Object.entries(items)) {
    await pool.query("INSERT INTO memory.items (id, source, kind, title, at, body, hash, origin) VALUES ($1, $2, 'post', $1, now(), 'body', $1, 'event')", [id, item.source]);
    if (item.carded) await pool.query("INSERT INTO memory.cards (id, item_id, kind, what, why, model, hash, at) VALUES ($1, $2, 'tool', 'w', 'y', 'm', 'h', now())", [`card:${id}`, id]);
  }
  return pool;
}

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: a bookmark the reading model skipped was invisible to the library; with no strong card its strong raw matches come back as uncarded", async () => {
  const pool = await library();
  try {
    order = ["x:weak-card", "x:skipped-weak", "x:skipped-1", "saved:skipped", "x:skipped-2"];
    const found = await findCards(pool, { query: "q" });
    expect(found.nothing_strong).toBe(true);
    expect(found.cards.map(card => card.id)).toEqual(["card:x:weak-card"]);
    // strong only, in search's order: the weak skipped item and the weak card stay out
    expect(found.uncarded?.map(each => each.id)).toEqual(["x:skipped-1", "saved:skipped", "x:skipped-2"]);
    // a raw search names only the card sources, so research notes and mail never come back as uncarded
    expect(calls.every(call => call.source?.every(source => ["x", "saved"].includes(source)))).toBe(true);
  } finally { await pool.end(); }
}, 60_000);

it.runIf(!!process.env.TEST_DATABASE_URL)("a strong card answers as before: no uncarded field, no nothing_strong", async () => {
  const pool = await library();
  try {
    order = ["x:strong-card", "x:skipped-1"];
    const found = await findCards(pool, { query: "q" });
    expect(found.cards.map(card => card.id)).toEqual(["card:x:strong-card"]);
    expect(found).not.toHaveProperty("uncarded");
    expect(found).not.toHaveProperty("nothing_strong");
  } finally { await pool.end(); }
}, 60_000);

it.runIf(!!process.env.TEST_DATABASE_URL)("uncarded stays within the caller's sources, at most five, and is absent under a card filter or with nothing matching", async () => {
  const pool = await library();
  try {
    order = ["x:skipped-1", "saved:skipped", "x:skipped-2"];
    expect((await findCards(pool, { query: "q", sources: ["saved", "omp"] })).uncarded?.map(each => each.id)).toEqual(["saved:skipped"]);
    // a kind filter asks for cards: an item with none cannot match it
    expect(await findCards(pool, { query: "q", kind: "tool" })).not.toHaveProperty("uncarded");
    // nothing strong anywhere: no empty list
    order = ["x:skipped-weak"];
    expect(await findCards(pool, { query: "q" })).not.toHaveProperty("uncarded");
    // a work-scope caller with no card source gets nothing and no search
    calls.length = 0;
    expect(await findCards(pool, { query: "q", sources: ["omp"] })).toEqual({ cards: [], nothing_strong: true });
    expect(calls).toEqual([]);
    for (let n = 1; n <= 7; n++) {
      items[`x:many-${n}`] = { source: "x", strength: "strong", carded: false };
      await pool.query("INSERT INTO memory.items (id, source, kind, title, at, body, hash, origin) VALUES ($1, 'x', 'post', $1, now(), 'body', $1, 'event')", [`x:many-${n}`]);
    }
    order = Object.keys(items).filter(id => id.startsWith("x:many-"));
    expect((await findCards(pool, { query: "q" })).uncarded).toHaveLength(5);
  } finally { await pool.end(); }
}, 60_000);

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: strength is relative to the result set, so a carded item weak among cards came back strong in the raw search and was listed as uncarded", async () => {
  const pool = await library();
  try {
    order = ["x:weak-card", "x:weak-card-strong-raw", "x:skipped-1"];
    const found = await findCards(pool, { query: "q" });
    expect(found.cards.map(card => card.id)).toEqual(["card:x:weak-card", "card:x:weak-card-strong-raw"]);
    expect(found.uncarded?.map(each => each.id)).toEqual(["x:skipped-1"]);
  } finally { await pool.end(); }
}, 60_000);
