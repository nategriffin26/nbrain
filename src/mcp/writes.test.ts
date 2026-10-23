import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIBRARY_TOOLS } from "../library/mcp.js";
import { freshDatabase, schemaSql } from "../testdb.js";
import { embedding, fakeModels, restoreFetch } from "../testai.js";
import { type Agent, type Call, ScopeError } from "./types.js";
import { privateTarget, WRITE_TOOLS } from "./writes.js";

const work: Agent = { name: "omp", scopes: ["work", "write"], signer: "omp" };
const life: Agent = { name: "bot", scopes: ["life", "write"], signer: "bot" };
const text = { source: "imessage", thread: "chat42" };

describe("privateTarget", () => {
  it("refuses an item outside the token's scope exactly as one that does not exist, so a refusal reveals nothing", () => {
    const refusal = (item: typeof text | undefined) => { try { privateTarget(work, "imessage:1", item, false); } catch (error) { return error; } };
    const outOfScope = refusal(text), missing = refusal(undefined);
    expect(outOfScope).toBeInstanceOf(ScopeError);
    expect((outOfScope as Error).message).toBe((missing as Error).message);
  });

  it("refuses a token that may read nothing", () => {
    expect(() => privateTarget({ name: "w", scopes: ["write"], signer: "w" }, "x:1", { source: "x", thread: null }, false)).toThrow(ScopeError);
  });

  it("marks the item itself when the token may open it", () => {
    expect(privateTarget(life, "imessage:1", text, false)).toBe("imessage:1");
    expect(privateTarget(work, "x:9", { source: "x", thread: null }, false)).toBe("x:9");
  });

  it("marks the whole thread as thread:<source>:<thread>", () => {
    expect(privateTarget(life, "imessage:1", text, true)).toBe("thread:imessage:chat42");
  });

  it("refuses thread: true for an item with no thread instead of storing a target that matches nothing", () => {
    expect(() => privateTarget(life, "gmail:7", { source: "gmail", thread: null }, true)).toThrow(ScopeError);
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("memory_writer's grants", () => {
  let admin: pg.Pool, writer: pg.Pool, reader: pg.Pool;
  beforeAll(async () => {
    const db = await freshDatabase("writes");
    admin = db.pool;
    // as the live install had it: memory_writer made a member of memory_reader
    await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'memory_writer') THEN CREATE ROLE memory_writer NOLOGIN; END IF; END $$");
    await admin.query("GRANT memory_reader TO memory_writer");
    await admin.query(await schemaSql());
    writer = new pg.Pool({ connectionString: db.url, options: "-c role=memory_writer" });
    reader = new pg.Pool({ connectionString: db.url, options: "-c role=memory_reader" });
    fakeModels(({ body }) => embedding(body.text!));
  }, 60_000);
  afterAll(async () => { restoreFetch(); await Promise.all([writer?.end(), reader?.end(), admin?.end()]); });

  it("bug: memory_writer inherited memory_reader and could read every item; it cannot, and every write works on its own grants", async () => {
    expect((await admin.query("SELECT pg_has_role('memory_writer', 'memory_reader', 'MEMBER') AS member, has_table_privilege('memory_writer', 'memory.items', 'SELECT') AS reads")).rows[0]).toEqual({ member: false, reads: false });
    await expect(writer.query("SELECT count(*) FROM memory.items")).rejects.toThrow(/permission denied/);

    const call: Call = { agent: { name: "omp", scopes: ["work", "life", "write"], signer: "omp" }, reader, writer, local: true };
    const first = await WRITE_TOOLS.remember!.run(call, { text: "Prefers short replies." }) as { kept: boolean; id: string };
    expect(first.kept).toBe(true);
    expect(await WRITE_TOOLS.remember!.run(call, { text: "Prefers short replies." })).toMatchObject({ kept: false, id: first.id });
    expect(await WRITE_TOOLS.private!.run(call, { id: first.id })).toMatchObject({ target: first.id, private: true, changed: true });
    expect(await WRITE_TOOLS.private!.run(call, { id: first.id, private: false })).toMatchObject({ target: first.id, private: false, changed: true });
    expect(await WRITE_TOOLS.correct!.run(call, { id: first.id, text: "It was long replies." })).toMatchObject({ kept: true });
    await admin.query("INSERT INTO memory.cards (id, item_id, kind, what, why, model, hash, at) VALUES ('card:' || $1, $1, 'tool', 'w', 'y', 'm', 'h', now())", [first.id]);
    await LIBRARY_TOOLS.library_mark!.run(call, { id: `card:${first.id}`, status: "tried", note: "worked" });
    await expect(LIBRARY_TOOLS.library_mark!.run(call, { id: "card:none", status: "tried", note: "x" })).rejects.toThrow(/No card/);
    const { rows } = await admin.query("SELECT (SELECT count(*)::int FROM memory.items) AS items, (SELECT count(*)::int FROM memory.private) AS private, (SELECT text FROM memory.corrections) AS correction, (SELECT status FROM memory.cards) AS status");
    expect(rows[0]).toEqual({ items: 1, private: 0, correction: "It was long replies.", status: "tried" });
  }, 60_000);
});
