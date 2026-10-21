import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionFiles, turnsOfSession } from "./omp.js";

const line = (entry: object) => JSON.stringify(entry);
const user = (id: string, at: string, content: unknown, attribution = "user") => line({ type: "message", id, timestamp: at, message: { role: "user", content, attribution } });
const agent = (id: string, at: string, parts: unknown[]) => line({ type: "message", id, timestamp: at, message: { role: "assistant", content: parts } });
const text = (value: string) => ({ type: "text", text: value });

describe("turnsOfSession", () => {
  const file = [
    line({ type: "title", title: "\ue0a0 Fix the login bug" }),
    line({ type: "session", id: "s1", cwd: "/work/acme-app", timestamp: "2026-10-01T10:00:00Z" }),
    user("u1", "2026-10-01T10:01:00Z", [text("first"), text("line two")]),
    agent("a1", "2026-10-01T10:02:00Z", [{ type: "thinking", thinking: "hm" }, text("working on it"), { type: "toolCall", name: "read" }]),
    agent("a2", "2026-10-01T10:03:00Z", [{ type: "toolCall", name: "edit" }]),
    agent("a3", "2026-10-01T10:04:00Z", [text("fixed it")]),
    user("u2", "2026-10-01T10:05:00Z", "injected by the harness", "agent"),
    user("u3", "2026-10-01T10:06:00Z", "now ship it"),
    line({ type: "title_change", title: "Ship the login fix" }),
    '{"type":"message","id":"cut',
  ].join("\n");

  it("pairs each typed message with the last answer text before the next one", () => {
    const turns = turnsOfSession(file);
    expect(turns.map(turn => [turn.entry, turn.message, turn.answer])).toEqual([["u1", "first\nline two", "fixed it"], ["u3", "now ship it", ""]]);
  });

  it("takes the session's last title without its icon, and the project from cwd", () => {
    const [turn] = turnsOfSession(file);
    expect(turn).toMatchObject({ session: "s1", project: "acme-app", title: "Ship the login fix" });
    expect(turnsOfSession(file.replace(/.*title_change.*\n/, ""))[0]!.title).toBe("Fix the login bug");
  });
});

describe("sessionFiles", () => {
  it("lists top-level sessions only: no subagent sessions, no scratch directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-sessions-"));
    for (const path of ["-work-app/2026-10-01_a.jsonl", "-work-app/2026-10-01_a/Helper.jsonl", "--private-tmp-x/2026-10-01_b.jsonl", "-work-app/notes.txt"]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "");
    }
    expect((await sessionFiles(root)).map(each => basename(each.file))).toEqual(["2026-10-01_a.jsonl"]);
  });
});
