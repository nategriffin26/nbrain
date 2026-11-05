import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { BETTERLEAKS_BIN } from "../config.js";

const VERSION = "1.10.0";
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_PARTS = 2048;
const REPORT_BYTES = 128 * 1024 * 1024;
const MARKER = /\[REDACTED:[a-zA-Z0-9_.-]+:[a-f0-9]{8}\]/g;
const PREFIX = /^(?:sk-ant-(?:api\d+-)?|sk-or-v1-|sk-proj-|sk-svcacct-|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AIza|tskey-(?:auth-|api-)?)/;

/** Serialized tool arguments retain JSON whitespace escapes before otherwise bare credentials. */
function credentialPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source.replace(/^\\b/, String.raw`(?:\b|(?<=\\[nrtbf])|(?<=\\u(?:000[9a-dA-D]|0020)))`), pattern.flags);
}

// Fixed shapes are not subject to the scanner's entropy and example-value filters.
const RULES: readonly [string, RegExp, number?][] = [
  ["private-key", /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g],
  ["anthropic-key", credentialPattern(/\bsk-ant-[A-Za-z0-9_-]{20,}/g)],
  ["openrouter-key", credentialPattern(/\bsk-or-v1-[A-Za-z0-9_-]{20,}/g)],
  ["openai-key", credentialPattern(/\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/g)],
  ["api-key", credentialPattern(/\bsk-(?!ant-|or-)[A-Za-z0-9_-]{20,}/g)],
  ["github-token", credentialPattern(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g)],
  ["slack-token", credentialPattern(/\bxox[baprs]-[A-Za-z0-9-]{20,}/g)],
  ["aws-access-key", credentialPattern(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g)],
  ["google-api-key", credentialPattern(/\bAIza[A-Za-z0-9_-]{35}/g)],
  ["tailscale-key", credentialPattern(/\btskey-[A-Za-z0-9_-]{20,}/g)],
  ["stripe-key", credentialPattern(/\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/g)],
  ["credential-url", credentialPattern(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+:[^\s/@]+)@/gi), 1],
  ["authorization", credentialPattern(/\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9+/_=.-]{8,})/gi), 1],
  ["credential-assignment", credentialPattern(/\b(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*["']?([^\s"'`,;<>\[\]{}]{8,})/gi), 1],
];

interface Span { start: number; end: number; type: string; secret: string }
interface Finding {
  RuleID: string;
  Secret: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
  ComponentSets?: { components: Finding[] }[];
}

/** Errors deliberately exclude child output, input, and underlying exception messages. */
export class RedactionError extends Error {
  constructor(message: string) { super(message); this.name = "RedactionError"; }
}

function run(args: string[], input: Buffer): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // No inherited scanner configuration, provider credentials, or proxy settings.
  const child = spawn(BETTERLEAKS_BIN, args, {
    cwd: homedir(),
    env: { PATH: process.env.PATH, HOME: homedir(), GOMAXPROCS: "2" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const fail = () => { failed = true; child.kill(); };
  const timer = setTimeout(fail, 120_000);
  child.on("error", () => { clearTimeout(timer); reject(new RedactionError("Betterleaks could not start")); });
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > REPORT_BYTES) fail();
    else chunks.push(chunk);
  });
  child.on("close", code => {
    clearTimeout(timer);
    if (failed || code !== 0) reject(new RedactionError("Betterleaks scan failed; no text was released"));
    else resolve(Buffer.concat(chunks).toString("utf8"));
  });
  child.stdin.end(input);
  return promise;
}

let version: Promise<void> | undefined;
function requireVersion(): Promise<void> {
  version ??= run(["version"], Buffer.alloc(0)).then(value => {
    if (value.trim() !== VERSION) throw new RedactionError(`Betterleaks ${VERSION} is required`);
  }).catch(error => { version = undefined; throw error; });
  return version;
}

function replacement(span: Span): string {
  const digest = createHash("sha256").update(span.secret).digest("hex").slice(0, 8);
  const prefix = span.secret.match(PREFIX)?.[0] ?? "";
  return `${prefix}[REDACTED:${span.type}:${digest}]`;
}

// Decode fixed-rule candidates as well: the scanner filters illustrative values
// even when their encoded form must not be returned by a recall surface.
const ENCODINGS: readonly [RegExp, (value: string) => string][] = [
  [/[A-Za-z0-9+/_-]{16,}={0,2}/g, value => {
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64").replace(/=+$/, "") === value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "") ? bytes.toString("utf8") : "";
  }],
  [/\b(?:[a-fA-F0-9]{2}){16,}\b/g, value => Buffer.from(value, "hex").toString("utf8")],
  [/[A-Za-z0-9%_./+=-]*%[a-fA-F0-9]{2}[A-Za-z0-9%_./+=-]*/g, value => {
    try { return decodeURIComponent(value); } catch { return ""; }
  }],
  [/(?:\\u[a-fA-F0-9]{4}){4,}/g, value => value.replace(/\\u([a-fA-F0-9]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))],
];

function fixedSpans(text: string, depth = 0): Span[] {
  const spans: Span[] = [];
  for (const [type, pattern, group] of RULES) {
    for (const match of text.matchAll(pattern)) {
      const secret = match[group ?? 0]!;
      const start = match.index + (group ? match[0].lastIndexOf(secret) : 0);
      spans.push({ start, end: start + secret.length, type, secret });
    }
  }
  if (depth < 5) {
    for (const [pattern, decode] of ENCODINGS) for (const match of text.matchAll(pattern)) {
      if (spans.some(span => span.start <= match.index && span.end >= match.index + match[0].length)) continue;
      const decoded = decode(match[0]);
      if (!decoded || decoded === match[0] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(decoded)) continue;
      const secrets = fixedSpans(decoded, depth + 1);
      if (secrets.length === 0) continue;
      const first = secrets[0]!;
      spans.push({ start: match.index, end: match.index + match[0].length, type: first.type, secret: first.secret });
    }
  }
  return spans;
}

function apply(text: string, spans: Span[]): string {
  const protectedSpans = [...text.matchAll(MARKER)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  const sorted = spans.filter(span => !protectedSpans.some(marker => span.start >= marker.start && span.end <= marker.end))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.start >= previous.end) merged.push({ ...span });
    else if (span.end > previous.end) {
      previous.end = span.end;
      previous.secret = text.slice(previous.start, previous.end);
    }
  }
  let end = 0;
  const output: string[] = [];
  for (const span of merged) {
    output.push(text.slice(end, span.start), replacement(span));
    end = span.end;
  }
  output.push(text.slice(end));
  return output.join("");
}

async function redactBatch(texts: readonly string[]): Promise<string[]> {
  // Plain text preserves multiline keys. Byte coordinates map findings back without
  // putting transcripts or reports in temporary files or exposing them in argv.
  const buffers = texts.map(text => Buffer.from(text.replace(MARKER, marker => " ".repeat(marker.length))));
  const starts: number[] = [];
  let offset = 0;
  const pieces: Buffer[] = [];
  for (const buffer of buffers) {
    starts.push(offset);
    pieces.push(buffer, Buffer.from("\n\n"));
    offset += buffer.length + 2;
  }
  const input = Buffer.concat(pieces);
  const report = await run([
    "stdin", "--no-banner", "--no-color", "--log-level", "error",
    "--report-format", "json", "--report-path", "-", "--exit-code", "0",
    "--ignore-gitleaks-allow", "--gitleaks-ignore-path", "/dev/null",
    "--validation=false", "--max-decode-depth", "5", "--max-archive-depth", "0",
  ], input);
  let findings: unknown;
  try { findings = JSON.parse(report); }
  catch { throw new RedactionError("Betterleaks returned an invalid report"); }
  if (!Array.isArray(findings)) throw new RedactionError("Betterleaks returned an invalid report");
  const lines = [0];
  for (let at = input.indexOf(10); at !== -1; at = input.indexOf(10, at + 1)) lines.push(at + 1);
  const spans = texts.map(text => fixedSpans(text));
  const pending: unknown[] = [...findings];
  for (const value of pending) {
    if (!value || typeof value !== "object") throw new RedactionError("Betterleaks returned an invalid finding");
    const finding = value as Finding;
    if (typeof finding.RuleID !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(finding.RuleID) || typeof finding.Secret !== "string" || !finding.Secret ||
      ![finding.StartLine, finding.EndLine, finding.StartColumn, finding.EndColumn].every(Number.isSafeInteger)) {
      throw new RedactionError("Betterleaks returned an invalid finding");
    }
    const first = lines[finding.StartLine - 1];
    const last = lines[finding.EndLine - 1];
    if (first === undefined || last === undefined || finding.StartColumn < 1 || finding.EndColumn < 0) throw new RedactionError("Betterleaks returned invalid coordinates");
    let start = first + finding.StartColumn - 1;
    let end = last + finding.EndColumn;
    if (start < first || end <= start || end > input.length) throw new RedactionError("Betterleaks returned invalid coordinates");
    const raw = input.subarray(start, end);
    const secret = Buffer.from(finding.Secret);
    const within = raw.indexOf(secret);
    // Decoded findings point at the original encoded range, which must be removed whole.
    if (within !== -1) { start += within; end = start + secret.length; }
    let matched = false;
    for (let part = 0; part < texts.length; part++) {
      const base = starts[part]!;
      const buffer = buffers[part]!;
      const left = Math.max(start, base);
      const right = Math.min(end, base + buffer.length);
      if (left >= right) continue;
      matched = true;
      spans[part]!.push({ start: buffer.toString("utf8", 0, left - base).length, end: buffer.toString("utf8", 0, right - base).length, type: finding.RuleID, secret: finding.Secret });
    }
    if (!matched) throw new RedactionError("Betterleaks finding did not map to an input");
    if (finding.ComponentSets !== undefined) {
      if (!Array.isArray(finding.ComponentSets)) throw new RedactionError("Betterleaks returned invalid components");
      for (const set of finding.ComponentSets) {
        if (!Array.isArray(set.components)) throw new RedactionError("Betterleaks returned invalid components");
        pending.push(...set.components);
      }
    }
  }
  return texts.map((text, index) => apply(text, spans[index]!));
}

/** Offline redaction before indexing, clipping, embedding, or serving any transcript. */
export async function redactTexts(texts: readonly string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  await requireVersion();
  const output: string[] = [];
  let start = 0;
  while (start < texts.length) {
    let end = start;
    let bytes = 0;
    while (end < texts.length && end - start < BATCH_PARTS) {
      const size = Buffer.byteLength(texts[end]!) + 2;
      if (end > start && bytes + size > BATCH_BYTES) break;
      bytes += size;
      end++;
    }
    output.push(...await redactBatch(texts.slice(start, end)));
    start = end;
  }
  return output;
}

/** Redact JSON string leaves together, retaining keys, scalar values, and Dates. */
export async function redactValue<T>(value: T): Promise<T> {
  const texts: string[] = [];
  function collect(node: unknown): void {
    if (typeof node === "string") texts.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node !== null && typeof node === "object" && !(node instanceof Date)) {
      if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
        throw new RedactionError("Redaction requires JSON values or Dates");
      }
      Object.values(node).forEach(collect);
    }
  }
  collect(value);
  const redacted = await redactTexts(texts);
  let index = 0;
  function rebuild(node: unknown): unknown {
    if (typeof node === "string") return redacted[index++];
    if (Array.isArray(node)) return node.map(rebuild);
    if (node !== null && typeof node === "object" && !(node instanceof Date)) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rebuild(child)]));
    }
    return node;
  }
  return rebuild(value) as T;
}
