import type pg from "pg";
import { expect, it, vi } from "vitest";
import type * as Models from "../models.js";
import { freshDatabase } from "../testdb.js";
import { extractRecords, messageText, parseExtracted } from "./records.js";

const answers = vi.hoisted(() => new Map<string, string>());
vi.mock("../models.js", async original => ({
  ...(await original<typeof Models>()),
  roleChoice: async () => ({ model: "test-model", thinking: "off" }),
  complete: async (input: { messages: { content: string }[] }) => answers.get(input.messages.at(-1)!.content.split("\n").at(-1)!) ?? '{"kind":"none"}',
}));

it("reads the model's JSON, with or without a fence, into a record", () => {
  const json = '{"kind":"due","org":"Ascent","amount":176.77,"due_date":"2026-06-05","paid_date":null,"starts_at":null,"ref":null}';
  const expected = { kind: "due", org: "Ascent", amount: 176.77, due_date: "2026-06-05", paid_date: null, starts_at: null, ref: null };
  expect(parseExtracted(json)).toEqual(expected);
  expect(parseExtracted(`\`\`\`json\n${json}\n\`\`\``)).toEqual(expected);
});

it("keeps only what is shaped like a value", () => {
  expect(parseExtracted('{"kind":"paid","org":" ","amount":"$1,456.00","due_date":"soon","paid_date":"2026-02-03","starts_at":"2026-02-05T12:00:00","ref":""}'))
    .toEqual({ kind: "paid", org: null, amount: 1456, due_date: null, paid_date: "2026-02-03", starts_at: "2026-02-05T12:00", ref: null });
});

it("reads none, a refusal and prose as no record", () => {
  expect(parseExtracted('{"kind":"none","org":null,"amount":null,"due_date":null,"paid_date":null,"starts_at":null,"ref":null}')).toBeUndefined();
  expect(parseExtracted("I can't help with that.")).toBeUndefined();
  expect(parseExtracted("{not json}")).toBeUndefined();
});

it("shows the model a mail or text with its local receipt time, sender and capped body", () => {
  const text = messageText({ source: "gmail", at: new Date("2026-02-03T17:17:00Z"), sender: "a@b.com", sender_name: "Acme Bank", title: "Due soon", body: "x".repeat(9000) });
  expect(text.startsWith("Email received 2026-02-03 11:17 (America/Chicago) from Acme Bank.\nSubject: Due soon\n\n")).toBe(true);
  expect(text.length).toBe("Email received 2026-02-03 11:17 (America/Chicago) from Acme Bank.\nSubject: Due soon\n\n".length + 8000);
  expect(messageText({ source: "imessage", at: new Date("2025-11-03T14:45:00Z"), sender: "+15555550123", title: "", body: "hi" }))
    .toBe("Text message received 2025-11-03 08:45 (America/Chicago) from +15555550123.\nSubject: \n\nhi");
});

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: re-reading an item as no record left the record before it superseded by nothing, so it dropped out of every current view", async () => {
  const { pool } = await freshDatabase("records");
  try {
    const bodies = { a: "Acme invoice $10 due Oct 5, first notice", b: "Acme invoice $10 due Oct 5, second notice" };
    for (const [id, at] of [["a", "2026-10-01"], ["b", "2026-10-02"]] as const) {
      await pool.query("INSERT INTO memory.items (id, source, kind, ext_id, title, at, body, hash, origin) VALUES ($1, 'gmail', 'message', $1, '', $2, $3, $1, 'event')", [id, at, bodies[id]]);
      answers.set(bodies[id], '{"kind":"due","org":"Acme","amount":10,"due_date":"2026-10-05"}');
    }
    await extractRecords(pool, Date.now() + 60_000);
    const chained = () => pool.query("SELECT id, supersedes, superseded_by FROM memory.records ORDER BY id").then(result => result.rows);
    expect(await chained()).toEqual([{ id: "rec:a", supersedes: null, superseded_by: "rec:b" }, { id: "rec:b", supersedes: "rec:a", superseded_by: null }]);

    answers.set(bodies.b, '{"kind":"none"}');
    await pool.query("DELETE FROM memory.extracted WHERE item_id = 'b'");
    await extractRecords(pool, Date.now() + 60_000);
    expect(await chained()).toEqual([{ id: "rec:a", supersedes: null, superseded_by: null }]);
  } finally {
    await pool.end();
  }
}, 60_000);

const DUE = '{"kind":"due","org":"Acme","amount":10,"due_date":"2026-10-05"}';
const NONE = '{"kind":"none"}';
const BODIES = { a: "Acme invoice $10 due Oct 5, notice one", b: "Acme invoice $10 due Oct 5, notice two", c: "Acme invoice $10 due Oct 5, notice three" };
const later = () => Date.now() + 60_000;
/** Three notices of one bill, read: a superseded by b superseded by c. */
async function threeNotices(name: string): Promise<pg.Pool> {
  const { pool } = await freshDatabase(name);
  for (const [id, at] of [["a", "2026-10-01"], ["b", "2026-10-02"], ["c", "2026-10-03"]] as const) {
    await pool.query("INSERT INTO memory.items (id, source, kind, ext_id, title, at, body, hash, origin) VALUES ($1, 'gmail', 'message', $1, '', $2, $3, $1, 'event')", [id, at, BODIES[id]]);
    answers.set(BODIES[id], DUE);
  }
  await extractRecords(pool, later());
  return pool;
}
const rows = (pool: pg.Pool) => pool.query("SELECT id, supersedes, superseded_by, amount::float FROM memory.records ORDER BY id").then(result => result.rows);
const reread = (pool: pg.Pool, id: string) => pool.query("DELETE FROM memory.extracted WHERE item_id = $1", [id]);

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: a re-read deleted or rewrote a record a correction had retracted; it stays as the correction left it", async () => {
  const pool = await threeNotices("records_corrected");
  try {
    await pool.query("UPDATE memory.records SET superseded_by = 'correction:7' WHERE id = 'rec:b'");
    for (const answer of [NONE, '{"kind":"due","org":"Acme","amount":99,"due_date":"2026-10-09"}']) {
      answers.set(BODIES.b, answer);
      await reread(pool, "b");
      await extractRecords(pool, later());
      expect((await rows(pool)).find(row => row.id === "rec:b")).toMatchObject({ superseded_by: "correction:7", amount: 10 });
    }
    expect((await pool.query("SELECT state FROM memory.extracted WHERE item_id = 'b'")).rows).toEqual([{ state: "read" }]);
  } finally { await pool.end(); }
}, 60_000);

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: a write that failed after deleting a record lost it and left its chain unlinked; the item's write is all or nothing", async () => {
  const pool = await threeNotices("records_atomic");
  try {
    await pool.query(`CREATE FUNCTION refuse_mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'read' THEN RAISE EXCEPTION 'mark refused'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER refuse_mark BEFORE INSERT OR UPDATE ON memory.extracted FOR EACH ROW WHEN (NEW.item_id = 'b') EXECUTE FUNCTION refuse_mark()`);
    answers.set(BODIES.b, NONE);
    await reread(pool, "b");
    await extractRecords(pool, later());
    expect(await rows(pool)).toEqual([
      { id: "rec:a", supersedes: null, superseded_by: "rec:b", amount: 10 },
      { id: "rec:b", supersedes: "rec:a", superseded_by: "rec:c", amount: 10 },
      { id: "rec:c", supersedes: "rec:b", superseded_by: null, amount: 10 },
    ]);
    expect((await pool.query("SELECT state FROM memory.extracted WHERE item_id = 'b'")).rows).toEqual([{ state: "failed" }]);
  } finally { await pool.end(); }
}, 60_000);

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: workers re-reading one chain at once interleaved their relinks; a write waits for the chain's lock, then relinks", async () => {
  const pool = await threeNotices("records_lock");
  const holder = await pool.connect();
  try {
    const key = "bill|acme|10|2026-10-05";
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    answers.set(BODIES.b, NONE);
    await reread(pool, "b");
    let finished = false;
    const run = extractRecords(pool, later()).then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect({ finished, records: (await rows(pool)).length }).toEqual({ finished: false, records: 3 });
    await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    await run;
    expect(await rows(pool)).toEqual([
      { id: "rec:a", supersedes: null, superseded_by: "rec:c", amount: 10 },
      { id: "rec:c", supersedes: "rec:a", superseded_by: null, amount: 10 },
    ]);
  } finally { holder.release(); await pool.end(); }
}, 60_000);
