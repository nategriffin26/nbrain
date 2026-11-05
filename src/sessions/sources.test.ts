import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { discoverSessionSources, parseSession, toolScope } from "./sources.js";

const raw = (...rows: unknown[]) => Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n");
const at = "2026-10-01T10:00:00.000Z";
const ompHeader = { type: "session", id: "session-one", cwd: "/work/example", timestamp: at };
const ompMessage = (id: string, message: object) => ({ type: "message", id, timestamp: at, message });

describe("parseSession", () => {
  it("preserves complete omp text and calls, omits thinking, and gives every part a distinct stable receipt", () => {
    const long = "x".repeat(15000);
    const source = raw(ompHeader,
      ompMessage("user", { role: "user", attribution: "user", content: long }),
      ompMessage("assistant", { role: "assistant", content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: long },
        { type: "toolCall", id: "call-one", name: "read", arguments: { path: long } },
      ] }),
      ompMessage("result", { role: "toolResult", toolCallId: "call-one", toolName: "read", content: [{ type: "text", text: long }] }),
      ompMessage("notice", { role: "user", attribution: "agent", content: "Injected notice" }),
    );
    const parsed = parseSession(source, "omp", "/sessions/project/2026-10-01_session-one.jsonl")!;
    expect(parsed.parts.map(p => [p.entry, p.kind, p.ordinal])).toEqual([
      ["user", "prompt", 0], ["assistant:1", "answer", 1], ["assistant:2", "tool_call", 2], ["result", "tool_result", 3], ["notice", "brief", 4],
    ]);
    expect(parsed.parts[0]!.text).toHaveLength(15000);
    expect(parsed.parts[1]!.text).toBe(long);
    expect(parsed.parts[2]!.text).toBe(`read ${JSON.stringify({ path: long })}`);
    expect(parsed.parts[3]!.text).toBe(long);
    expect(JSON.stringify(parsed)).not.toContain("hidden reasoning");
    const appended = parseSession(Buffer.concat([source, raw(ompMessage("next", { role: "user", attribution: "user", content: "Next" }))]), "omp", parsed.originalPath)!;
    expect(appended.parts.slice(0, parsed.parts.length)).toEqual(parsed.parts);
  });

  it("retains parsed messages before a malformed trailing line", () => {
    const source = Buffer.concat([raw(ompHeader, ompMessage("u", { role: "user", attribution: "user", content: "Keep this" })), Buffer.from('{"type":"message","id":')]);
    expect(parseSession(source, "omp", "/sessions/project/2026-10-01_session-one.jsonl")!.parts[0]!.text).toBe("Keep this");
  });

  it("does not attribute deeply nested workers or scratch prompts to the owner", () => {
    const source = raw(ompHeader, ompMessage("u", { role: "user", attribution: "user", content: "Worker assignment" }));
    const nested = parseSession(source, "omp", "/sessions/project/2026-10-01_root/Worker/Nested/Reader.jsonl")!;
    expect(nested.parentId).toBe("root");
    expect(nested.parts[0]!.kind).toBe("brief");
    const scratch = parseSession(source, "omp", "/sessions/--private-tmp-example/2026-10-01_session-one.jsonl")!;
    expect(scratch.scratch).toBe(true);
    expect(scratch.parts[0]!.kind).toBe("brief");
    const explicit = parseSession(raw({ ...ompHeader, parentSession: "/sessions/project/2026-10-01_parent.jsonl" }), "omp", "/sessions/project/2026-10-01_root/Worker.jsonl")!;
    expect(explicit.parentId).toBe("parent");
  });

  it("keeps top-level omp forks owner-attributed and rejects self-parent relationships", () => {
    const source = raw({ ...ompHeader, parentSession: "/sessions/project/2026-10-01_parent.jsonl" },
      ompMessage("u", { role: "user", attribution: "user", content: "Owner fork request" }));
    const fork = parseSession(source, "omp", "/sessions/project/2026-10-01_child.jsonl")!;
    expect(fork.parentId).toBeNull();
    expect(fork.parts[0]!.kind).toBe("prompt");
    const self = parseSession(raw({ ...ompHeader, parentSession: "/sessions/project/2026-10-01_session-one.jsonl" },
      ompMessage("u", { role: "user", attribution: "user", content: "Worker request" })), "omp", "/sessions/project/2026-10-01_session-one/Worker.jsonl")!;
    expect(self.parentId).toBeNull();
    expect(self.parts[0]!.kind).toBe("brief");
  });

  it("omits binary and thinking-only results while retaining structured text and tool arguments", () => {
    const source = raw(ompHeader,
      ompMessage("binary", { role: "toolResult", content: [{ type: "image", data: "BINARY_PAYLOAD" }, { type: "audio", data: "AUDIO_PAYLOAD" }] }),
      ompMessage("thinking", { role: "toolResult", content: [{ type: "thinking", thinking: "HIDDEN_REASONING" }] }),
      ompMessage("structured", { role: "toolResult", content: [{ type: "json", value: { count: 2 } }] }),
      ompMessage("call", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "inspect", arguments: { prompt: "Inspect the diagram", image: { type: "image", data: "BINARY_PAYLOAD" } } }] }),
    );
    const parsed = parseSession(source, "omp", "/sessions/project/2026-10-01_session-one.jsonl")!;
    expect(parsed.parts.map(p => p.entry)).toEqual(["structured", "call:0"]);
    expect(parsed.parts[0]!.text).toBe('[{"type":"json","value":{"count":2}}]');
    expect(parsed.parts[1]!.text).toBe('inspect {"prompt":"Inspect the diagram"}');
  });

  it("tracks life provenance across nested eval envelopes and reused eval state", () => {
    const source = raw(ompHeader,
      ompMessage("a", { role: "assistant", content: [
        { type: "toolCall", id: "life", name: "functions.eval", arguments: { code: 'await tool.mcp__executor_execute({code: "return await tools.gmail.messages.get({id: 1})"})' } },
        { type: "toolCall", id: "work", name: "read", arguments: { path: "package.json" } },
      ] }),
      ompMessage("work-result", { role: "toolResult", toolCallId: "work", content: "Package" }),
      ompMessage("life-result", { role: "toolResult", toolCallId: "life", content: "Mail body" }),
      ompMessage("b", { role: "assistant", content: [{ type: "toolCall", id: "stored", name: "functions.eval", arguments: { code: "print(previousResult)" } }] }),
      ompMessage("stored-result", { role: "toolResult", toolCallId: "stored", content: "Stored mail body" }),
    );
    const parsed = parseSession(source, "omp", "/sessions/project/2026-10-01_session-one.jsonl")!;
    expect(parsed.parts.filter(p => p.kind === "tool_result").map(p => [p.entry, p.scope])).toEqual([
      ["work-result", "work"], ["life-result", "life"], ["stored-result", "life"],
    ]);
  });

  it("keeps resumed Executor results life-scoped after the initial execute call", () => {
    const source = raw(ompHeader,
      ompMessage("execute", { role: "assistant", content: [{ type: "toolCall", id: "first", name: "mcp__executor_execute", arguments: { code: "return tools.gmail.messages.get({})" } }] }),
      ompMessage("pause", { role: "toolResult", toolCallId: "first", content: "Approval required" }),
      ompMessage("resume", { role: "assistant", content: [{ type: "toolCall", id: "second", name: "mcp__executor_resume", arguments: { requestId: "request", response: { action: "accept" } } }] }),
      ompMessage("result", { role: "toolResult", toolCallId: "second", content: "Mail body" }),
    );
    const parsed = parseSession(source, "omp", "/sessions/project/2026-10-01_session-one.jsonl")!;
    expect(parsed.parts.find(p => p.entry === "result")!.scope).toBe("life");
  });

  it("parses Claude multipart text, tool results and sidechains without losing original ids", () => {
    const source = raw(
      { type: "summary", summary: "Example title" },
      { type: "user", uuid: "u", timestamp: at, cwd: "/work/example", message: { content: "Owner request" } },
      { type: "assistant", uuid: "a", timestamp: at, message: { content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Answer" },
        { type: "tool_use", id: "call", name: "mcp__executor_call", input: { calls: [{ path: "tools.apple-messages.search", input: {} }] } },
      ] } },
      { type: "user", uuid: "r", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "Message body" }] }] } },
      { type: "user", uuid: "meta", timestamp: at, isMeta: true, message: { content: "System notice" } },
    );
    const parsed = parseSession(source, "claude", "/projects/example/main.jsonl")!;
    expect(parsed.id).toBe("cc:main");
    expect(parsed.parts.map(p => [p.entry, p.kind, p.scope])).toEqual([
      ["u", "prompt", "work"], ["a:1", "answer", "work"], ["a:2", "tool_call", "life"], ["r:0", "tool_result", "life"], ["meta", "brief", "work"],
    ]);
    const worker = parseSession(source, "claude", "/projects/example/main/subagents/agent-one.jsonl")!;
    expect(worker.parentId).toBe("cc:main");
    expect(worker.parts[0]!.kind).toBe("brief");
  });

  it("parses Codex calls with stable fallback ids and omits reasoning channels", () => {
    const source = raw(
      { type: "session_meta", payload: { id: "codex-one", cwd: "/work/example", timestamp: at } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Request" }] } },
      { type: "response_item", timestamp: at, payload: { type: "reasoning", summary: "hidden reasoning" } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "hidden analysis" }] } },
      { type: "response_item", timestamp: at, payload: { type: "function_call", call_id: "call", name: "mcp__dross_memory_fetch", arguments: '{"id":"chat:example"}' } },
      { type: "response_item", timestamp: at, payload: { type: "function_call_output", call_id: "call", output: "Conversation" } },
      { type: "response_item", timestamp: at, payload: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: "Result" }] } },
    );
    const parsed = parseSession(source, "codex", "/sessions/rollout.jsonl")!;
    expect(parsed.id).toBe("cx:codex-one");
    expect(parsed.parts.map(p => [p.entry, p.kind, p.scope])).toEqual([
      ["line:1", "prompt", "work"], ["line:4", "tool_call", "life"], ["line:5", "tool_result", "life"], ["answer", "answer", "work"],
    ]);
    expect(JSON.stringify(parsed)).not.toContain("hidden");
  });

  it("rebuilds opencode from exported rows, including synthetic briefs and full tool state", () => {
    const parsed = parseSession(raw(
      { type: "session", row: { id: "s", parent_id: "parent", directory: "/work/example", title: "Example", time_created: 1790848800000, time_updated: 1790848801000 } },
      { type: "message", row: { id: "m", time_created: 1790848800000, data: '{"role":"user"}' } },
      { type: "part", row: { id: "p", message_id: "m", data: '{"type":"text","text":"Brief","synthetic":true}' } },
      { type: "part", row: { id: "t", message_id: "m", data: JSON.stringify({ type: "tool", callID: "call", tool: "execute", state: { input: { code: "tools.apple_calendar.events.list({})" }, output: "Event details" } }) } },
      { type: "part", row: { id: "r", message_id: "m", data: '{"type":"reasoning","text":"hidden reasoning"}' } },
    ), "opencode", "/source/opencode.db#s")!;
    expect(parsed.id).toBe("oc:s");
    expect(parsed.parentId).toBe("oc:parent");
    expect(parsed.parts.map(p => [p.entry, p.kind, p.scope])).toEqual([
      ["m:p", "brief", "work"], ["m:t:call", "tool_call", "life"], ["m:t:result", "tool_result", "life"],
    ]);
    expect(parsed.parts[2]!.text).toBe("Event details");
  });

  it("rebuilds Dross rows with life scope and excludes routine and bot handoffs from prompt attribution", () => {
    const parsed = parseSession(raw(
      { type: "thread", row: { id: "thread-one", botId: "assistant", createdAt: "2026-10-01T10:00:00" } },
      { type: "message", row: { id: "owner", role: "user", createdAt: at, blocks: [{ kind: "text", text: "Request" }, { kind: "text", text: "More detail" }] } },
      { type: "message", row: { id: "routine", role: "user", createdAt: at, blocks: [{ kind: "text", text: "Run routine daily" }] } },
      { type: "message", row: { id: "handoff", role: "user", createdAt: at, blocks: [{ kind: "bot_message_received", text: "Agent brief" }] } },
      { type: "message", row: { id: "bot", role: "bot", createdAt: at, blocks: [
        { kind: "text", text: "Answer" }, { kind: "thinking", text: "hidden reasoning" },
        { kind: "steps", calls: [{ tool: "read", summary: "Read record", note: "Result" }] },
      ] } },
    ), "dross", "rakazo:threads/thread-one")!;
    expect(parsed.id).toBe("dr:thread-one");
    expect(parsed.parts.filter(p => p.kind === "prompt")).toHaveLength(1);
    expect(parsed.parts[0]!.text).toBe("Request\nMore detail");
    expect(parsed.parts.every(p => p.scope === "life")).toBe(true);
    expect(parsed.parts.filter(p => p.kind === "tool_result").map(p => p.text)).toEqual(["Result"]);
    expect(JSON.stringify(parsed)).not.toContain("hidden reasoning");
    expect(parsed.started).toBe(at);
  });
});

describe("toolScope", () => {
  it.each([
    ["mcp__executor_call", { calls: [{ path: "tools.gmail.messages.list", input: {} }] }],
    ["write", { path: "xd://mcp__executor_execute", content: '{"code":"await tools.apple-messages.search({})"}' }],
    ["eval", { code: "await tool.mcp__dross_memory_person({name: 'Example'})" }],
    ["mcp__nbrain__fetch", { id: "chat:example" }],
    ["execute", { code: "return tools.calendar.events.list({})" }],
  ])("retains life provenance in %s", (name, input) => {
    expect(toolScope(name, input)).toBe("life");
  });
  it("does not classify ordinary repository reads as life", () => {
    expect(toolScope("read", { path: "src/main.ts" })).toBe("work");
    expect(toolScope("read", { path: "src/memory/search.ts" })).toBe("work");
    expect(toolScope("eval", { code: 'await tool.read({ path: "src/memory/search.ts" })' })).toBe("work");
    expect(toolScope("memory.search", { query: "Example" })).toBe("life");
  });
});

describe("discoverSessionSources", () => {
  it("counts every nested JSONL source and reports scratch exclusions separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-sources-"));
    for (const path of ["project/2026-10-01_root.jsonl", "project/2026-10-01_root/Reader/Nested/Worker.jsonl", "--private-tmp-test/2026-10-01_scratch.jsonl", "project/notes.txt"]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), raw({ ...ompHeader, id: path }));
    }
    const found = [];
    for await (const source of discoverSessionSources({ ompRoot: root })) found.push(source);
    expect(found).toHaveLength(3);
    expect(found.filter(s => s.scratch)).toHaveLength(1);
    expect(found.some(s => s.originalPath.endsWith("Reader/Nested/Worker.jsonl"))).toBe(true);
  });

  it.each(["omp", "codex"] as const)("excludes %s event logs and empty files, then discovers a newly written identity header", async harness => {
    const root = await mkdtemp(join(tmpdir(), "session-nonsource-"));
    const empty = join(root, "active.jsonl");
    await writeFile(empty, " \n");
    await writeFile(join(root, "agent-events.jsonl"), raw({ agent: "worker", n: 1, project: "example", text: "Event text", ts: at }));
    await writeFile(join(root, "http.jsonl"), raw({ at, body: "", method: "GET", status: 200, url: "https://example.com" }));
    await writeFile(join(root, "operations.jsonl"), raw({ app: "example", at, name: "read", op: "call", result: {}, target: "example", text: "Result", url: "https://example.com" }));
    const errors: unknown[] = [];
    const options = { ...(harness === "omp" ? { ompRoot: root } : { codexRoot: root }), onError: (error: unknown) => errors.push(error) };
    const initial = [];
    for await (const source of discoverSessionSources(options)) initial.push(source);
    expect(initial).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(empty, raw(harness === "omp" ? ompHeader : { type: "session_meta", payload: { id: "codex-one", timestamp: at } }));
    const discovered = [];
    for await (const source of discoverSessionSources(options)) discovered.push(source.sessionId);
    expect(discovered).toEqual([harness === "omp" ? "session-one" : "cx:codex-one"]);
    expect(errors).toEqual([]);
  });

  it("continues reporting malformed JSON and recognizable session records without usable identity headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-poisoned-"));
    const malformed = join(root, "a-malformed.jsonl");
    const missingId = join(root, "b-missing-id.jsonl");
    const missingHeader = join(root, "c-missing-header.jsonl");
    await writeFile(malformed, "{malformed");
    await writeFile(missingId, raw({ type: "session", timestamp: at }));
    await writeFile(missingHeader, raw(ompMessage("u", { role: "user", content: "A session message" })));
    const errors: unknown[] = [];
    const found = [];
    for await (const source of discoverSessionSources({ ompRoot: root, onError: error => errors.push(error) })) found.push(source);
    expect(found).toEqual([]);
    expect(errors).toEqual([malformed, missingId, missingHeader].map(originalPath => ({ harness: "omp", originalPath, name: "SourceParseError" })));
  });

  it("keeps equal worker filenames separate when their session headers have different identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-identities-"));
    for (const [directory, id] of [["first", "session-a"], ["second", "session-b"]] as const) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "Worker.jsonl"), raw({ ...ompHeader, id }));
    }
    const ids = [];
    for await (const source of discoverSessionSources({ ompRoot: root })) ids.push(source.sessionId);
    expect(ids).toEqual(["session-a", "session-b"]);
  });

  it("exports SQLite source rows and fingerprints edits even when update timestamps are unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-sqlite-"));
    const path = join(root, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('s', NULL, '/work/example', 'Example', 1790848800000, 1790848800000);
      INSERT INTO message VALUES ('m', 's', 1790848800000, 1790848800000, '{"role":"user"}');
      INSERT INTO part VALUES ('p', 'm', 's', 1790848800000, 1790848800000, '{"type":"text","text":"First"}');`);
    const snapshots = [];
    for await (const source of discoverSessionSources({ opencodePath: path })) snapshots.push(await source.read());
    db.prepare("UPDATE part SET data = ? WHERE id = 'p'").run('{"type":"text","text":"Other"}');
    for await (const source of discoverSessionSources({ opencodePath: path })) snapshots.push(await source.read());
    db.close();
    expect(snapshots[0]!.sourceFingerprint).not.toBe(snapshots[1]!.sourceFingerprint);
    expect(parseSession(snapshots[0]!.raw, "opencode", `${path}#s`)!.parts[0]!.text).toBe("First");
    expect(parseSession(snapshots[1]!.raw, "opencode", `${path}#s`)!.parts[0]!.text).toBe("Other");
    const exported = snapshots[0]!.raw.toString().trim().split("\n").map(line => JSON.parse(line));
    expect(exported.map(r => r.type)).toEqual(["session", "message", "part"]);
    expect(exported[2].row.data).toBe('{"type":"text","text":"First"}');
  });

  it("adds legacy-only opencode sessions without duplicating migrated database sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-legacy-"));
    const database = join(root, "opencode.db");
    const storage = join(root, "storage");
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('migrated', 1790848800000, 1790848800000);`);
    db.close();
    for (const [path, value] of [
      ["session/project/migrated.json", { id: "migrated", time: { created: 1790848800000 } }],
      ["session/project/legacy.json", { id: "legacy", parentID: "migrated", directory: "/work/example", time: { created: 1790848800000 } }],
      ["message/legacy/message.json", { id: "message", sessionID: "legacy", role: "user", time: { created: 1790848800000 } }],
      ["part/message/part.json", { id: "part", messageID: "message", sessionID: "legacy", type: "text", text: "Legacy worker brief" }],
    ] as const) {
      await mkdir(join(storage, path, ".."), { recursive: true });
      await writeFile(join(storage, path), JSON.stringify(value));
    }
    const parsed = [];
    for await (const source of discoverSessionSources({ opencodePath: database, opencodeStorageRoot: storage })) {
      parsed.push(parseSession((await source.read()).raw, source.harness, source.originalPath)!);
    }
    expect(parsed.map(s => s.id)).toEqual(["oc:migrated", "oc:legacy"]);
    expect(parsed[1]!.parentId).toBe("oc:migrated");
    expect(parsed[1]!.parts).toMatchObject([{ entry: "message:part", kind: "brief", text: "Legacy worker brief" }]);
  });
});
