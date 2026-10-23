import { expect, it } from "vitest";
import { chunkBody, dateMention, queryWords, quoteOf } from "./text.js";

// Monday Oct 19 2026, evening in the test zone
const now = new Date(2026, 9, 19, 20, 15);
const days = (query: string) => dateMention(query, now)?.ranges.map(([from, to]) => [from.toDateString(), to.toDateString()]);

it("resolves the days a question names against now", () => {
  expect(days("what's on tomorrow")).toEqual([["Tue Oct 20 2026", "Wed Oct 21 2026"]]);
  expect(days("who texted me yesterday")).toEqual([["Sun Oct 18 2026", "Mon Oct 19 2026"]]);
  expect(days("what did I buy last week")).toEqual([["Mon Oct 12 2026", "Mon Oct 19 2026"]]);
  expect(days("bills this month")).toEqual([["Thu Oct 01 2026", "Sun Nov 01 2026"]]);
  expect(days("3 days ago")).toEqual([["Fri Oct 16 2026", "Sat Oct 17 2026"]]);
  expect(days("dinner on Friday")).toEqual([["Fri Oct 16 2026", "Sat Oct 17 2026"], ["Fri Oct 23 2026", "Sat Oct 24 2026"]]);
  expect(days("next Friday")).toEqual([["Fri Oct 23 2026", "Sat Oct 24 2026"]]);
  expect(days("What happened on 2026-10-14?")).toEqual([["Wed Oct 14 2026", "Thu Oct 15 2026"]]);
  expect(dateMention("What did Mom say on Oct 14?", now)?.phrases).toContain("october 14");
  expect(dateMention("Is it may be fine", now)).toBeUndefined();
});

it("takes every month named, a year after the last one covering them all", () => {
  expect(days("weddings in August and September 2026")).toEqual([["Sat Aug 01 2026", "Tue Sep 01 2026"], ["Tue Sep 01 2026", "Thu Oct 01 2026"]]);
  expect(dateMention("weddings in August and September 2026", now)?.phrases).toEqual(["august", "september"]);
});

it("keeps the words that say what is asked, handles intact", () => {
  expect(queryWords("What is Mom's email address?")).toEqual(["mom", "email", "address"]);
  expect(queryWords("invoice IN-82789750 from sam_01@example.com")).toEqual(["invoice", "in-82789750", "sam_01@example.com"]);
});

it("cuts a long body into overlapping chunks that cover every character", () => {
  const body = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something worth keeping.`).join(" ");
  const chunks = chunkBody(body);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(body.length);
  for (const [i, chunk] of chunks.entries()) if (i > 0) expect(chunk.start).toBeLessThan(chunks[i - 1]!.end);
});

it("never cuts an emoji in half: a lone surrogate can fail a model call", () => {
  // the window opens 4 characters before "apps", on the emoji's second half
  expect(quoteOf(`${"x".repeat(116)}📱 a apps`, ["apps"], 20).isWellFormed()).toBe(true);
});

it("quotes where the most query words meet, not where the first one is", () => {
  const body = `Plan for the week. ${"filler words here. ".repeat(80)}The plan document is linked at github.com/x/PLAN.md for the project.`;
  expect(quoteOf(body, ["plan", "document", "linked", "github"], 120)).toContain("github.com/x/PLAN.md");
});
