import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type pg from "pg";
import type * as Models from "./models.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commit, git } from "./context/git.js";
import { applyCorrections, applyEdits, applyPrivate, nightly, type Texts, undo } from "./curator.js";
import { triageCards } from "./library/cards.js";
import { chain } from "./memory/records.js";
import { writeItems } from "./memory/store.js";
import { chunkBody, sha256 } from "./memory/text.js";
import { embedding, fakeModels, restoreFetch } from "./testai.js";
import { freshDatabase } from "./testdb.js";

vi.hoisted(() => { process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/context-curator"; });
// the model: an answer per session, and every prompt it was shown
const model = vi.hoisted(() => ({ answers: {} as Record<string, (prompt: string) => string | Promise<string>>, prompts: [] as { session: string; prompt: string }[] }));
vi.mock("./models.js", async original => ({
  ...(await original<typeof Models>()),
  roleChoice: async () => ({ model: "test-model", thinking: null }),
  complete: async (input: { session?: string; messages: { content: string }[] }) => {
    const session = input.session ?? "", prompt = input.messages.map(message => message.content).join("\n");
    model.prompts.push({ session, prompt });
    const answer = model.answers[session];
    if (!answer) throw new Error(`no answer for ${session}`);
    return answer(prompt);
  },
}));

const CONTEXT = process.env.BRAIN_CONTEXT!;
const file = (name: string) => readFile(`${CONTEXT}/${name}`, "utf8").catch(() => "");
/** A fresh context repo holding `files`, committed. */
async function context(files: Texts): Promise<void> {
  await rm(CONTEXT, { recursive: true, force: true });
  await mkdir(CONTEXT, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(`${CONTEXT}/${name}`, text);
  await commit(Object.keys(files), "start", "owner");
}
const shown = (session: string, has: string) => model.prompts.filter(each => each.session === session && each.prompt.includes(has));

const workStyle = `# How Alex works

## Always
- Lead with the outcome. <!-- owner 2026-10-20 -->

## Building
- Run the tests before every commit. <!-- correction:7 2026-10-21 -->
- Use tabs. <!-- chat:turn:a1 2026-10-19 -->
`;
const texts: Texts = { "work-style.md": workStyle, "closed.md": "" };
const rules = { day: "2026-10-22" };

it("keeps a line a correction set when the nightly pass tries to close it, and lets a later correction close it", () => {
  const close = { file: "work-style.md", line: 7, reason: "Alex said tests can wait", sources: ["omp:s1:t1"] };
  const nightly = applyEdits(texts, { close: [close], add: [] }, { ...rules, correction: false });
  expect(nightly.texts["work-style.md"]).toBe(workStyle);
  expect(nightly.skipped.map(each => each.reason)).toEqual(["set by a correction"]);

  const corrected = applyEdits(texts, { close: [{ ...close, sources: ["correction:9"] }], add: [] }, { ...rules, correction: true });
  expect(corrected.texts["work-style.md"]).not.toContain("Run the tests before every commit.");
});

it("moves a closed line to closed.md with the day, who closed it, why, and where it came from, leaving the rest", () => {
  const { texts: after } = applyEdits(texts, {
    close: [{ file: "work-style.md", line: 8, reason: "Alex switched to spaces; tabs were wrong", sources: ["correction:12"] }],
    add: [{ file: "work-style.md", section: "Building", text: "Use spaces.", sources: ["correction:12"], day: "2026-10-22" }],
  }, { ...rules, correction: true });
  expect(after["work-style.md"]).toBe(`# How Alex works

## Always
- Lead with the outcome. <!-- owner 2026-10-20 -->

## Building
- Run the tests before every commit. <!-- correction:7 2026-10-21 -->
- Use spaces. <!-- correction:12 2026-10-22 -->
`);
  expect(after["closed.md"]).toBe("# Closed\n- Use tabs. <!-- closed 2026-10-22 by correction:12: Alex switched to spaces, tabs were wrong; was chat:turn:a1 2026-10-19 -->\n");
});

it("bug: nightly closed the line below its target once an earlier close shifted the file; each close lands on the line the model saw", () => {
  const seen: Texts = { "goals.md": "# Goals\n- old A <!-- chat:a 2026-10-01 -->\n- old B <!-- chat:b 2026-10-01 -->\n- KEEP C <!-- chat:c 2026-10-01 -->\n", "closed.md": "" };
  // nightly applies each close as its own commit, on the files as the last one left them
  let now = seen;
  for (const line of [2, 3]) now = applyEdits(now, { close: [{ file: "goals.md", line, reason: "done", sources: ["chat:d"] }], add: [] }, { ...rules, correction: false }, seen).texts;
  expect(now["goals.md"]).toBe("# Goals\n- KEEP C <!-- chat:c 2026-10-01 -->\n");
});

it("bug: a close landed on whatever sat at its line number; it skips a line that changed since the model saw it", () => {
  const changed = { ...texts, "work-style.md": workStyle.replace("- Use tabs.", "- Use tabs, except in Go.") };
  const result = applyEdits(changed, { close: [{ file: "work-style.md", line: 8, reason: "spaces now", sources: ["correction:12"] }], add: [] }, { ...rules, correction: true }, texts);
  expect(result.texts["work-style.md"]).toBe(changed["work-style.md"]);
  expect(result.skipped.map(each => each.reason)).toEqual(["changed since it was shown"]);
});

it("bug: undoing A → B after B → C brought A back beside C; that undo is refused and the latest change still undoes", async () => {
  await context({ "life.md": "# Life\n\n- Lives in Austin. <!-- owner 2026-10-01 -->\n", "closed.md": "" });
  const change = async (n: number, to: string) => {
    const before = { "life.md": await file("life.md"), "closed.md": await file("closed.md") };
    const day = `2026-10-2${n}`;
    const { texts: after } = applyEdits(before, { close: [{ file: "life.md", line: 3, reason: "moved", sources: [`correction:${n}`] }], add: [{ file: "life.md", section: "", text: to, sources: [`correction:${n}`], day }] }, { day, correction: true });
    for (const [name, text] of Object.entries(after)) await writeFile(`${CONTEXT}/${name}`, text);
    return (await commit(["life.md", "closed.md"], `correction ${n}: ${to}`, "omp"))!;
  };
  const first = await change(1, "Lives in Denver.");
  const second = await change(2, "Lives in Boston.");
  const refused = await undo(first);
  expect(refused.paths).toEqual([]);
  expect(refused.refused).toMatch(/refused/);
  expect(await file("life.md")).toBe("# Life\n\n- Lives in Boston. <!-- correction:2 2026-10-22 -->\n");
  expect((await undo(second)).paths.sort()).toEqual(["closed.md", "life.md"]);
  expect(await file("life.md")).toBe("# Life\n\n- Lives in Denver. <!-- correction:1 2026-10-21 -->\n");
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("on a throwaway database", () => {
  let pool: pg.Pool;
  beforeAll(async () => { ({ pool } = await freshDatabase("curator")); fakeModels(({ body }) => embedding(body.text!)); }, 60_000);
  afterAll(async () => { restoreFetch(); await pool?.end(); });
  const item = (id: string, source: string, thread: string | null, body: string) => pool.query(
    "INSERT INTO memory.items (id, source, kind, ext_id, thread, title, at, body, hash, origin) VALUES ($1, $2, 'message', $1, $3, '', now(), $4, $1, 'event')", [id, source, thread, body]);
  const correction = async (target: string | null, text: string) => (await pool.query<{ id: string }>("INSERT INTO memory.corrections (target, text, by) VALUES ($1, $2, 'omp') RETURNING id::text", [target, text])).rows[0]!.id;

  it("bug: marking private left derived lines in the profile, closed.md and now.md; they leave within the tick", async () => {
    await item("chat:1", "chat", "t1", "Alex: my sister is unwell");
    await item("chat:2", "chat", "t2", "Alex: I like tea");
    await item("mail:9", "gmail", "m9", "Clinic invoice");
    await pool.query("INSERT INTO memory.records (id, item_id, type, title, at, extractor) VALUES ('r-9', 'mail:9', 'bill', 'Clinic', now(), 'test')");
    await pool.query("INSERT INTO memory.private (target, by) VALUES ('thread:chat:t1', 'omp'), ('mail:9', 'omp')");
    await correction("chat:1#0", "SECRET-CORRECTION about the sister");
    await correction("chat:2", "PLAIN-CORRECTION tea, not coffee");
    await context({
      "life.md": "# Life\n\n- Sister is unwell. <!-- chat:1#2 2026-10-20 -->\n- Pays the clinic monthly. <!-- r-9 2026-10-20 -->\n- Likes tea. <!-- chat:2 2026-10-20 -->\n- Lives in Austin. <!-- owner 2026-10-01 -->\n",
      "closed.md": "# Closed\n- Sister is fine. <!-- closed 2026-10-20 by chat:1: Alex said otherwise; was owner 2026-10-01 -->\n- Drinks coffee. <!-- closed 2026-10-20 by chat:2: Alex likes tea now; was owner 2026-10-01 -->\n",
    });
    model.answers.now = () => '{"blocks":[{"key":"life","lines":["Dentist on Friday."]}]}';

    expect(await applyPrivate(pool)).toBe(3);
    expect(await file("life.md")).toBe("# Life\n\n- Likes tea. <!-- chat:2 2026-10-20 -->\n- Lives in Austin. <!-- owner 2026-10-01 -->\n");
    expect(await file("closed.md")).toBe("# Closed\n- Drinks coffee. <!-- closed 2026-10-20 by chat:2: Alex likes tea now; was owner 2026-10-01 -->\n");
    expect(await git(["log", "-1", "--format=%B", "--", "life.md"])).not.toMatch(/sister|clinic/i);
    expect(await file("now.md")).toContain("- Dentist on Friday.");
    expect(shown("now", "PLAIN-CORRECTION")).toHaveLength(1);
    expect(shown("now", "SECRET-CORRECTION")).toHaveLength(0);
    expect(shown("now", "sister")).toHaveLength(0);

    // now.md is written again only when something new is marked
    expect(await applyPrivate(pool)).toBe(0);
    expect(model.prompts.filter(each => each.session === "now")).toHaveLength(1);
    await pool.query("INSERT INTO memory.private (target, by) VALUES ('chat:2', 'omp')");
    expect(await applyPrivate(pool)).toBe(2);
    expect(model.prompts.filter(each => each.session === "now")).toHaveLength(2);
    expect(await file("life.md")).toBe("# Life\n\n- Lives in Austin. <!-- owner 2026-10-01 -->\n");
  });

  it("bug: a correction about a private item showed the model that item's text", async () => {
    await item("chat:3", "chat", "t3", "Alex: I moved to a new flat");
    await pool.query("INSERT INTO memory.private (target, by) VALUES ('chat:3', 'omp')");
    await item("chat:4", "chat", "t4", "Alex: the cat is called Miso");
    await correction("chat:3", "PRIVATE-TARGET fix");
    await correction("chat:4", "OPEN-TARGET fix");
    model.answers["curator-corrections"] = () => '{"summary":"nothing"}';
    await applyCorrections(pool);
    expect(shown("curator-corrections", "PRIVATE-TARGET")).toHaveLength(1);
    expect(shown("curator-corrections", "new flat")).toHaveLength(0);
    expect(shown("curator-corrections", "OPEN-TARGET")[0]!.prompt).toContain("the cat is called Miso");
  });

  it("bug: nightly closed the line below its target; the two lines it was shown close and the third stays", async () => {
    await context({ "goals.md": "# Goals\n- Ship v1 by Friday. <!-- owner 2026-10-01 -->\n- Learn Rust. <!-- owner 2026-10-01 -->\n- Run a marathon. <!-- owner 2026-10-01 -->\n", "closed.md": "" });
    await item("chat:n1", "chat", "n1", "Alex: v1 shipped today, and I dropped Rust for now");
    model.answers["curator-nightly"] = () => JSON.stringify({ close: [
      { file: "goals.md", line: 2, reason: "shipped", source: "chat:n1", quote: "v1 shipped today" },
      { file: "goals.md", line: 3, reason: "dropped", source: "chat:n1", quote: "dropped Rust for now" },
    ], add: [] });
    expect(await nightly(pool, new Date(Date.now() + 60_000))).toHaveLength(2);
    expect(await file("goals.md")).toBe("# Goals\n- Run a marathon. <!-- owner 2026-10-01 -->\n");
  });

  it("bug: a correction applied its line numbers to files a nightly commit had moved meanwhile; it closes the line it saw", async () => {
    await context({ "work-style.md": workStyle, "closed.md": "" });
    const id = await correction(null, "TABS-WRONG: Alex uses spaces");
    model.answers["curator-corrections"] = async prompt => {
      if (!prompt.includes("TABS-WRONG")) return '{"summary":"nothing"}';
      // a nightly commit lands while the model answers: a line above the target
      await writeFile(`${CONTEXT}/work-style.md`, workStyle.replace("## Always\n", "## Always\n- Short replies. <!-- chat:x 2026-10-22 -->\n"));
      return '{"close":[{"file":"work-style.md","line":8,"reason":"spaces"}],"summary":"tabs closed"}';
    };
    await applyCorrections(pool);
    expect(await file("work-style.md")).toBe(workStyle.replace("## Always\n", "## Always\n- Short replies. <!-- chat:x 2026-10-22 -->\n").replace("- Use tabs. <!-- chat:turn:a1 2026-10-19 -->\n", ""));
    expect(await file("closed.md")).toContain(`- Use tabs. <!-- closed `);
    expect(await file("closed.md")).toContain(`by correction:${id}`);
  });

  it("bug: re-extraction un-retracted a record a correction retracted; it stays retracted and what it superseded is current", async () => {
    await item("mail:a", "gmail", "a", "Acme bill $10");
    await item("mail:b", "gmail", "b", "Acme bill $10 again");
    const key = "bill|acme|10|2026-10-01";
    await pool.query(`INSERT INTO memory.records (id, item_id, type, org, title, at, extractor, same_as) VALUES
      ('rec:mail:a', 'mail:a', 'bill', 'Acme', 'Acme', now() - interval '1 day', 'extraction:test', $1), ('rec:mail:b', 'mail:b', 'bill', 'Acme', 'Acme', now(), 'extraction:test', $1)`, [key]);
    await chain(pool, key);
    const id = await correction("rec:mail:b", "RETRACT: billed once only");
    model.answers["curator-corrections"] = prompt => prompt.includes("RETRACT:") ? '{"retract":["rec:mail:b"],"summary":"retracted"}' : '{"summary":"nothing"}';
    await applyCorrections(pool);
    await chain(pool, key); // the next extraction in that group
    const { rows } = await pool.query("SELECT id, superseded_by FROM memory.records WHERE same_as = $1 ORDER BY id", [key]);
    expect(rows).toEqual([{ id: "rec:mail:a", superseded_by: null }, { id: "rec:mail:b", superseded_by: `correction:${id}` }]);
  });

  it("bug: a corrected card kept its old claim in search and triage overwrote it; chunks carry the correction and triage keeps it", async () => {
    const post = (body: string) => ({ id: "x:1", source: "x", kind: "post", ext_id: "1", title: "Gridish", at: new Date("2026-10-01T12:00:00Z"), body, origin: "event" as const });
    const body = "Gridish is out: a grid for dense layouts.";
    await writeItems(pool, [{ ...post(body), contexts: new Map(chunkBody(body).map(chunk => [`${chunk.part}:${sha256(chunk.text)}`, "Old what. Old why."])) }]);
    await pool.query("INSERT INTO memory.cards (id, item_id, kind, what, why, model, hash, at) SELECT 'card:x:1', id, 'tool', 'Old what.', 'Old why.', 'm', hash, at FROM memory.items WHERE id = 'x:1'");
    const chunk = async () => (await pool.query<{ context: string; embedding: string }>("SELECT context, embedding::text FROM memory.chunks WHERE item_id = 'x:1' AND part = 0")).rows[0]!;
    const before = await chunk();
    const id = await correction("card:x:1", "CARD-FIX: it is a typeface, not a grid");
    model.answers["curator-corrections"] = prompt => prompt.includes("CARD-FIX") ? '{"card":{"what":"Gridish Sans, a typeface."},"summary":"card fixed"}' : '{"summary":"nothing"}';
    await applyCorrections(pool);
    const card = async () => (await pool.query("SELECT what, why, corrected FROM memory.cards WHERE id = 'card:x:1'")).rows[0];
    expect(await card()).toEqual({ what: "Gridish Sans, a typeface.", why: "Old why.", corrected: { what: `correction:${id}` } });
    const after = await chunk();
    expect(after.context).toBe("Gridish Sans, a typeface. Old why.");
    expect(after.embedding).not.toBe(before.embedding);

    // the post changes, triage reads it again and proposes its own what and why
    await writeItems(pool, [post(`${body} Now with variable widths.`)]);
    model.answers["library-triage"] = () => '{"keep": true, "kind": "tool", "what": "A grid for layouts.", "why": "Fits dense tables.", "projects": []}';
    expect(await triageCards(pool, Date.now() + 60_000)).toBe(1);
    expect(await card()).toEqual({ what: "Gridish Sans, a typeface.", why: "Fits dense tables.", corrected: { what: `correction:${id}` } });
    expect((await chunk()).context).toBe("Gridish Sans, a typeface. Fits dense tables.");
  }, 60_000);
});
