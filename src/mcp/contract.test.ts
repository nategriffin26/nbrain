import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "./contract.js";

// Models pass `source: "gmail"` as often as `source: ["gmail"]`; the array-only schema failed those calls outright.
describe("source filter", () => {
  for (const tool of ["search", "changes"] as const) {
    const base = tool === "search" ? { query: "atmos bill" } : { since: "yesterday" };
    it(`${tool} takes one source as a string`, () => {
      expect(MCP_TOOLS[tool].input.parse({ ...base, source: "gmail" }).source).toEqual(["gmail"]);
    });
    it(`${tool} takes a list of sources`, () => {
      expect(MCP_TOOLS[tool].input.parse({ ...base, source: ["gmail", "imessage"] }).source).toEqual(["gmail", "imessage"]);
    });
    it(`${tool} still rejects a source that is neither`, () => {
      expect(MCP_TOOLS[tool].input.safeParse({ ...base, source: 3 }).success).toBe(false);
    });
  }
});
