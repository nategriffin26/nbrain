import { expect, it } from "vitest";
import { citedNotes, type Note, parseChecked, parseKept, parseProposals } from "./notes.js";

// vitest.config.ts sets OWNER_NAME=Alex
const shown = { sources: new Set(["chat:ctx-16261", "chat:turn:abc"]), notes: new Set([12, 40]) };
const fallback = new Date("2026-10-15T14:00:00Z");

it("reads the model's notes, keeping only the sources and notes it was shown", () => {
  const reply = `Here you go:\n\`\`\`json\n${JSON.stringify({ notes: [
    { kind: "rule", subject: "coding agents", text: " Workers use Sol, not Astra: price to performance. ", at: "2026-10-15", until: null, sources: ["chat:ctx-16261", "chat:made-up"], replaces: ["#12", 99] },
    { kind: "situation", subject: "Sam", text: "Sam's scan is October 22, 2026 at 3 PM.", at: null, until: "2026-10-22", sources: ["[chat:turn:abc]"], replaces: [] },
  ] })}\n\`\`\``;
  expect(parseProposals(reply, shown, fallback)).toEqual([
    { kind: "rule", subject: "coding agents", text: "Workers use Sol, not Astra: price to performance.", at: new Date("2026-10-15T12:00:00Z"), until: null, sources: ["chat:ctx-16261"], replaces: [12] },
    { kind: "situation", subject: "Sam", text: "Sam's scan is October 22, 2026 at 3 PM.", at: fallback, until: new Date("2026-10-22T12:00:00Z"), sources: ["chat:turn:abc"], replaces: [] },
  ]);
});

it("drops notes of an unknown kind or with no text, and names the owner when no subject is given", () => {
  const reply = JSON.stringify({ notes: [{ kind: "gossip", text: "x" }, { kind: "fact", text: "  " }, { kind: "preference", text: "Alex wants short replies." }] });
  expect(parseProposals(reply, shown, fallback)).toEqual([{ kind: "preference", subject: "Alex", text: "Alex wants short replies.", at: fallback, until: null, sources: [], replaces: [] }]);
});

it("answers nothing for an empty notes list and throws on a reply without one", () => {
  expect(parseProposals('{"notes":[]}', shown, fallback)).toEqual([]);
  expect(() => parseProposals('{"items":[]}', shown, fallback)).toThrow();
});

it("reads the first object when the model writes more after it (a second object, a remark with braces)", () => {
  const first = JSON.stringify({ notes: [{ kind: "rule", text: "Alex wants {braces} kept in quotes." }] });
  for (const tail of ['\n\n{"notes":[]}', "\nNote: the {other} notes are unchanged."]) {
    expect(parseProposals(first + tail, shown, fallback).map(note => note.text)).toEqual(["Alex wants {braces} kept in quotes."]);
  }
});

it("keeps each retired note's statements that no shown note says or replaces in its own words, and the whole note when the answer leaves it out", () => {
  const note = (id: number, text: string): Note => ({ id, kind: "rule", subject: "coding agents", text, at: fallback, until: null, sources: ["chat:ctx-16261"], by: "consolidation" });
  const retired = new Map([[318, note(318, "a")], [404, note(404, "b")], [321, note(321, "Alex judges memory pressure, not total memory.")]]);
  const holders = { proposals: ["Workers use Sol for the foreseeable future.", "Opus returns as the default worker model when Alex says so."], staying: new Map([[40, "Haiku is allowed only for tests and checks."]]) };
  const reply = JSON.stringify({ retired: [
    { id: "#318", statements: [
      { text: "Workers use Sol.", said_by: "new 1", quote: "workers use  Sol" },
      { text: " The assistant does not put spend caps in worker briefs. ", said_by: null, replaced_by: null },
      { text: "Haiku is allowed for tests, not Muse Spark.", names: ["Haiku", "Muse Spark"], said_by: "#40", quote: "Haiku is allowed only for tests" },
      { text: "Workers use Sol because Astra's price to performance doesn't make sense.", said_by: "new 1", quote: "Workers use Sol because of price to performance" },
    ] },
    { id: 404, statements: [
      { text: "Proactivity step 6 stays stopped until Alex reviews the three test changes.", said_by: "new 3", quote: "step 6" },
      { text: "Memory steps 5 and 6 have landed.", said_by: "#318", quote: "a" },
      { text: "Opus returns when Alex says so.", replaced_by: "New 2 (replaces it)", quote: "Opus returns as the default worker model when Alex says so." },
      { text: "Atmos is not on autopay.", names: ["Atmos"], replaced_by: "#40", quote: "Haiku is allowed" },
    ] },
    { id: 12, statements: [{ text: "Not asked about.", said_by: null }] },
  ] });
  expect(parseKept(reply, retired, holders)).toEqual([
    { from: retired.get(318), text: "The assistant does not put spend caps in worker briefs. Workers use Sol because Astra's price to performance doesn't make sense." },
    { from: retired.get(404), text: "Proactivity step 6 stays stopped until Alex reviews the three test changes. Memory steps 5 and 6 have landed. Atmos is not on autopay." },
    { from: retired.get(321), text: "Alex judges memory pressure, not total memory." },
  ]);
  expect(parseKept('{"retired":[{"id":321,"statements":[{"text":"x","replaced_by":"new 1","quote":"Sol"}]}]}', new Map([[321, retired.get(321)!]]), holders)).toEqual([]);
  expect(() => parseKept('{"kept":[]}', retired, holders)).toThrow();
});

it("retires each changed note into the shown note at the end of its chain, dropping unknown notes, self-changes and loops", () => {
  const reply = JSON.stringify({ checked: [
    { id: 334, about: "new-line route", changed_by: "#392" },
    { id: "#392", about: "device swap", changed_by: null },
    { id: 12, changed_by: 99 },
    { id: 40, changed_by: 40 },
    { id: 309, changed_by: 334 },
    { id: 50, changed_by: 51 },
    { id: 51, changed_by: 50 },
  ] });
  expect(parseChecked(reply, new Set([334, 392, 12, 40, 309, 50, 51]))).toEqual(new Map([[334, 392], [309, 392], [50, 51]]));
  expect(() => parseChecked('{"notes":[]}', new Set([334]))).toThrow();
});

it("finds the notes material retires by id, not other numbers after a #", () => {
  expect(citedNotes("Alex retired the Oct 17 preference (note #1241); see also notes 404, memory:774 and Note#12.")).toEqual(new Set([1241, 404, 774, 12]));
  expect(citedNotes("PR #1241 landed; issue #404 is open; the 2026 roster")).toEqual(new Set());
});
