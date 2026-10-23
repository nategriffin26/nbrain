import { expect, it } from "vitest";
import type { Result as Hit } from "../memory/search.js";
import { evalDue, type Result, scoreQuestion, searchInput, summarize } from "./recall.js";

const hit = (strength: Hit["strength"], quote: string): Hit => ({ id: "gmail:1", chunk: "gmail:1#0", title: "Order", date: "2026-10-01T12:00:00Z", who: "Shop", source: "gmail", kind: "email", quote, strength, why: "words" });

it("bug: a question with no answer passed vacuously (no facts, none missing) even when search answered it strongly", () => {
  const trip = { id: "fp-1", category: "false-premise", query: "Which airline did I book for the Iceland trip?", absent: true };
  expect(scoreQuestion(trip, { results: [hit("strong", "Your flight to Reykjavik is booked")] }).ok).toBe(false);
  expect(scoreQuestion(trip, { results: [hit("weak", "Iceland photos")], nothing_strong: true }).ok).toBe(true);
  expect(scoreQuestion(trip, { results: [], nothing_strong: true }).ok).toBe(true);
});

it("an answerable question still needs every fact shown, strong or weak", () => {
  const order = { id: "q-1", category: "money", query: "What did the order cost?", facts: ["$42.10", "AB12"] };
  expect(scoreQuestion(order, { results: [hit("weak", "Total $42.10, order AB12")], nothing_strong: true })).toEqual({ ok: true, missing: [] });
  expect(scoreQuestion(order, { results: [hit("strong", "Total $42.10")] })).toEqual({ ok: false, missing: ["AB12"] });
});

it("bug: questions with no answer would change recall's denominator; they are counted apart", () => {
  const result = (id: string, ok: boolean, absent = false): Result => ({ id, category: absent ? "false-premise" : "money", set: absent ? "abstention" : "regression", ...(absent ? { absent: true as const } : {}), ok, stage: ok ? "ok" : absent ? "strong" : "candidates", missing: [], gold: [], top: [], ms: 100 });
  const summary = summarize([result("a", true), result("b", false), result("n1", true, true), result("n2", true, true), result("n3", false, true)]);
  expect(summary).toMatchObject({ n: 2, ok: 1, abstain: { n: 3, ok: 2 }, bySet: { regression: "1/2" }, stages: { candidates: 1 } });
  expect(summary.bySet).not.toHaveProperty("abstention");
  expect(summarize([result("a", true)])).not.toHaveProperty("abstain");
});

it("bug: the runner dropped a question's own filters, so \"what did Sam say in 2025\" was searched across every year", () => {
  const year = { id: "q-2", category: "search-robustness", query: "What did Sam say about coffee in 2025?", absent: true, filters: { from: "2025-01-01", to: "2025-12-31" } };
  expect(searchInput(year)).toEqual({ query: year.query, from: "2025-01-01", to: "2025-12-31", limit: 10, trace: true });
  const person = { id: "q-3", category: "conversations", query: "the diagram", facts: ["proposal"], filters: { person: "person:sam", source: ["imessage"] } };
  expect(searchInput(person)).toMatchObject({ person: "person:sam", source: ["imessage"], query: "the diagram" });
  expect(searchInput({ id: "q-4", category: "money", query: "rent", facts: ["$900"] })).toEqual({ query: "rent", limit: 10, trace: true });
});

// the test zone is America/Chicago (vitest.config.ts); Oct 25, 2026 is a Sunday, Nov 1 the Sunday DST ends
const at = (local: string) => Date.parse(`${local}-05:00`);

it("runs once on Sunday after 04:00, not again that day and not on weekdays within the week", () => {
  const lastSunday = at("2026-10-18T04:05:00");
  expect(evalDue(lastSunday, at("2026-10-25T03:50:00"))).toBe(false);
  expect(evalDue(lastSunday, at("2026-10-25T04:00:00"))).toBe(true);
  expect(evalDue(at("2026-10-25T04:00:30"), at("2026-10-25T09:00:00"))).toBe(false);
  expect(evalDue(at("2026-10-25T04:00:30"), at("2026-10-29T10:00:00"))).toBe(false);
});

it("catches up the first morning after a missed Sunday, and runs a first time on any morning", () => {
  expect(evalDue(at("2026-10-18T04:05:00"), at("2026-10-27T05:00:00"))).toBe(true);
  expect(evalDue(at("2026-10-18T04:05:00"), at("2026-10-27T02:00:00"))).toBe(false);
  expect(evalDue(undefined, at("2026-10-21T08:00:00"))).toBe(true);
});

it("keeps the Sunday slot across the end of daylight saving time", () => {
  expect(evalDue(at("2026-10-25T04:01:00"), Date.parse("2026-11-01T04:30:00-06:00"))).toBe(true);
  expect(evalDue(Date.parse("2026-11-01T04:31:00-06:00"), Date.parse("2026-11-01T23:30:00-06:00"))).toBe(false);
});
