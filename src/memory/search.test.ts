import { describe, expect, it } from "vitest";
import { containsTerm, currentSql, foldKey, matchesDate, read as readItem, sameOrder, strengthOf, visibleSql } from "./search.js";
import pg from "pg";
import { dateMention } from "./text.js";
import { changes } from "./changes.js";

const row = { item_id: "mail:a", source: "gmail", thread: "thread-a", same_as: null, org: null, ref: null };
describe("look-alikes", () => {
  it("folds a mail thread without merging unrelated threads", () => {
    expect(foldKey(row)).toBe(foldKey({ ...row, item_id: "mail:b" }));
    expect(foldKey(row)).not.toBe(foldKey({ ...row, thread: "thread-b" }));
  });
  it("folds order updates across threads by merchant and reference, not merchant alone", () => {
    const order = { ...row, org: "Example Shop", ref: "ABC-123" };
    expect(foldKey(order)).toBe(foldKey({ ...order, thread: "other", org: "example shop", ref: "abc-123" }));
    expect(foldKey(order)).not.toBe(foldKey({ ...order, ref: "abc-124" }));
    expect(foldKey({ ...order, same_as: "order|x|1" })).toBe("record:order|x|1");
  });
  it("never folds unrelated messages merely because their chat matches", () => {
    expect(foldKey({ ...row, source: "imessage" })).not.toBe(foldKey({ ...row, source: "imessage", item_id: "text:b" }));
  });
  it("folds receipt preheaders without collapsing two known order numbers or a later purchase", () => {
    const first = { source: "gmail", title: 'Ordered: "Desk lamp..."', org: "Example.com", ref: null, at: new Date("2026-01-02") };
    expect(sameOrder(first, { ...first, title: 'Delivered: "Desk lamp..."', org: "Example", at: new Date("2026-01-06") })).toBe(true);
    expect(sameOrder({ ...first, ref: "a" }, { ...first, ref: "b" })).toBe(false);
    expect(sameOrder(first, { ...first, at: new Date("2026-02-06") })).toBe(false);
    expect(sameOrder(first, { ...first, title: 'Delivered: "Desk chair..."' })).toBe(false);
  });
});
it("does not call a low-score or out-of-date answer strong", () => {
  expect(strengthOf(0, true, false)).toBe("weak");
  expect(strengthOf(1, true, false)).toBe("strong");
  expect(strengthOf(0.79999, true, false)).toBe("weak");
  expect(strengthOf(0.8, true, false)).toBe("strong");
  expect(strengthOf(0.80001, true, false)).toBe("strong");
  expect(strengthOf(1, true, true, false)).toBe("weak");
  expect(strengthOf(0.98999, true, false, true, 0.99)).toBe("weak");
  expect(strengthOf(0.99, true, false, true, 0.99)).toBe("strong");
  expect(strengthOf(1, false, true)).toBe("weak");
  expect(strengthOf(undefined, true, false)).toBe("weak");
  expect(strengthOf(undefined, true, true)).toBe("strong");
});
it("accepts decisive or exact evidence without treating a close-score or wrong-subject hit as strong", () => {
  expect(strengthOf(0.6, true, false, true, 0.99, 0.2)).toBe("strong");
  expect(strengthOf(0.6, true, false, true, 0.99, 0.09)).toBe("weak");
  expect(strengthOf(0.6, true, false, false, 0.99, 0.2)).toBe("weak");
  expect(strengthOf(0.2, true, true, true, 0.99)).toBe("strong");
  expect(strengthOf(0.995, true, false, false, 0.99, 0, true)).toBe("strong");
  expect(strengthOf(1, false, true, true, 0.99, 0.5, true)).toBe("weak");
});
it("does not ground a model identifier in an unrelated substring", () => {
  expect(containsTerm("Model Y is an example", "x")).toBe(false);
  expect(containsTerm("Your Model X order", "x")).toBe(true);
  expect(containsTerm("OpenRouter.com", "openrouter")).toBe(true);
});
it("accepts a nearby message discussing the requested day, not an unrelated or distant message", () => {
  const date = dateMention("slots November 11, 2026", new Date("2026-10-22"))!;
  expect(matchesDate(date, new Date("2026-10-19"), "Wednesday November 11th, 1pm")).toBe(true);
  expect(matchesDate(date, new Date("2026-10-19"), "Wednesday November 12th, 1pm")).toBe(false);
  expect(matchesDate(date, new Date("2023-10-19"), "November 11th, 1pm")).toBe(false);
  expect(matchesDate(date, new Date("2026-11-11T18:00:00Z"), "See you there")).toBe(true);
});
it.runIf(!!process.env.TEST_DATABASE_URL)("excludes private items, threads and private record provenance", async () => {
  if (!new URL(process.env.TEST_DATABASE_URL!).pathname.startsWith("/nbrain_t_")) throw new Error("Use a throwaway nbrain_t_ database.");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await pool.query("CREATE SCHEMA memory; CREATE TABLE memory.items (id text, source text, thread text, meta jsonb); CREATE TABLE memory.private(target text PRIMARY KEY); INSERT INTO memory.items VALUES ('a','gmail','one','{}'),('b','gmail','two','{}'),('c','gmail','three','{}'),('rec:a','record',null,'{\"item\":\"a\"}'); INSERT INTO memory.private VALUES ('a'),('thread:gmail:two')");
    expect((await pool.query(`SELECT i.id FROM memory.items i WHERE ${visibleSql("i")} ORDER BY i.id`)).rows).toEqual([{ id: "c" }]);
  } finally { await pool.query("DROP SCHEMA memory CASCADE"); await pool.end(); }
});

async function accessFixture() {
  if (!new URL(process.env.TEST_DATABASE_URL!).pathname.startsWith("/nbrain_t_")) throw new Error("Use a throwaway nbrain_t_ database.");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(`CREATE SCHEMA memory;
    CREATE TABLE memory.items (id text PRIMARY KEY, source text DEFAULT 'note', kind text DEFAULT 'note', thread text, title text DEFAULT '', thread_title text, at timestamptz DEFAULT '2026-01-02T12:00:00Z', body text DEFAULT 'fixture body', meta jsonb DEFAULT '{}', sender text, sender_name text, from_me boolean DEFAULT false, url text);
    CREATE TABLE memory.private (target text PRIMARY KEY);
    CREATE TABLE memory.chunks (item_id text, part int, start_at int, heading text);
    CREATE TABLE memory.people (id text, name text, kind text);
    CREATE TABLE memory.item_people (item_id text, person_id text, role text);
    CREATE TABLE memory.records (id text PRIMARY KEY, superseded_by text);
    INSERT INTO memory.items (id) VALUES ('hidden');
    INSERT INTO memory.items (id,source,thread) VALUES ('thread-item','gmail','secret');
    INSERT INTO memory.private VALUES ('hidden'),('thread:gmail:secret');
    INSERT INTO memory.items (id,source) VALUES ('old','record'),('latest','record'),('retracted','record');
    INSERT INTO memory.records VALUES ('old','latest'),('latest',null),('retracted','correction:7')`);
  return pool;
}

it.runIf(!!process.env.TEST_DATABASE_URL)("requires explicit private access and life scope for item, chunk and thread fetches", async () => {
  const pool = await accessFixture();
  try {
    for (const id of ["hidden", "hidden#0", "thread-item"]) {
      await expect(readItem(pool, id)).rejects.toThrow("Nothing in memory");
      await expect(readItem(pool, id, undefined, { private: true, life: false })).rejects.toThrow("Nothing in memory");
      await expect(readItem(pool, id, undefined, { life: true })).rejects.toThrow("Nothing in memory");
      expect(await readItem(pool, id, undefined, { private: true, life: true })).toMatchObject({ text: "fixture body" });
    }
  } finally { await pool.query("DROP SCHEMA memory CASCADE"); await pool.end(); }
});

it.runIf(!!process.env.TEST_DATABASE_URL)("omits replaced and correction-retracted records from search eligibility and changes, but not explicit fetch", async () => {
  const pool = await accessFixture();
  try {
    expect((await pool.query(`SELECT i.id FROM memory.items i WHERE source='record' AND ${currentSql("i")}`)).rows).toEqual([{ id: "latest" }]);
    const result = await changes(pool, { since: "2026-01-01", source: ["record"] }, new Date("2026-01-03"));
    expect(result.counts).toEqual({ record: 1 });
    expect(result.threads.map(thread => thread.latest.id)).toEqual(["latest"]);
    expect(await readItem(pool, "old")).toMatchObject({ id: "old", text: "fixture body" });
  } finally { await pool.query("DROP SCHEMA memory CASCADE"); await pool.end(); }
});
