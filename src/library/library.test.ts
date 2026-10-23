import { expect, it, vi } from "vitest";
import { freshDatabase } from "../testdb.js";
import { capturable, captureCards, moves } from "./capture.js";
import { parseTriage } from "./cards.js";

// a machine with no Chrome: playwright's launch fails as it does there
vi.mock("playwright-core", () => ({ chromium: { launch: async () => { throw new Error("Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nRun \"npx playwright install chrome\""); } } }));

const projects = ["nbrain", "stepper-composer"];

it("reads a kept card, fenced, keeping only listed projects (as listed) and craft only on references", () => {
  const answer = '```json\n{"keep": true, "kind": "tool", "what": "  Paper Mono,\\n a free mono font. ", "why": "Fits the dense tables in nbrain.", "projects": ["NBRAIN", "made-up", 3, "nbrain"], "url": "https://paper.design/mono?utm_source=x#top", "craft": "Squared curves."}\n```';
  expect(parseTriage(answer, projects)).toEqual({ keep: true, card: { kind: "tool", what: "Paper Mono, a free mono font.", why: "Fits the dense tables in nbrain.", projects: ["nbrain"], url: "https://paper.design/mono" } });
  const reference = parseTriage('{"keep": true, "kind": "reference", "what": "A site.", "why": "Restraint.", "projects": [], "craft": "Large type, one column."}', projects);
  expect(reference).toMatchObject({ card: { kind: "reference", craft: "Large type, one column." } });
});

it("reads a skip with its reason", () => {
  expect(parseTriage('{"keep": false, "reason": "a joke"}', projects)).toEqual({ keep: false, reason: "a joke" });
});

it("drops a url that is not the thing itself: a short link or not a web address", () => {
  const card = (url: string) => parseTriage(JSON.stringify({ keep: true, kind: "tool", what: "w", why: "y", projects: [], url }), projects);
  expect(card("https://t.co/abc")).toMatchObject({ card: { kind: "tool" } });
  expect(card("https://t.co/abc")).not.toHaveProperty("card.url");
  expect(card("javascript:alert(1)")).not.toHaveProperty("card.url");
  expect(card("not a url")).not.toHaveProperty("card.url");
});

it("refuses an answer that is not a triage, so it is retried", () => {
  expect(parseTriage("I can't help with that.", projects)).toBeUndefined();
  expect(parseTriage('{"keep": "yes", "kind": "tool", "what": "w", "why": "y"}', projects)).toBeUndefined();
  expect(parseTriage('{"keep": true, "kind": "gadget", "what": "w", "why": "y"}', projects)).toBeUndefined();
  expect(parseTriage('{"keep": true, "kind": "tool", "what": " ", "why": "y"}', projects)).toBeUndefined();
  expect(parseTriage('{"keep": true, "kind": "tool", "what": "w"}', projects)).toBeUndefined();
});

it("captures reference cards whose url is a web page, nothing else", () => {
  expect(capturable({ kind: "reference", url: "https://arbresearch.com/" })).toBe(true);
  expect(capturable({ kind: "reference", url: "http://fluid.example.com/demo" })).toBe(true);
  expect(capturable({ kind: "tool", url: "https://arbresearch.com/" })).toBe(false);
  expect(capturable({ kind: "reference", url: null })).toBe(false);
  for (const url of ["https://x.com/paper/status/1", "https://twitter.com/a/status/1", "https://mobile.twitter.com/a", "https://t.co/abc", "https://www.youtube.com/watch?v=1", "https://youtu.be/1", "https://example.com/deck.pdf", "https://example.com/shot.PNG", "ftp://example.com/a", "not a url"])
    expect(capturable({ kind: "reference", url }), url).toBe(false);
  // a host that only contains x.com is still a web page
  expect(capturable({ kind: "reference", url: "https://box.com/x" })).toBe(true);
  expect(capturable({ kind: "reference", url: "https://index.com/" })).toBe(true);
});

it("records a page that moves: a playing video, or half a percent of the screen changing", () => {
  expect(moves({ videos: 0, changed: 0 })).toBe(false);
  expect(moves({ videos: 0, changed: 0.0049 })).toBe(false);
  expect(moves({ videos: 0, changed: 0.005 })).toBe(true);
  expect(moves({ videos: 1, changed: 0 })).toBe(true);
});

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: with no Chrome every capture run failed; it stops, logs once and leaves the cards for later", async () => {
  const { pool } = await freshDatabase("library");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const n of [1, 2]) {
      await pool.query("INSERT INTO memory.items (id, source, kind, title, at, body, hash, origin) VALUES ($1, 'x', 'post', '', now(), 'a site', $1, 'event')", [`x:${n}`]);
      await pool.query("INSERT INTO memory.cards (id, item_id, kind, what, why, url, model, hash, at) VALUES ($1, $2, 'reference', 'w', 'y', $3, 'm', 'h', now())", [`card:x:${n}`, `x:${n}`, `https://example.com/${n}`]);
    }
    expect(await captureCards(pool, Date.now() + 30_000)).toBe(0);
    expect((await pool.query("SELECT capture FROM memory.cards ORDER BY id")).rows).toEqual([{ capture: {} }, { capture: {} }]);
    expect(errors.mock.calls.filter(call => String(call[0]).includes("no browser"))).toHaveLength(1);
  } finally {
    errors.mockRestore();
    await pool.end();
  }
}, 60_000);
