import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { discoverSessionSources, parseSession } from "./sources.js";
import type { SessionSource, SessionSourceOptions } from "./sources.js";
import type { ArchivedSession, SessionHarness, SessionTranscript } from "./types.js";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

export interface ArchiveOptions extends SessionSourceOptions {
  /** The sessions directory under the configured brain home. */
  archiveRoot: string;
}

/** Read a retained version without consulting the original harness or database. */
export async function readArchivedSession(archivePath: string, harness: SessionHarness, originalPath: string): Promise<SessionTranscript> {
  const transcript = parseSession(await decompress(await readFile(archivePath)), harness, originalPath);
  if (!transcript) throw new Error("Archived session has no session header");
  return transcript;
}

async function retainVersion(directory: string, id: string, raw: Buffer): Promise<string> {
  const contentDigest = createHash("sha256").update(raw).digest("hex");
  // Encode identifiers rather than allowing source names to become path components.
  const filename = `${encodeURIComponent(id)}.${contentDigest}`;
  let archivePath = join(directory, `${filename}.jsonl.zst`);
  let compressed: Buffer | undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (;;) {
    let handle;
    try { handle = await open(archivePath, "wx", 0o600); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const retained = await decompress(await readFile(archivePath));
        if (createHash("sha256").update(retained).digest("hex") === contentDigest) return archivePath;
      } catch { /* An interrupted write is retained, never overwritten. */ }
      archivePath = join(directory, `${filename}.${randomUUID()}.jsonl.zst`);
      continue;
    }
    try {
      compressed ??= await compress(raw);
      await handle.writeFile(compressed);
      await handle.sync();
    } finally { await handle.close(); }
    // The catalog is updated only after the complete immutable file is durable.
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return archivePath;
  }
}

async function archiveSourceVersion(source: SessionSource, options: ArchiveOptions): Promise<ArchivedSession | null> {
  let snapshot;
  try { snapshot = await source.read(); }
  catch {
    options.onError?.({ harness: source.harness, originalPath: source.originalPath, name: "SourceReadError" });
    return null;
  }
  let transcript;
  try {
    transcript = parseSession(snapshot.raw, source.harness, source.originalPath);
    if (!transcript || source.sessionId && transcript.id !== source.sessionId) throw new Error("Session identity is unavailable");
  } catch {
    options.onError?.({ harness: source.harness, originalPath: source.originalPath, name: "SourceParseError" });
    return null;
  }
  if (transcript.scratch) return null;
  try {
    const month = transcript.started?.slice(0, 7) ?? "undated";
    const archivePath = await retainVersion(join(options.archiveRoot, source.harness, month), transcript.id, snapshot.raw);
    return { transcript, archivePath, sourceFingerprint: snapshot.sourceFingerprint, sourceBytes: snapshot.raw.length };
  } catch {
    options.onError?.({ harness: source.harness, originalPath: source.originalPath, name: "ArchiveWriteError" });
    return null;
  }
}

/** Only committed catalog fingerprints belong in known; a failed ingest is retried after restart. */
export async function* archiveSessions(options: ArchiveOptions, known: ReadonlyMap<string, string> = new Map()): AsyncGenerator<ArchivedSession> {
  for await (const source of discoverSessionSources(options)) {
    if (source.scratch || known.get(source.originalPath) === source.sourceFingerprint) continue;
    const canonical = await archiveSourceVersion(source, options);
    let complete = canonical !== null;
    for (const version of source.versions?.() ?? []) {
      if (!await archiveSourceVersion(version, options)) complete = false;
    }
    if (complete && canonical) yield canonical;
  }
}

/** Call after ingest with all catalog heads, without a concurrent catalog writer. */
export async function pruneSupersededArchives(
  heads: ReadonlyArray<{ archivePath: string; changedAt: Date }>,
  now: Date = new Date(),
): Promise<{ pruned: number; bytes: number }> {
  const latestPaths = new Set(heads.map(head => resolve(head.archivePath)));
  const versionName = /^(.+)\.([a-f0-9]{64})(?:\.[a-f0-9-]+)?\.jsonl\.zst$/;
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const counts = { pruned: 0, bytes: 0 };
  const versionsByHarness = new Map<string, Map<string, Array<{ path: string; digest: string }>>>();
  for (const head of heads) {
    if (!Number.isFinite(head.changedAt.getTime()) || head.changedAt.getTime() > cutoff) continue;
    const latestPath = resolve(head.archivePath);
    const latestName = versionName.exec(basename(latestPath));
    if (!latestName) continue;
    const harnessDirectory = dirname(dirname(latestPath));
    let versionsBySession = versionsByHarness.get(harnessDirectory);
    if (!versionsBySession) {
      versionsBySession = new Map();
      versionsByHarness.set(harnessDirectory, versionsBySession);
      for (const month of await readdir(harnessDirectory, { withFileTypes: true })) {
        if (!month.isDirectory() || !/^(?:\d{4}-\d{2}|undated)$/.test(month.name)) continue;
        const directory = join(harnessDirectory, month.name);
        for (const candidate of await readdir(directory, { withFileTypes: true })) {
          if (!candidate.isFile()) continue;
          const name = versionName.exec(candidate.name);
          const session = name?.[1], digest = name?.[2];
          const path = join(directory, candidate.name);
          if (!session || !digest || latestPaths.has(path)) continue;
          const versions = versionsBySession.get(session);
          if (versions) versions.push({ path, digest });
          else versionsBySession.set(session, [{ path, digest }]);
        }
      }
    }
    for (const candidate of versionsBySession.get(latestName[1]!) ?? []) {
      let latest: Buffer, older: Buffer, compressedBytes: number;
      try {
        // Re-read and hash immediately before each removal; a previous prefix verdict is never reused.
        latest = await decompress(await readFile(latestPath));
        const compressed = await readFile(candidate.path);
        compressedBytes = compressed.length;
        older = await decompress(compressed);
      } catch { continue; }
      if (older.length >= latest.length
        || createHash("sha256").update(latest).digest("hex") !== latestName[2]
        || createHash("sha256").update(older).digest("hex") !== candidate.digest
        || createHash("sha256").update(latest.subarray(0, older.length)).digest("hex") !== candidate.digest) continue;
      try { await unlink(candidate.path); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      counts.pruned++;
      counts.bytes += compressedBytes;
    }
  }
  return counts;
}
