import { expect, it } from "vitest";
import { applyEdits, type Edit, mergeJournal, parseEdits } from "./garden.js";

const file = `# Work style

## Talking
- Lead with the outcome.
- Plain words.

Sources: notes.

## Building
- Fix at the root.
`;
const edit = (fields: Partial<Edit> & Pick<Edit, "op">): Edit => ({ why: "", evidence: ["memory:1"], ...fields });

it("replaces and deletes only an exact existing line, and skips a line that is not there", () => {
  const result = applyEdits(file, [
    edit({ op: "replace", find: "- Plain words.", text: "- Plain words; define new terms." }),
    edit({ op: "delete", find: "- Fix at the root" }),
    edit({ op: "replace", find: "- Lead with outcome.", text: "- x" }),
  ], { budget: 5000 });
  expect(result.text).toBe(file.replace("- Plain words.", "- Plain words; define new terms."));
  expect(result.applied).toHaveLength(1);
  expect(result.skipped.map(each => each.reason)).toEqual(["line not found", "line not found"]);
});

it("adds at the end of its section's list, before trailing prose and the next heading; skips a missing section or a line already there", () => {
  const result = applyEdits(file, [
    edit({ op: "add", section: "## Talking", text: "- Links as Markdown." }),
    edit({ op: "add", section: "Building", text: "- Parallel worktrees." }),
    edit({ op: "add", section: "## Life", text: "- x" }),
    edit({ op: "add", section: "## Talking", text: "- Plain words." }),
  ], { budget: 5000 });
  expect(result.text).toBe(file.replace("- Plain words.\n", "- Plain words.\n- Links as Markdown.\n").replace("- Fix at the root.\n", "- Fix at the root.\n- Parallel worktrees.\n"));
  expect(result.skipped.map(each => each.reason)).toEqual(["no section ## Life", "already there"]);
});

it("drops a whole edit set that takes the file past its budget, but lets an over-budget file shrink", () => {
  const over = applyEdits(file, [edit({ op: "delete", find: "- Plain words." }), edit({ op: "add", section: "Talking", text: `- ${"x".repeat(60)}` })], { budget: Buffer.byteLength(file) + 10 });
  expect(over.text).toBe(file);
  expect(over.applied).toEqual([]);
  expect(over.skipped).toHaveLength(2);
  expect(over.skipped.every(each => each.reason.startsWith("budget"))).toBe(true);
  expect(applyEdits(file, [edit({ op: "delete", find: "- Plain words." })], { budget: 10 }).applied).toHaveLength(1);
});

it("in a proposed-only file takes only lines marked proposed and deletes nothing", () => {
  const result = applyEdits(file, [
    edit({ op: "add", section: "Building", text: "- Ship a side business." }),
    edit({ op: "add", section: "Building", text: "- Ship a side business (proposed)." }),
    edit({ op: "delete", find: "- Plain words." }),
  ], { budget: 5000, proposedOnly: true });
  expect(result.applied.map(each => each.text)).toEqual(["- Ship a side business (proposed)."]);
  expect(result.skipped).toHaveLength(2);
});

it("keeps only edits that cite evidence it was shown", () => {
  const edits = parseEdits('```json\n{"edits":[{"op":"add","text":"- a","why":"w","evidence":["[memory:1]","chat:9"]},{"op":"delete","find":"- b","evidence":["memory:7"]}]}\n```', new Set(["memory:1"]));
  expect(edits).toEqual([{ op: "add", section: undefined, find: undefined, text: "- a", why: "w", evidence: ["memory:1"] }]);
});

it("extends a journal a bot wrote without dropping its lines, within the budget", () => {
  const existing = "# Tue Oct 20, 2026\n## Work\n- Bot line.\n";
  expect(mergeJournal(existing, "# Tue Oct 20, 2026", { work: ["Built the gardener.", "Bot line."], life: ["- Dinner with family."] }))
    .toBe("# Tue Oct 20, 2026\n## Work\n- Bot line.\n- Built the gardener.\n## Life\n- Dinner with family.\n");
  expect(mergeJournal(undefined, "# Wed Oct 21, 2026", { work: ["x".repeat(100), "y"], life: [] }, 60)).toBe("# Wed Oct 21, 2026\n## Work\n- y\n## Life\n");
  expect(mergeJournal(existing, "# Tue Oct 20, 2026", { work: ["Bot line."], life: [] })).toBeUndefined();
});
