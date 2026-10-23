import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { brief, BUDGET, compose, ompToken, projectBlock, sortFound } from "./brief.js";
import type { NowBlock } from "./context/profile.js";
import { embedding, fakeModels, never, refused, restoreFetch, serverError } from "./testai.js";
import { freshDatabase } from "./testdb.js";

vi.hoisted(() => { process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/context-brief"; });

describe.runIf(!!process.env.TEST_DATABASE_URL)("brief without its embeddings", () => {
  const agent = { name: "omp", scopes: ["work" as const], signer: "omp" };
  /** A brief over a profile of `work` lines, with the warnings it logged. */
  async function briefOver(work: string[]): Promise<{ text: string; warned: string; ms: number }> {
    const dir = process.env.BRAIN_CONTEXT!;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/basics.md`, `# Basics\n\n## Always\n- Plain words, outcome first.\n\n## Work\n${work.map(line => `- ${line}`).join("\n")}\n`);
    const { pool } = await freshDatabase("brief");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const text = await brief(agent, { task: "add a test for the parser" }, pool);
      return { text, warned: warn.mock.calls.map(call => String(call[0])).join("\n"), ms: Date.now() - started };
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  }

  it("bug: a failed task embedding (Ollama down) failed the whole brief; it logs and keeps the profile's own order", async () => {
    fakeModels(() => refused);
    try {
      const { text, warned } = await briefOver(["Tests name the bug they catch.", "Ship small changes."]);
      expect(warned).toMatch(/embed: fetch failed/);
      expect(text).toContain("Plain words, outcome first.");
      expect(text.indexOf("Tests name the bug they catch.")).toBeLessThan(text.indexOf("Ship small changes."));
    } finally {
      restoreFetch();
    }
  }, 60_000);

  it("bug: a cold profile's lines had no deadline though the task's embedding was quick; the whole step gives up at its deadline", async () => {
    // the task's and the search queries' embeddings answer; the profile lines' never do
    fakeModels(call => call.model === "@cf/cloudflare/clef" ? [500, serverError] : call.body.text!.every(text => text.startsWith("Instruct:")) ? embedding(call.body.text!) : never());
    try {
      const { text, warned, ms } = await briefOver(["Commit messages say why.", "Keep functions short."]);
      expect(ms).toBeLessThan(8000);
      expect(warned).toMatch(/embed: .*timeout/);
      expect(text.indexOf("Commit messages say why.")).toBeLessThan(text.indexOf("Keep functions short."));
    } finally {
      restoreFetch();
    }
  }, 70_000);
});

const lines = (prefix: string, count: number, chars = 80) => Array.from({ length: count }, (_, at) => `${prefix} ${at} ${"x".repeat(chars)}`);

describe("compose", () => {
  it("stays within the budget on a long profile, the 18-27 KB start-of-task dump it replaces", () => {
    const text = compose({ always: lines("always", 10), near: lines("near", 200, 300), now: { blocks: [{ name: "nbrain", lines: lines("- now", 60, 200) }, { name: "atlas", lines: lines("- atlas", 30) }] }, earlier: lines("- earlier", 5, 200), pointers: lines("- pointer", 5) });
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text.match(/^- pointer/gm)).toHaveLength(3);
  });

  it("cuts near lines before Always lines or the project's block when it runs long", () => {
    // always + now + pointers ≈ 3.4 KB; the near lines alone would add 6 KB
    const always = lines("always", 10, 150), now = lines("- now", 10, 150), near = lines("near", 12, 500);
    const text = compose({ always, near, now: { blocks: [{ name: "nbrain", lines: now }] }, earlier: [], pointers: lines("- pointer", 3) }, BUDGET);
    for (const line of [...always, ...now]) expect(text).toContain(line);
    expect(near.filter(line => text.includes(line)).length).toBeLessThan(near.length);
    expect(text).toContain(near[0]);
  });

  it("cuts the near lines before the other now blocks (a week's summary lost its blocks to marginal rules)", () => {
    const near = lines("near", 20, 300), other = lines("- other", 10, 150);
    const text = compose({ always: [], near, now: { blocks: [{ name: "nbrain", lines: ["- first"] }, { name: "atlas", lines: other }] }, earlier: [], pointers: [] }, 3000);
    for (const line of other) expect(text).toContain(line);
    expect(text).toContain("- first");
    expect(near.filter(line => text.includes(line)).length).toBeLessThan(near.length);
  });

  it("puts the rules first (Always, then nearest), then now (the project's block first), then the record, then what to load", () => {
    const text = compose({ always: ["always rule"], near: ["near rule"], now: { day: "2026-10-22", blocks: [{ name: "nbrain", lines: ["- shipping the brief"] }, { name: "atlas", lines: ["- atlas line"] }] }, earlier: ["- Oct 21 · omp · a session [omp:1]"], pointers: ["- styles/plain"] });
    const at = ["always rule", "near rule", "## Now (2026-10-22)", "### nbrain", "- shipping the brief", "### atlas", "- atlas line", "## Earlier on this", "omp:1", "## Worth loading", "- styles/plain"].map(part => text.indexOf(part));
    expect(at.every(index => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text.match(/## Now/g)).toHaveLength(1);
  });

  it("keeps at most three record results, and keeps them over near lines when it runs long", () => {
    const earlier = lines("- earlier", 5, 200), near = lines("near", 20, 300);
    const text = compose({ always: [], near, earlier, pointers: [] }, 2000);
    expect(earlier.slice(0, 3).every(line => text.includes(line))).toBe(true);
    expect(text.includes(earlier[3]!)).toBe(false);
    expect(near.filter(line => text.includes(line)).length).toBeLessThan(near.length);
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
