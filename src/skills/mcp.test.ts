import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { Call } from "../mcp/types.js";

// the library reads $BRAIN_CONTEXT when it loads, so point it at a scratch repo before importing it
process.env.BRAIN_CONTEXT = mkdtempSync(`${tmpdir()}/nbrain-skills-mcp-`);
const { saveSkill } = await import("./library.js");
const { SKILL_TOOLS } = await import("./mcp.js");

const call = { agent: { name: "omp", scopes: ["work"], signer: "omp" }, local: false } as unknown as Call;

it("answers a style with its whole DESIGN.md past one 32 KB page, and the SKILL.md digest to update it", async () => {
  const filler = Array.from({ length: 600 }, (_, i) => `- **token-${i}** (#000000): a reason long enough to fill the page, line ${i}.`).join("\n");
  const design = `---\nversion: alpha\nname: Long\ncolors:\n  primary: "#000000"\n---\n\n## Overview\n\nLong.\n\n## Colors\n\n${filler}\n\n## Do's and Don'ts\n\n- Do keep this last rule. Why: it is the one an agent must not miss.\n`;
  expect(design.length).toBeGreaterThan(32 * 1024);
  const saved = await saveSkill({ name: "long", kind: "style", description: "A long style.", body: "# Long", files: [{ path: "DESIGN.md", content: design }] }, "omp", false);
  const answer = await SKILL_TOOLS.skill_get!.run(call, { name: "styles/long" }) as { design: string; digest: string; files: string[]; design_continues?: string };
  expect(answer.design).toBe(design);
  expect(answer.design_continues).toBeUndefined();
  expect(answer.digest).toBe(saved.files.find(file => file.path === "SKILL.md")!.digest);
  expect(answer.files).toEqual(["DESIGN.md", "SKILL.md"]);
});
