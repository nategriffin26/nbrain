import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

// the library reads $BRAIN_CONTEXT when it loads, so point it at a scratch repo first
const context = mkdtempSync(`${tmpdir()}/nbrain-skills-`);
process.env.BRAIN_CONTEXT = context;
const { digestOf, getSkill, problems, safeRelative, saveSkill, SkillError } = await import("./library.js");

const skill = { name: "explainer", kind: "skill" as const, description: "Build an interactive teaching page. Use when asked to explain a system.", body: "# Explainer\n\nTeach one mechanic at a time." };

it("holds names and descriptions to the Agent Skills rules", () => {
  expect(problems({ name: "explainer", description: "Teach." }, "explainer")).toEqual([]);
  for (const name of ["Explainer", "-explainer", "explainer-", "explain--er", "explain_er", "", "a".repeat(65)]) expect(problems({ name, description: "x" }, name)).toHaveLength(1);
  expect(problems({ name: "explainer", description: "x" }, "teacher")[0]).toContain("must equal its directory name");
  expect(problems({ name: "explainer", description: "" }, "explainer")).toHaveLength(1);
  expect(problems({ name: "explainer", description: "x".repeat(1025) }, "explainer")).toHaveLength(1);
  expect(problems({ name: "explainer", description: "x", metadata: { default: true } }, "explainer")).toHaveLength(1);
});

it("refuses paths that leave the skill", () => {
  for (const path of ["../x.md", "examples/../../x", "/etc/passwd", "./a", "a//b", ".git/config", "a\\b", ""]) expect(() => safeRelative(path)).toThrow(SkillError);
  expect(safeRelative("examples/page.md")).toBe("examples/page.md");
});

it("saves a skill whose manifest digests are the files' sha256, committed as the signer", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const saved = await saveSkill({ ...skill, files: [{ path: "examples/page.md", content: "# A page\n" }, { path: "assets/shot.png", base64: png.toString("base64") }] }, "omp", false);
  expect(saved.files.map(file => file.path)).toEqual(["SKILL.md", "assets/shot.png", "examples/page.md"]);
  for (const file of saved.files) expect(file.digest).toBe(`sha256:${createHash("sha256").update(readFileSync(`${context}/skills/explainer/${file.path}`)).digest("hex")}`);
  expect(execFileSync("git", ["-C", context, "log", "--format=%an %s"], { encoding: "utf8" }).trim()).toBe("omp skill explainer: created by omp");
  await expect(saveSkill({ ...skill, files: [{ path: "../escape.md", content: "x" }] }, "omp", false)).rejects.toThrow(SkillError);
});

it("updates only from the SKILL.md the writer read", async () => {
  await expect(saveSkill(skill, "omp", false)).rejects.toThrow(/exists\. Read it first/);
  await expect(saveSkill({ ...skill, base: digestOf("stale") }, "omp", false)).rejects.toThrow(/changed since you read it/);
  const { files } = await getSkill("explainer");
  const base = files.find(file => file.path === "SKILL.md")!.digest;
  const saved = await saveSkill({ ...skill, body: `${skill.body}\n\nAdd a check after each mechanic.`, base, remove: ["assets/shot.png"] }, "grok", false);
  expect(saved.created).toBe(false);
  expect(saved.files.map(file => file.path)).toEqual(["SKILL.md", "examples/page.md"]);
  await expect(saveSkill({ ...skill, base }, "omp", false)).rejects.toThrow(/changed since you read it/);
  expect((await getSkill("skill://skills/explainer/SKILL.md")).entry.author).toBe("grok");
});
