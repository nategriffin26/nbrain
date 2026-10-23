import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { containsTerm, currentSql, foldKey, matchesDate, read as readItem, renderResults, sameOrder, search, type SearchResult, strengthOf, visibleSql } from "./search.js";
import pg from "pg";
import { dateMention } from "./text.js";
import { changes } from "./changes.js";
import { freshDatabase } from "../testdb.js";
import { type Call, clef, embedding, fakeModels, refused, restoreFetch, serverError } from "../testai.js";

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
it("bug: a hit the judge gives even odds or better stayed weak under the cross-encoder's 0.8 bar; from 0.5 it is strong", () => {
  expect(strengthOf(0.49999, true, false, true)).toBe("weak");
  expect(strengthOf(0.5, true, false, true)).toBe("strong");
  expect(strengthOf(0.50001, true, false, true)).toBe("strong");
});
it("a judged hit outside the query's dates or without a name it names is weak however sure the judge is, and holding every word does not lift a low score", () => {
  expect(strengthOf(1, false, true, true)).toBe("weak");
  expect(strengthOf(1, true, true, false)).toBe("weak");
  expect(strengthOf(0.1, true, true, true)).toBe("weak");
});
it("with no judge, a hit is strong only in range, covered and holding every word that matters", () => {
  expect(strengthOf(undefined, true, true, true)).toBe("strong");
  expect(strengthOf(undefined, true, false, true)).toBe("weak");
  expect(strengthOf(undefined, false, true, true)).toBe("weak");
  expect(strengthOf(undefined, true, true, false)).toBe("weak");
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

describe.runIf(!!process.env.TEST_DATABASE_URL)("literal search and folded history", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    ({ pool } = await freshDatabase("exact"));
    const items = [
      ["literal", "note", "2026-01-02T12:00:00Z", "", "The rate is 50%_off [a+b].\\done", null],
      ["wildcard", "note", "2026-01-03T12:00:00Z", "", "The rate is 500Xoff aaabXdone", null],
      ["title-only", "note", "2026-01-04T12:00:00Z", "50%_OFF [a+b].\\done", "Unrelated body", null],
      ["phrase-old", "note", "2026-01-01T12:00:00Z", "", "cerulean hinge", null],
      ["phrase-new", "note", "2026-01-02T12:00:00Z", "", "cerulean hinge", null],
      ["phrase-split", "note", "2026-01-03T12:00:00Z", "", "cerulean metal hinge", null],
      ["private-item", "note", "2026-01-02T14:00:00Z", "", "cerulean hinge", null],
      ["private-thread", "gmail", "2026-01-02T15:00:00Z", "", "cerulean hinge", "hidden"],
      ["wrong-source", "saved", "2026-01-02T16:00:00Z", "", "cerulean hinge", null],
      ["code", "gmail", "2026-01-02T17:00:00Z", "Verification code", "cerulean hinge 123456", null],
      ["old-record", "record", "2026-01-02T18:00:00Z", "", "cerulean hinge", null],
      ["private-record", "record", "2026-01-02T19:00:00Z", "", "cerulean hinge", null],
      ["mail-shipped", "gmail", "2026-01-02T12:00:00Z", "Shipped: copper lantern", "copper lantern shipment", "order"],
      ["mail-delivered", "gmail", "2026-01-03T12:00:00Z", "Delivered: copper lantern", "copper lantern delivered", "order"],
      ["mail-ordered", "gmail", "2026-01-01T12:00:00Z", "Ordered: copper lantern", "copper lantern ordered", "order"],
      ["text-one", "imessage", "2026-01-02T12:00:00Z", "", "cerulean hinge ready", "chat"],
      ["text-two", "imessage", "2026-01-02T12:10:00Z", "", "cerulean hinge collected", "chat"],
      ["window", "note", "2026-01-05T12:00:00Z", "", `${"prefix ".repeat(150)}FIRST cerulean hinge${" filler".repeat(150)}SECOND cerulean hinge cerulean hinge`, null],
    ];
    for (const [id, source, at, title, body, thread] of items) {
      await pool.query(`INSERT INTO memory.items (id,source,kind,at,title,body,thread,hash,origin) VALUES ($1,$2,'message',$3,$4,$5,$6,'fixture','event')`, [id, source, at, title, body, thread]);
    }
    await pool.query(`INSERT INTO memory.chunks (item_id,part,start_at,end_at,heading,people,context,text,embed_hash,embedding)
      SELECT id,0,0,length(body),title,'','',body,'fixture',$1::halfvec FROM memory.items`, [`[${Array(1024).fill(0.01).join(",")}]`]);
    await pool.query(`INSERT INTO memory.people(id,kind,name) VALUES ('person:casey','person','Casey Example');
      INSERT INTO memory.item_people SELECT id,'person:casey','recipient' FROM memory.items WHERE id NOT IN ('wrong-source','phrase-old');
      INSERT INTO memory.private(target,by) VALUES ('private-item','test'),('thread:gmail:hidden','test');
      INSERT INTO memory.records(id,item_id,type,at,extractor,superseded_by) VALUES ('old-record','phrase-old','order','2026-01-01','test','correction:1');
      UPDATE memory.items SET meta = '{"item":"private-item"}' WHERE id = 'private-record'`);
  }, 30_000);
  afterAll(async () => { await pool?.end(); });

  it.each(["", " ", "\t\r\n"])("does not treat blank exact query %j as strong evidence", async query => {
    const result = await search(pool, { query, exact: true });
    expect(result).toMatchObject({ results: [], nothing_strong: true });
  });

  it("matches percent, underscore, backslash and regex characters only literally in body or title", async () => {
    for (const query of ["50%_off", "[a+b].\\done", "%", "_", "\\", "[a+b]"]) {
      const result = await search(pool, { query, exact: true });
      expect(result.results.map(hit => hit.id)).toEqual(["title-only", "literal"]);
      expect(result.results.every(hit => hit.strength === "strong")).toBe(true);
      expect(result.nothing_strong).toBeUndefined();
    }
  });

  it("keeps the entire exact phrase and explicit person, source and inclusive day filters", async () => {
    const result = await search(pool, { query: "CERULEAN HINGE", exact: true, person: "Casey Example", source: ["note"], from: "2026-01-02", to: "2026-01-02" });
    expect(result.results.map(hit => hit.id)).toEqual(["phrase-new"]);
    expect(result.person).toEqual([{ id: "person:casey", name: "Casey Example" }]);
    expect((await search(pool, { query: "cerulean hinge", exact: true, person: "Casey Example", source: ["note"] })).results.map(hit => hit.id)).toEqual(["window", "phrase-new"]);
    const visible = await search(pool, { query: "cerulean hinge", exact: true, from: "2026-01-02", to: "2026-01-02" });
    expect(visible.results.map(hit => hit.id)).toEqual(["wrong-source", "text-two", "phrase-new"]);
    expect(visible.results.find(hit => hit.id === "text-two")?.folded).toBeUndefined();
    expect(visible.results.find(hit => hit.id === "text-two")?.quote).toContain("cerulean hinge ready");
    const privateResult = await search(pool, { query: "cerulean hinge", exact: true, source: ["note"], from: "2026-01-02", to: "2026-01-02", private: true });
    expect(privateResult.results.map(hit => hit.id)).toEqual(["private-item", "phrase-new"]);
    expect((await search(pool, { query: "cerulean hinge", exact: true, person: "Nobody Here" })).nothing_strong).toBe(true);
    expect((await search(pool, { query: "cerulean hinge 123456", exact: true })).results.map(hit => hit.id)).toEqual(["code"]);
  });

  it("shows folded mail history oldest first including the displayed item and renders each id", async () => {
    const result = await search(pool, { query: "copper lantern", exact: true, source: ["gmail"] });
    const hit = result.results[0]!;
    expect(result.results).toHaveLength(1);
    expect(hit.id).toBe("mail-delivered");
    expect(hit.more).toBe(2);
    expect(hit.folded).toEqual([
      { id: "mail-ordered", date: "2026-01-01T12:00:00.000Z", title: "Ordered: copper lantern" },
      { id: "mail-shipped", date: "2026-01-02T12:00:00.000Z", title: "Shipped: copper lantern" },
      { id: "mail-delivered", date: "2026-01-03T12:00:00.000Z", title: "Delivered: copper lantern" },
    ]);
    const rendered = renderResults(result.results);
    expect(rendered).toContain("Jan 1, 2026 · Ordered: copper lantern (mail-ordered)");
    expect(rendered).toContain("Jan 2, 2026 · Shipped: copper lantern (mail-shipped)");
    expect(rendered).toContain("Jan 3, 2026 · Delivered: copper lantern (mail-delivered)");
    expect(rendered.indexOf("Jan 1, 2026 · Ordered:")).toBeLessThan(rendered.indexOf("Jan 2, 2026 · Shipped:"));
  });

  it("quotes the first literal match rather than a later denser window and abstains only on no match", async () => {
    const result = await search(pool, { query: "cerulean hinge", exact: true, source: ["note"] });
    expect(result.results.map(hit => hit.id)).toEqual(["window", "phrase-new", "phrase-old"]);
    expect(result.results[0]!.quote).toContain("FIRST cerulean hinge");
    expect(result.results[0]!.quote).not.toContain("SECOND");
    expect(await search(pool, { query: "nonexistent-phrase-%_[x]", exact: true })).toMatchObject({ results: [], nothing_strong: true });
  });

  it("finds unchunked items with the models down", async () => {
    await pool.query(`INSERT INTO memory.items(id,source,kind,at,title,body,hash,origin)
      VALUES ('unchunked','note','note','2026-01-06','Waiting to index','raw literal evidence','fixture','event')`);
    fakeModels(() => refused);
    try {
      const result = await search(pool, { query: "raw literal evidence", exact: true });
      expect(result.results.map(hit => hit.id)).toEqual(["unchunked"]);
      expect(result.results[0]).toMatchObject({ quote: "raw literal evidence", strength: "strong" });
    } finally {
      restoreFetch();
      await pool.query("DELETE FROM memory.items WHERE id = 'unchunked'");
    }
  });

  const strengths = (result: SearchResult) => Object.fromEntries(result.results.map(hit => [hit.id, hit.strength]));
  const vectors = (call: Call) => embedding(call.body.text!, () => Array<number>(1024).fill(0.01));

  it("bug: a failing judge (Workers AI 500) must not fail the search: it logs and falls back to holding every word", async () => {
    fakeModels(call => call.model === "@cf/cloudflare/clef" ? [500, serverError] : vectors(call));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await search(pool, { query: "cerulean metal hinge", limit: 30 });
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(/judge: @cf\/cloudflare\/clef 500/);
      expect(strengths(result)).toMatchObject({ "phrase-split": "strong", "phrase-new": "weak", window: "weak" });
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("bug: a failed query embedding (Ollama down) failed the whole search; it logs and searches without the meaning channel", async () => {
    fakeModels(call => call.model === "@cf/cloudflare/clef" ? clef(Object.fromEntries(Object.keys(call.body.state!.results).map(n => [`r${n}`, 0.9]))) : refused);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await search(pool, { query: "cerulean metal hinge", limit: 30 });
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(/embed: fetch failed/);
      expect(result.channels.meaning).toBe(0);
      expect(strengths(result)).toMatchObject({ "phrase-split": "strong" });
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("each hit the judge saw is strong by its own answer, from 0.5, whatever words it holds", async () => {
    const asked: string[] = [];
    fakeModels(call => {
      if (call.model !== "@cf/cloudflare/clef") return vectors(call);
      asked.push(call.body.state!.query);
      return clef(Object.fromEntries(Object.entries(call.body.state!.results).map(([n, text]) => [`r${n}`, text.includes("cerulean metal hinge") ? 0.5 : 0.49])));
    });
    try {
      const result = await search(pool, { query: "cerulean hinge", limit: 30 });
      expect(asked).toEqual(["cerulean hinge"]);
      expect(result.results[0]).toMatchObject({ id: "phrase-split", strength: "strong" });
      expect(strengths(result)).toMatchObject({ "phrase-new": "weak", "phrase-old": "weak", window: "weak" });
      expect(Object.values(strengths(result)).filter(strength => strength === "strong")).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });
});
