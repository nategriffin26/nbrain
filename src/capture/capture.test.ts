import { expect, it } from "vitest";
import { itemOfEvent } from "../memory/events.js";
import { parseEnrichment } from "./enrich.js";
import { savedId } from "./id.js";
import { canonicalUrl } from "./read.js";

it("canonicalizes a URL so one page is one capture", () => {
  expect(canonicalUrl("HTTPS://Example.COM/Post?utm_source=x&id=7&fbclid=abc&gclid=1&ref=tw&mc_cid=2#section")).toBe("https://example.com/Post?id=7");
  expect(canonicalUrl("https://twitter.com/ada/status/123?s=20&utm_medium=x")).toBe("https://x.com/ada/status/123?s=20");
  expect(() => canonicalUrl("ftp://example.com/a")).toThrow();
});

it("turns a capture event into a saved item signed by who saved it, with the reason searchable at once", () => {
  const event = { id: 4, kind: "capture" as const, external_id: "https://example.com/a", at: "2026-10-20T12:00:00Z", title: "A", body: "Body text.", url: "https://example.com/a", data: { why: "for the Q4 pricing plan", by: "omp", form: "pdf" } };
  const item = itemOfEvent(event)!;
  expect(item).toMatchObject({ id: savedId("https://example.com/a"), source: "saved", kind: "doc", sender: "omp", url: "https://example.com/a", meta: { form: "pdf", why: "for the Q4 pricing plan" } });
  expect([...item.contexts!.values()]).toEqual(["Saved because: for the Q4 pricing plan"]);
  expect(itemOfEvent({ ...event, data: { by: "omp", form: "note" } })).toMatchObject({ kind: "note", contexts: undefined });
});

const parts = new Set([0, 1, 2]);

it("reads the model's enrichment, fenced or not, keeping only what is usable", () => {
  const answer = '```json\n{"summary":"A paper on X.","tags":["Machine Learning","machine-learning","a","b","c","d","e"],"contexts":[{"part":0,"context":"Intro."},{"part":9,"context":"No such chunk."},{"part":1,"context":"  "}]}\n```';
  expect(parseEnrichment(answer, parts)).toEqual({ summary: "A paper on X.", tags: ["machine-learning", "a", "b", "c", "d"], contexts: new Map([[0, "Intro."]]) });
});

it("refuses an answer that is not enrichment, so it is retried", () => {
  expect(parseEnrichment("Sorry, I can't.", parts)).toBeUndefined();
  expect(parseEnrichment('{"summary":"s","tags":["t"],"contexts":[', parts)).toBeUndefined();
  expect(parseEnrichment('{"summary":"s","tags":[],"contexts":[{"part":0,"context":"c"}]}', parts)).toBeUndefined();
  expect(parseEnrichment('{"summary":"s","tags":["t"],"contexts":[{"part":7,"context":"c"}]}', parts)).toBeUndefined();
});
