import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { archiveSessions, pruneSupersededArchives, readArchivedSession } from "./archive.js";
import type { ArchiveOptions } from "./archive.js";
import type { ArchivedSession } from "./types.js";

const header = { type: "session", id: "example-session", timestamp: "2026-10-01T10:00:00Z", cwd: "/work/example" };
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
const prompt = (id: string, content: string) => ({ type: "message", id, timestamp: "2026-10-01T10:00:00Z", message: { role: "user", attribution: "user", content } });

async function fixture(): Promise<{ options: ArchiveOptions; sourcePath: string; bytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "session-archive-"));
  const options = { archiveRoot: join(root, "archive"), ompRoot: join(root, "source") };
  const sourcePath = join(options.ompRoot, "project", "2026-10-01_example-session.jsonl");
  const bytes = Buffer.from(line(header) + line(prompt("first", "Initial request")));
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, bytes);
  return { options, sourcePath, bytes };
}

async function collect(options: ArchiveOptions, known?: ReadonlyMap<string, string>): Promise<ArchivedSession[]> {
  const found: ArchivedSession[] = [];
  for await (const archived of archiveSessions(options, known)) found.push(archived);
  return found;
}

describe("archiveSessions", () => {
  it("retains raw bytes including malformed trailing input, then fetches without the source", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const trailing = Buffer.from('{"type":"message","id":"partial');
    await appendFile(sourcePath, trailing);
    const [archived] = await collect(options);
    expect(archived).toBeDefined();
    expect(zstdDecompressSync(await readFile(archived!.archivePath))).toEqual(Buffer.concat([bytes, trailing]));
    expect(archived!.sourceBytes).toBe(bytes.length + trailing.length);
    expect((await stat(archived!.archivePath)).mode & 0o777).toBe(0o600);
    await rename(sourcePath, sourcePath + ".removed");
    expect(await collect(options)).toEqual([]);
    const recovered = await readArchivedSession(archived!.archivePath, "omp", sourcePath);
    expect(recovered.parts.map(p => p.text)).toEqual(["Initial request"]);
    expect(recovered.id).toBe("example-session");
  });

  it("skips committed unchanged sources and preserves both versions of an active session", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const [first] = await collect(options);
    const known = new Map([[sourcePath, first!.sourceFingerprint]]);
    expect(await collect(options, known)).toEqual([]);
    await appendFile(sourcePath, line(prompt("second", "Follow-up request")));
    const [second] = await collect(options, known);
    expect(second!.archivePath).not.toBe(first!.archivePath);
    expect(second!.sourceFingerprint).not.toBe(first!.sourceFingerprint);
    expect(zstdDecompressSync(await readFile(first!.archivePath))).toEqual(bytes);
    expect((await readArchivedSession(first!.archivePath, "omp", sourcePath)).parts).toHaveLength(1);
    expect((await readArchivedSession(second!.archivePath, "omp", sourcePath)).parts.map(p => p.text)).toEqual(["Initial request", "Follow-up request"]);
  });

  it("reuses the retained version after a crash before catalog commit", async () => {
    const { options } = await fixture();
    const [first] = await collect(options);
    const before = await stat(first!.archivePath);
    const [retry] = await collect(options);
    expect(retry!.archivePath).toBe(first!.archivePath);
    expect(retry!.sourceFingerprint).toBe(first!.sourceFingerprint);
    expect((await stat(first!.archivePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("retains an interrupted archive file and writes a separate recoverable version", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const hash = createHash("sha256").update(bytes).digest("hex");
    const interrupted = join(options.archiveRoot, "omp", "2026-10", `example-session.${hash}.jsonl.zst`);
    await mkdir(dirname(interrupted), { recursive: true });
    await writeFile(interrupted, Buffer.from([0x28, 0xb5]));
    const [archived] = await collect(options);
    expect(archived!.archivePath).not.toBe(interrupted);
    expect(await readFile(interrupted)).toEqual(Buffer.from([0x28, 0xb5]));
    expect((await readArchivedSession(archived!.archivePath, "omp", sourcePath)).parts[0]!.text).toBe("Initial request");
  });

  it("excludes scratch sessions without removing or rewriting the source", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const scratch = join(options.ompRoot!, "--private-tmp-example", "2026-10-01_scratch.jsonl");
    await mkdir(dirname(scratch), { recursive: true });
    await writeFile(scratch, bytes);
    const found = await collect(options);
    expect(found.map(s => s.transcript.originalPath)).toEqual([sourcePath]);
    expect(await readFile(scratch)).toEqual(bytes);
  });

  it("encodes source identifiers so an archive cannot escape its harness month", async () => {
    const { options, sourcePath } = await fixture();
    await writeFile(sourcePath, line({ ...header, id: "../../outside" }) + line(prompt("first", "Request")));
    const [archived] = await collect(options);
    expect(dirname(archived!.archivePath)).toBe(join(options.archiveRoot, "omp", "2026-10"));
    expect((await readArchivedSession(archived!.archivePath, "omp", sourcePath)).id).toBe("../../outside");
  });

  it("does not claim a missing or corrupt archive is a readable session", async () => {
    const { options } = await fixture();
    const missing = join(options.archiveRoot, "missing.jsonl.zst");
    await expect(readArchivedSession(missing, "omp", "/missing/source.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(options.archiveRoot, { recursive: true });
    const corrupt = join(options.archiveRoot, "corrupt.jsonl.zst");
    await writeFile(corrupt, "not compressed");
    await expect(readArchivedSession(corrupt, "omp", "/missing/source.jsonl")).rejects.toBeInstanceOf(Error);
  });

  it("archives divergent duplicate identities once and skips unchanged groups on the second pass", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const prefixPath = join(dirname(sourcePath), "prefix.jsonl");
    const divergentPath = join(dirname(sourcePath), "divergent.jsonl");
    const divergent = Buffer.from(line(header) + line(prompt("different", "Divergent request")));
    const latest = Buffer.concat([bytes, Buffer.from(line(prompt("next", "Newest request")))]);
    await writeFile(prefixPath, bytes);
    await writeFile(divergentPath, divergent);
    await writeFile(sourcePath, latest);
    const olderTime = new Date("2026-10-01T00:00:00Z");
    const newerTime = new Date("2026-10-02T00:00:00Z");
    await utimes(prefixPath, olderTime, olderTime);
    await utimes(divergentPath, olderTime, olderTime);
    await utimes(sourcePath, newerTime, newerTime);
    const projected = await collect(options);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.transcript.originalPath).toBe(sourcePath);
    expect(projected[0]!.transcript.parts.map(p => p.text)).toEqual(["Initial request", "Newest request"]);
    const directory = dirname(projected[0]!.archivePath);
    const retained = [];
    for (const filename of await readdir(directory)) retained.push(zstdDecompressSync(await readFile(join(directory, filename))).toString());
    expect(retained.sort()).toEqual([bytes.toString(), divergent.toString(), latest.toString()].sort());
    const known = new Map([[sourcePath, projected[0]!.sourceFingerprint]]);
    expect(await collect(options, known)).toEqual([]);

    const updatedDivergence = Buffer.from(line(header) + line(prompt("different", "Revised divergent request")));
    await writeFile(divergentPath, updatedDivergence);
    await utimes(divergentPath, olderTime, olderTime);
    const changed = await collect(options, known);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.archivePath).toBe(projected[0]!.archivePath);
    expect(changed[0]!.sourceFingerprint).not.toBe(projected[0]!.sourceFingerprint);
    expect(await readdir(directory)).toHaveLength(4);
    expect(await collect(options, new Map([[sourcePath, changed[0]!.sourceFingerprint]]))).toEqual([]);
  });

  it("chooses longer copies at equal modification times and a stable path for exact ties", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const first = join(dirname(sourcePath), "a-copy.jsonl");
    const second = join(dirname(sourcePath), "b-copy.jsonl");
    const longer = Buffer.concat([bytes, Buffer.from(line(prompt("next", "More text")))]);
    const timestamp = new Date("2026-10-02T00:00:00Z");
    for (const [path, value] of [[sourcePath, bytes], [second, longer], [first, longer]] as const) {
      await writeFile(path, value);
      await utimes(path, timestamp, timestamp);
    }
    const projected = await collect(options);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.transcript.originalPath).toBe(first);
    expect(await readdir(dirname(projected[0]!.archivePath))).toHaveLength(2);
  });

  it("reports a malformed source safely and still archives good sources on either side", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const root = dirname(sourcePath);
    await rename(sourcePath, join(root, "a-good.jsonl"));
    const poison = join(root, "b-poison.jsonl");
    await writeFile(poison, 'PRIVATE_SOURCE_TEXT { malformed');
    await writeFile(join(root, "c-good.jsonl"), line({ ...header, id: "another-session" }) + line(prompt("u", "Other request")));
    const errors: unknown[] = [];
    const archived = await collect({ ...options, onError: error => errors.push(error) });
    expect(archived.map(s => s.transcript.id)).toEqual(["example-session", "another-session"]);
    expect(errors).toEqual([{ harness: "omp", originalPath: poison, name: "SourceParseError" }]);
    expect(JSON.stringify(errors)).not.toContain("PRIVATE_SOURCE_TEXT");
    expect(zstdDecompressSync(await readFile(archived[0]!.archivePath))).toEqual(bytes);
  });

  it.each(["remove", "corrupt"] as const)("isolates a source that is %s after discovery", async operation => {
    const { options, sourcePath } = await fixture();
    const root = dirname(sourcePath);
    await rename(sourcePath, join(root, "a-good.jsonl"));
    const poison = join(root, "b-poison.jsonl");
    await writeFile(poison, line({ ...header, id: "poison" }));
    await writeFile(join(root, "c-good.jsonl"), line({ ...header, id: "another-session" }));
    const errors: unknown[] = [];
    const generator = archiveSessions({ ...options, onError: error => errors.push(error) });
    expect((await generator.next()).value?.transcript.id).toBe("example-session");
    if (operation === "remove") await rename(poison, poison + ".removed");
    else await writeFile(poison, "PRIVATE_SOURCE_TEXT");
    expect((await generator.next()).value?.transcript.id).toBe("another-session");
    expect((await generator.next()).done).toBe(true);
    expect(errors).toEqual([{ harness: "omp", originalPath: poison, name: operation === "remove" ? "SourceReadError" : "SourceParseError" }]);
  });

  it("isolates an archive write failure without preventing a later session's archive", async () => {
    const { options } = await fixture();
    const second = join(options.ompRoot!, "project", "later.jsonl");
    await writeFile(second, line({ ...header, id: "later", timestamp: "2026-11-01T00:00:00Z" }));
    await mkdir(join(options.archiveRoot, "omp"), { recursive: true });
    await writeFile(join(options.archiveRoot, "omp", "2026-10"), "Directory blocked by a file");
    const errors: unknown[] = [];
    const archived = await collect({ ...options, onError: error => errors.push(error) });
    expect(archived.map(s => s.transcript.id)).toEqual(["later"]);
    expect(errors).toMatchObject([{ harness: "omp", name: "ArchiveWriteError" }]);
  });

  it("does not commit a group fingerprint when an alternate copy could not be archived", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const directory = dirname(sourcePath);
    await rename(sourcePath, join(directory, "b-canonical.jsonl"));
    const alternate = join(directory, "c-alternate.jsonl");
    await writeFile(alternate, bytes);
    const newer = new Date("2026-10-03T00:00:00Z");
    const older = new Date("2026-10-01T00:00:00Z");
    await utimes(join(directory, "b-canonical.jsonl"), newer, newer);
    await utimes(alternate, older, older);
    await writeFile(join(directory, "a-first.jsonl"), line({ ...header, id: "first-session" }));
    const errors: unknown[] = [];
    const generator = archiveSessions({ ...options, onError: error => errors.push(error) });
    expect((await generator.next()).value?.transcript.id).toBe("first-session");
    await rename(alternate, alternate + ".removed");
    expect((await generator.next()).done).toBe(true);
    expect(errors).toEqual([{ harness: "omp", originalPath: alternate, name: "SourceReadError" }]);
    await rename(alternate + ".removed", alternate);
    const recovered = await collect(options);
    expect(recovered.map(s => s.transcript.id)).toEqual(["first-session", "example-session"]);
  });
});

describe("pruneSupersededArchives", () => {
  const now = new Date("2026-11-03T00:00:00Z");

  it("removes only verified append-only predecessors after a full idle day", async () => {
    const { options, sourcePath } = await fixture();
    const [first] = await collect(options);
    const firstBytes = (await stat(first!.archivePath)).size;
    await appendFile(sourcePath, line(prompt("second", "Second request")));
    const [second] = await collect(options);
    const secondBytes = (await stat(second!.archivePath)).size;
    await appendFile(sourcePath, line(prompt("third", "Third request")));
    const [latest] = await collect(options);
    expect(await pruneSupersededArchives([{ archivePath: latest!.archivePath, changedAt: new Date(now.getTime() - 86400000 + 1) }], now)).toEqual({ pruned: 0, bytes: 0 });
    expect(await pruneSupersededArchives([{ archivePath: latest!.archivePath, changedAt: new Date(now.getTime() - 86400000) }], now)).toEqual({ pruned: 2, bytes: firstBytes + secondBytes });
    await expect(stat(first!.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second!.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readArchivedSession(latest!.archivePath, "omp", sourcePath)).parts).toHaveLength(3);
    expect(await readFile(sourcePath, "utf8")).toContain("Third request");
  });

  it("keeps divergent and rewritten histories even when they are smaller than the latest", async () => {
    const { options, sourcePath } = await fixture();
    const [divergent] = await collect(options);
    await writeFile(sourcePath, line(header) + line(prompt("replacement", "A different and longer request than the first")) + line(prompt("extra", "Extra")));
    const [latest] = await collect(options);
    expect(await pruneSupersededArchives([{ archivePath: latest!.archivePath, changedAt: new Date("2026-11-01T00:00:00Z") }], now)).toEqual({ pruned: 0, bytes: 0 });
    expect((await readArchivedSession(divergent!.archivePath, "omp", sourcePath)).parts[0]!.text).toBe("Initial request");
  });

  it("never removes any catalog head, including a shorter head supplied by the caller", async () => {
    const { options, sourcePath } = await fixture();
    const [first] = await collect(options);
    await appendFile(sourcePath, line(prompt("second", "Second")));
    const [latest] = await collect(options);
    const changedAt = new Date("2026-11-01T00:00:00Z");
    expect(await pruneSupersededArchives([{ archivePath: first!.archivePath, changedAt }, { archivePath: latest!.archivePath, changedAt }], now)).toEqual({ pruned: 0, bytes: 0 });
    expect((await stat(first!.archivePath)).size).toBeGreaterThan(0);
  });

  it("rejects a valid zstd replacement whose bytes no longer match the latest filename hash", async () => {
    const { options, sourcePath, bytes } = await fixture();
    const [first] = await collect(options);
    await appendFile(sourcePath, line(prompt("second", "Second")));
    const [latest] = await collect(options);
    await writeFile(latest!.archivePath, zstdCompressSync(Buffer.concat([bytes, Buffer.from("Unverified extension")])));
    expect(await pruneSupersededArchives([{ archivePath: latest!.archivePath, changedAt: new Date("2026-11-01T00:00:00Z") }], now)).toEqual({ pruned: 0, bytes: 0 });
    expect((await stat(first!.archivePath)).size).toBeGreaterThan(0);
  });
});
