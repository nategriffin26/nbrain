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

const design = (textColor = "{colors.surface}", primary = '  primary: "{colors.gray-900}"\n') => `---
version: alpha
name: Ink
colors:
  gray-0: "#FFFFFF"
  gray-900: "#18181B"
  surface: "{colors.gray-0}"
${primary}typography:
  body-md: { fontFamily: Inter, fontSize: 15px, fontWeight: 400, lineHeight: 1.4 }
rounded:
  full: 9999px
spacing:
  unit: 4px
components:
  button-primary:
    backgroundColor: "{colors.gray-900}"
    textColor: "${textColor}"
    rounded: "{rounded.full}"
---

## Overview

Ink on paper.

## Colors

- **surface** (#FFFFFF): the page. Why: paper.
`;
const ink = { name: "ink", kind: "style" as const, description: "Ink on paper. Use for reading pages.", body: "# Ink\n\nRead DESIGN.md first." };
const shot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]).toString("base64");

it("serves a design system's DESIGN.md with each component's and block's own doc summary and screenshots", async () => {
  await saveSkill({ ...ink, files: [
    { path: "DESIGN.md", content: design() },
    { path: "components/button.md", content: "# Button\n\nThe one action that moves the screen forward. Use a link for anything else.\n" },
    { path: "components/button/default.png", base64: shot }, { path: "components/button/pressed.png", base64: shot },
    { path: "components/button-group.md", content: "# Button group\n\nTwo or three related actions.\n" },
    { path: "components/button-group/default.png", base64: shot },
    { path: "blocks/composer.md", content: "# Composer\n\nWhere a message is written.\n" }, { path: "blocks/composer.png", base64: shot },
  ] }, "omp", false);
  const { entry, design: served } = await getSkill("styles/ink");
  expect(entry.design).toBe(true);
  expect(served!.text).toBe(design());
  expect(served!.components).toEqual([
    { name: "button", doc: "components/button.md", summary: "The one action that moves the screen forward.", images: ["components/button/default.png", "components/button/pressed.png"] },
    { name: "button-group", doc: "components/button-group.md", summary: "Two or three related actions.", images: ["components/button-group/default.png"] },
  ]);
  expect(served!.blocks).toEqual([{ name: "composer", doc: "blocks/composer.md", summary: "Where a message is written.", images: ["blocks/composer.png"] }]);
  expect((await getSkill("explainer")).design).toBeUndefined();
});

it("refuses a DESIGN.md the linter fails, leaving the saved style as it was", async () => {
  await expect(saveSkill({ ...ink, name: "smudge", files: [{ path: "DESIGN.md", content: design("{colors.nope}") }] }, "omp", false)).rejects.toThrow(/\{colors\.nope\} does not resolve/);
  await expect(getSkill("styles/smudge")).rejects.toThrow(SkillError);
  const commits = execFileSync("git", ["-C", context, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  const base = (await getSkill("styles/ink")).files.find(file => file.path === "SKILL.md")!.digest;
  await expect(saveSkill({ ...ink, base, files: [{ path: "DESIGN.md", content: design("{colors.nope}") }] }, "omp", false)).rejects.toThrow(SkillError);
  expect(readFileSync(`${context}/styles/ink/DESIGN.md`, "utf8")).toBe(design());
  expect(execFileSync("git", ["-C", context, "rev-list", "--count", "HEAD"], { encoding: "utf8" })).toBe(commits);
});

it("returns the linter's warnings, but not for tokens no component references", async () => {
  const saved = await saveSkill({ ...ink, name: "ash", files: [{ path: "DESIGN.md", content: design(undefined, '  text-muted: "#71717A"\n') }] }, "omp", false);
  expect(saved.warnings.some(warning => warning.includes("No 'primary' color"))).toBe(true);
  expect(saved.warnings.filter(warning => warning.includes("never referenced"))).toEqual([]);
});

it("refuses a stale base after a save that changed only a supporting file", async () => {
  const read = (await getSkill("styles/ink")).files.find(file => file.path === "SKILL.md")!.digest;
  await saveSkill({ ...ink, base: read, files: [{ path: "components/button.md", content: "# Button\n\nFirst writer's fix.\n" }] }, "omp", false);
  await expect(saveSkill({ ...ink, base: read, files: [{ path: "components/button.md", content: "# Button\n\nSecond writer, from the old read.\n" }] }, "omp", false)).rejects.toThrow(/changed since you read it/);
  expect(readFileSync(`${context}/styles/ink/components/button.md`, "utf8")).toContain("First writer's fix.");
});
