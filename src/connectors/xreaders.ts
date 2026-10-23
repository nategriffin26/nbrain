// The real network readers behind `hydrateBookmark`: outside pages through a rendering page reader (PAGE_READER: JS
// rendering, PDFs, an archive fallback, one pacing ledger for every caller on the machine), YouTube through yt-dlp (title,
// description and the caption transcript), and images through a vision model on the model endpoint (LLM_URLS).
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../models.js";
import type { HydrateDeps, PageResult } from "./xhydrate.js";

/** The rendering page reader: a command answering `read <urls> --json --lane <name> --max-wait <s> --max-chars 0` with
 *  {results, errors, unretrieved} (nstack's `web`); without PAGE_READER, linked pages are skipped. */
const READER = process.env.PAGE_READER;
const YTDLP = process.env.YTDLP_BIN ?? "yt-dlp";
const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i;
const IMAGE_BYTES = 4_500_000;

const run = (file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }) =>
  new Promise<{ stdout: string; stderr: string; code: number }>(resolve =>
    execFile(file, args, { ...options, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error === null ? 0 : typeof error.code === "number" ? error.code : 1 })));

const transient = (reason: string, status?: number) => status === 429 || (status !== undefined && status >= 500) || /timeout|timed out|rate limit|unreachable|deferred|temporar|ECONN|network/i.test(reason);

/** The reader's JSON payload, which ends at the first unindented `}` (a retry notice may follow it). */
function readerPayload(stdout: string): { results?: { url?: string; final_url?: string; title?: string | null; text?: unknown }[]; errors?: { url?: string; error?: unknown; status?: number }[]; unretrieved?: string[] } | undefined {
  const end = stdout.indexOf("\n}");
  try { return JSON.parse(end < 0 ? stdout : stdout.slice(0, end + 2)); } catch { return undefined; }
}

async function readWeb(urls: string[]): Promise<Map<string, PageResult>> {
  const out = new Map<string, PageResult>();
  if (!READER) { for (const url of urls) out.set(url, { error: "no page reader (PAGE_READER unset)", transient: false }); return out; }
  const { stdout, stderr, code } = await run(READER, ["read", ...urls, "--json", "--lane", "XHydrate", "--max-wait", "300", "--max-chars", "0"], { timeout: 20 * 60_000 });
  const payload = readerPayload(stdout);
  if (payload === undefined) {
    const reason = `page reader failed (exit ${code}): ${stderr.trim().split("\n").pop()?.slice(0, 160) ?? ""}`;
    for (const url of urls) out.set(url, { error: reason, transient: true });
    return out;
  }
  for (const each of payload.results ?? []) {
    const text = typeof each.text === "string" ? each.text : JSON.stringify(each.text ?? "");
    for (const key of [each.url, each.final_url]) if (key !== undefined && urls.includes(key) && !out.has(key)) out.set(key, text.trim() === "" ? { error: "page was empty", transient: false } : { ...(each.title ? { title: each.title } : {}), text });
  }
  for (const each of payload.errors ?? []) {
    if (each.url === undefined || out.has(each.url)) continue;
    const reason = `${String(each.error ?? "fetch failed")}${each.status === undefined ? "" : ` (${each.status})`}`;
    out.set(each.url, { error: reason, transient: transient(reason, each.status) });
  }
  for (const url of payload.unretrieved ?? []) if (!out.has(url)) out.set(url, { error: "deferred by the page reader's rate limit", transient: true });
  return out;
}

/** A YouTube video as text: title, channel, description, and the captions as a transcript with a time mark each minute. */
async function readYouTube(url: string): Promise<PageResult> {
  const dir = await mkdtemp(join(tmpdir(), "x-yt-"));
  try {
    const { stderr, code } = await run(YTDLP, ["--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig,en-US,en-GB", "--sub-format", "json3", "--print-to-file", "%(.{title,channel,duration_string,description})j", join(dir, "meta.json"), "-o", join(dir, "v"), url], { timeout: 120_000 });
    const meta = await readFile(join(dir, "meta.json"), "utf8").then(raw => JSON.parse(raw) as { title?: string; channel?: string; duration_string?: string; description?: string }, () => undefined);
    if (meta === undefined) { const reason = `YouTube: ${stderr.trim().split("\n").pop()?.slice(0, 160) ?? `exit ${code}`}`; return { error: reason, transient: transient(reason) }; }
    const file = (await readdir(dir)).find(name => name.endsWith(".json3"));
    let transcript = "";
    if (file !== undefined) {
      const events = (JSON.parse(await readFile(join(dir, file), "utf8")) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] }).events ?? [];
      let minute = -1;
      for (const event of events) {
        const line = (event.segs ?? []).map(seg => seg.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
        if (line === "") continue;
        const at = Math.floor((event.tStartMs ?? 0) / 60_000);
        if (at !== minute) { minute = at; transcript += `${transcript === "" ? "" : "\n\n"}[${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}] `; } else transcript += " ";
        transcript += line;
      }
    }
    return { title: `${meta.title ?? "YouTube video"}${meta.channel ? ` (${meta.channel})` : ""}`, text: [meta.duration_string ? `Duration: ${meta.duration_string}` : "", meta.description ? `Description:\n${meta.description}` : "", transcript === "" ? "(No captions available, so no transcript.)" : `Transcript:\n\n${transcript}`].filter(Boolean).join("\n\n") };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function readPages(urls: string[]): Promise<Map<string, PageResult>> {
  const videos = urls.filter(url => YOUTUBE.test(url));
  const [web, ...each] = await Promise.all([
    urls.length === videos.length ? Promise.resolve(new Map<string, PageResult>()) : readWeb(urls.filter(url => !YOUTUBE.test(url))),
    ...videos.map(async url => [url, await readYouTube(url).catch((cause): PageResult => ({ error: `YouTube: ${cause instanceof Error ? cause.message : String(cause)}`, transient: true }))] as const),
  ]);
  for (const [url, page] of each) web.set(url, page);
  return web;
}

const IMAGE_PROMPT = "This image came with a bookmarked X post. In one to three sentences, say what it shows so someone can find it by searching later: for a screenshot, the app or page and its key visible text; for a chart, the metric, axes and the trend or numbers; for a diagram or photo, what it depicts. Quote short visible text exactly. No preamble.";

async function describeImage(url: string): Promise<string> {
  // X serves `?name=orig` at full size; `large` is enough to read text and stays well under the model's image limit.
  const source = url.replace(/([?&]name=)\w+/, "$1large");
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`image ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > IMAGE_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const type = /^image\/(?:jpeg|png|gif|webp)$/.test(mime) ? mime : /\.png(?:\?|$)/i.test(url) ? "image/png" : "image/jpeg";
  const messages = [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: `data:${type};base64,${bytes.toString("base64")}` } }, { type: "text" as const, text: IMAGE_PROMPT }] }];
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = (await complete({ role: "reading", messages, maxTokens: 400 })).trim();
      if (text !== "") return text;
      last = new Error("vision model answered nothing");
    } catch (cause) { last = cause; }
  }
  throw last;
}

export const realDeps = (): HydrateDeps => ({ fetch, readPages, describeImage });
