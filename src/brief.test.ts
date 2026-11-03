import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { brief, BUDGET, compose, ompToken, PICKED, projectBlock, readPick, sortFound } from "./brief.js";
import type { NowBlock } from "./context/profile.js";
import type * as Models from "./models.js";
import { fakeModels, refused, restoreFetch } from "./testai.js";
import { freshDatabase } from "./testdb.js";

vi.hoisted(() => { process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/context-brief"; });
// the pick's model: `answer` gets the call and returns its reply, throws, or never settles
const model = vi.hoisted(() => ({ answer: (_input: { signal?: AbortSignal }): Promise<string> => Promise.reject(new Error("no answer set")) }));
vi.mock("./models.js", async original => ({
  ...(await original<typeof Models>()),
  complete: (input: { signal?: AbortSignal }) => model.answer(input),
}));

describe.runIf(!!process.env.TEST_DATABASE_URL)("brief and its pick", () => {
  const agent = { name: "omp", scopes: ["work" as const], signer: "omp" };
  /** A brief over a profile of `work` lines and a now.md of two blocks, with the warnings it logged. */
  async function briefOver(work: string[], project?: string): Promise<{ text: string; warned: string; ms: number }> {
    const dir = process.env.BRAIN_CONTEXT!;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/basics.md`, `# Basics\n\n## Always\n- Plain words, outcome first.\n\n## Work\n${work.map(line => `- ${line}`).join("\n")}\n`);
    writeFileSync(`${dir}/now.md`, "# Now · 2026-11-03\n\n## parser\n- Parser rewrite half done.\n\n## kitchen\n- Meal plan for the week.\n");
    const { pool } = await freshDatabase("brief");
    // search's own models are down too; the brief goes out without record results
    fakeModels(() => refused);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const text = await brief(agent, { task: "add a test for the parser", ...(project ? { project } : {}) }, pool);
      return { text, warned: warn.mock.calls.map(call => String(call[0])).join("\n"), ms: Date.now() - started };
    } finally {
      warn.mockRestore();
      restoreFetch();
      await pool.end();
    }
  }

  it("shows the picked lines in the model's order and no others, and the block it picked when none is the project's", async () => {
    model.answer = async () => '{"lines": [3, 1], "block": "parser"}';
    const { text } = await briefOver(["Tests name the bug they catch.", "Ship small changes.", "Parser errors carry the line number."], "~/Projects/new-repo");
    expect(text.indexOf("Parser errors carry the line number.")).toBeLessThan(text.indexOf("Tests name the bug they catch."));
    expect(text).not.toContain("Ship small changes.");
    expect(text).toContain("### parser");
    expect(text).not.toContain("### kitchen");
  }, 60_000);

  it("keeps the profile's own order and shows no other project's block when the pick fails", async () => {
    model.answer = async () => { throw new TypeError("fetch failed"); };
    const { text, warned } = await briefOver(["Tests name the bug they catch.", "Ship small changes."]);
    expect(warned).toMatch(/brief pick: fetch failed/);
    expect(text).toContain("Plain words, outcome first.");
    expect(text.indexOf("Tests name the bug they catch.")).toBeLessThan(text.indexOf("Ship small changes."));
    expect(text).not.toContain("## Now");
  }, 60_000);

  it("gives up on a pick that never answers at its deadline, and the brief goes out", async () => {
    model.answer = ({ signal }) => {
      const { promise, reject } = Promise.withResolvers<string>();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      return promise;
    };
    const { text, warned, ms } = await briefOver(["Commit messages say why."]);
    expect(ms).toBeLessThan(15_000);
    expect(warned).toMatch(/brief pick: .*(timeout|aborted)/i);
    expect(text).toContain("Commit messages say why.");
  }, 70_000);
});

describe("readPick", () => {
  it("drops numbers outside the list, repeats and a block name it was not offered (each reached the brief as a missing line or block)", () => {
    expect(readPick('{"lines": [0, 2, 2, 5, 1], "block": "atlas"}', 3, ["parser"])).toEqual({ lines: [1, 0] });
  });
  it("matches the block by name in any case, and reads a reply with words around its JSON", () => {
    expect(readPick('Here: {"lines": [], "block": "Parser"} done', 2, ["parser"])).toEqual({ lines: [], block: "parser" });
  });
  it(`keeps at most ${PICKED} lines, the first ones the model gave (a model returned 52 lines against a limit of 12)`, () => {
    const numbers = Array.from({ length: 52 }, (_, at) => at + 1);
    expect(readPick(JSON.stringify({ lines: numbers, block: null }), 60, []).lines).toEqual(numbers.slice(0, PICKED).map(number => number - 1));
  });
  it("throws on a reply that is not the shape asked for", () => {
    expect(() => readPick('{"picked": [1]}', 3, [])).toThrow();
  });
});

const lines = (prefix: string, count: number, chars = 80) => Array.from({ length: count }, (_, at) => `${prefix} ${at} ${"x".repeat(chars)}`);

describe("compose", () => {
  it("stays within the budget on a long profile, the 18-27 KB start-of-task dump it replaces", () => {
    const text = compose({ always: lines("always", 10), picked: lines("picked", 200, 300), now: { name: "nbrain", lines: lines("- now", 60, 200) }, earlier: lines("- earlier", 5, 200), pointers: lines("- pointer", 5) });
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text.match(/^- pointer/gm)).toHaveLength(3);
  });

  it("cuts picked lines before Always lines or the project's block when it runs long", () => {
    // always + now + pointers ≈ 3.4 KB; the picked lines alone would add 6 KB
    const always = lines("always", 10, 150), now = lines("- now", 10, 150), picked = lines("picked", 12, 500);
    const text = compose({ always, picked, now: { name: "nbrain", lines: now }, earlier: [], pointers: lines("- pointer", 3) }, BUDGET);
    for (const line of [...always, ...now]) expect(text).toContain(line);
    expect(picked.filter(line => text.includes(line)).length).toBeLessThan(picked.length);
    expect(text).toContain(picked[0]);
  });

  it("puts the rules first (Always, then picked), then now, then the record, then what to load", () => {
    const text = compose({ always: ["always rule"], picked: ["picked rule"], now: { day: "2026-10-22", name: "nbrain", lines: ["- shipping the brief"] }, earlier: ["- Oct 21 · omp · a session [omp:1]"], pointers: ["- styles/plain"] });
    const at = ["always rule", "picked rule", "## Now (2026-10-22)", "### nbrain", "- shipping the brief", "## Earlier on this", "omp:1", "## Worth loading", "- styles/plain"].map(part => text.indexOf(part));
    expect(at.every(index => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text.match(/## Now/g)).toHaveLength(1);
  });

  it("has no Now heading when there is no block", () => {
    expect(compose({ always: ["always rule"], picked: [], earlier: [], pointers: [] })).not.toContain("## Now");
  });

  it("keeps at most three record results, and keeps them over picked lines when it runs long", () => {
    const earlier = lines("- earlier", 5, 200), picked = lines("picked", 12, 300);
    const text = compose({ always: [], picked, earlier, pointers: [] }, 2000);
    expect(earlier.slice(0, 3).every(line => text.includes(line))).toBe(true);
    expect(text.includes(earlier[3]!)).toBe(false);
    expect(picked.filter(line => text.includes(line)).length).toBeLessThan(picked.length);
  });
});

describe("projectBlock", () => {
  const blocks: NowBlock[] = [
    { name: "nbrain", dirs: ["/Users/someone/Projects/nbrain"], lines: [], life: false },
    { name: "Stepper rig", dirs: ["/Users/someone/Projects/stepper", "stepper"], lines: [], life: false },
  ];
  it("finds the block from a directory inside the project (omp passes its cwd)", () => {
    expect(projectBlock(blocks, "/Users/someone/Projects/nbrain/src/mcp")?.name).toBe("nbrain");
  });
  it("does not take a sibling directory that shares a prefix for the project", () => {
    expect(projectBlock(blocks, "/Users/someone/Projects/nbrain2")).toBeUndefined();
  });
  it("finds the block by its name or a bare name in its dirs, any case", () => {
    expect(projectBlock(blocks, "NBRAIN")?.name).toBe("nbrain");
    expect(projectBlock(blocks, "stepper")?.name).toBe("Stepper rig");
  });
  it("finds nothing for no project", () => {
    expect(projectBlock(blocks, undefined)).toBeUndefined();
    expect(projectBlock(blocks, "  ")).toBeUndefined();
  });
});

describe("sortFound", () => {
  const hit = (id: string, source: string) => ({ id, source });

  it("shows a carded bookmark once, as a thing to load, not also as a record result (it filled Earlier on this and the pointers)", () => {
    const found = [hit("x:1", "x"), hit("omp:a", "omp"), hit("x:2", "x")];
    const { earlier, cards } = sortFound(found, new Set(["x:1"]), new Set(), false);
    expect(cards.map(each => each.id)).toEqual(["x:1"]);
    expect(earlier.map(each => each.id)).toEqual(["omp:a", "x:2"]);
  });

  it("keeps search's order among cards", () => {
    const { cards } = sortFound([hit("x:3", "x"), hit("saved:1", "saved"), hit("x:1", "x")], new Set(["x:1", "x:3", "saved:1"]), new Set(), true);
    expect(cards.map(each => each.id)).toEqual(["x:3", "saved:1", "x:1"]);
  });

  it("puts the project's own sessions first, then other work, then texts and mail, each in search's order", () => {
    const found = [hit("imessage:1", "imessage"), hit("omp:other", "omp"), hit("gmail:1", "gmail"), hit("omp:own", "omp"), hit("chat:1", "chat")];
    const { earlier } = sortFound(found, new Set(), new Set(["omp:own"]), true);
    expect(earlier.map(each => each.id)).toEqual(["omp:own", "omp:other", "chat:1", "imessage:1", "gmail:1"]);
  });

  it("leaves search's order alone with no project", () => {
    const found = [hit("imessage:1", "imessage"), hit("omp:other", "omp"), hit("gmail:1", "gmail")];
    expect(sortFound(found, new Set(), new Set(), false).earlier.map(each => each.id)).toEqual(["imessage:1", "omp:other", "gmail:1"]);
  });
});

describe("ompToken", () => {
  const brain = new URL("http://127.0.0.1:8830/mcp");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("finds the brain's token under whatever name omp gave the server (it looked only under nbrain)", () => {
    const servers = { tools: { url: "http://127.0.0.1:4312/mcp?mode=model", headers: auth("other") }, "my-memory": { url: "http://127.0.0.1:8830/mcp", headers: auth("brain") } };
    expect(ompToken(servers, brain)).toBe("brain");
  });

  it("matches a trailing slash but not another port or path", () => {
    expect(ompToken({ a: { url: "http://127.0.0.1:8830/mcp/", headers: auth("slash") } }, brain)).toBe("slash");
    expect(ompToken({ a: { url: "http://127.0.0.1:8831/mcp", headers: auth("port") } }, brain)).toBeUndefined();
    expect(ompToken({ a: { url: "http://127.0.0.1:8830/other", headers: auth("path") } }, brain)).toBeUndefined();
  });

  it("falls back to the entry named nbrain, and skips entries with no url or a bad one", () => {
    expect(ompToken({ broken: { url: "not a url", headers: auth("broken") }, nbrain: { headers: auth("named") } }, brain)).toBe("named");
  });

  it("finds nothing without servers or a bearer header", () => {
    expect(ompToken(undefined, brain)).toBeUndefined();
    expect(ompToken({ a: { url: "http://127.0.0.1:8830/mcp", headers: { Authorization: "Basic abc" } } }, brain)).toBeUndefined();
  });
});
