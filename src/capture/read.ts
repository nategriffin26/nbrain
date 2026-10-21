// Reads a URL, a pasted text or a local file into one markdown document plus a snapshot of what was fetched.
// X posts go through the free X hydration, YouTube through the yt-dlp transcript reader, PDFs through unpdf, other pages
// through Defuddle; a page that comes out thin (JS-rendered) is read again through the research helper's rendering fetch.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { hydrateBookmark } from "../connectors/xhydrate.js";
import { realDeps } from "../connectors/xreaders.js";
import { contentId } from "./id.js";

export type Form = "page" | "pdf" | "video" | "post" | "note" | "file";
export interface Captured {
  /** The event's external_id and url: the canonical URL, or `text:`/`file:` + a content hash. */
  external_id: string;
  url: string | null;
  original_url?: string;
  title: string;
  body: string;
  form: Form;
  reader: string;
  site?: string;
  author?: string;
  published?: string;
  /** What was fetched, kept beside the text: gzipped HTML or the PDF itself. */
  snapshot?: { bytes: Buffer; ext: "html.gz" | "pdf" };
}

/** Below this many words an HTML extraction is taken for a page that renders in JavaScript. */
const THIN_WORDS = 200;
const FETCH_TIMEOUT = 45_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const TRACKING = /^(?:utm_.*|fbclid|gclid|ref|mc_.*)$/i;
const X_STATUS = /^https:\/\/x\.com\/(?:i\/web|([A-Za-z0-9_]{1,15}))\/status\/(\d+)/;
const YOUTUBE = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Lowercase scheme and host, no fragment, no tracking parameters; twitter.com is x.com. */
export function canonicalUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Not a web address: ${input}`);
  url.hash = "";
  if (/^(?:www\.|mobile\.)?twitter\.com$/.test(url.hostname)) url.hostname = "x.com";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.toString();
}

/** A page's text as the research helper's JS-rendering reader gives it (readPages handles the YouTube transcripts too). */
async function readRendered(url: string) {
  const page = (await realDeps().readPages([url]).catch(() => new Map())).get(url);
  return page !== undefined && "text" in page ? page : undefined;
}

async function readPdf(bytes: Buffer, fallbackTitle: string) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  const info = (await getMeta(pdf)).info as { Title?: unknown; Author?: unknown } | undefined;
  const title = typeof info?.Title === "string" && info.Title.trim() !== "" ? info.Title.trim() : fallbackTitle;
  return { title, text: text.replace(/\0/g, "").trim(), author: typeof info?.Author === "string" && info.Author.trim() !== "" ? info.Author.trim() : undefined };
}

async function readHtml(html: string, url: string) {
  const { document } = parseHTML(html);
  const page = await Defuddle(document as never, url, { markdown: true });
  return { title: page.title, body: page.content.trim(), site: page.site || undefined, author: page.author || undefined, published: page.published || undefined };
}

/** Fetch a URL, following redirects; the final URL is the one kept. */
async function fetchPage(url: string) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return { bytes: Buffer.from(await response.arrayBuffer()), type: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), charset: /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1], final: canonicalUrl(response.url || url) };
}

const decode = (bytes: Buffer, charset?: string) => { try { return new TextDecoder(charset ?? "utf-8").decode(bytes); } catch { return bytes.toString("utf8"); } };
const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";

/** The page at `input`, read as the kind of thing it is. */
export async function readUrl(input: string): Promise<Captured> {
  const original = input.trim();
  const url = canonicalUrl(original);
  const x = X_STATUS.exec(url);
  if (x !== null) {
    const post = await hydrateBookmark(realDeps(), { id: x[2]!, ...(x[1] === undefined ? {} : { handle: x[1] }) });
    if ("failed" in post) throw new Error(`Could not read the post: ${post.failed}`);
    const canonical = canonicalUrl(post.url);
    return { external_id: canonical, url: canonical, ...(canonical === original ? {} : { original_url: original }), title: post.title, body: post.body.replace("Bookmarked X post", "X post"), form: "post", reader: "xhydrate", site: "x.com", author: String(post.data.author ?? "") || undefined, published: String(post.data.posted_at ?? "") || undefined };
  }
  if (YOUTUBE.test(url)) {
    const page = (await realDeps().readPages([url])).get(url);
    if (page === undefined || "error" in page) throw new Error(`Could not read the video: ${page?.error ?? "no answer"}`);
    return { external_id: url, url, ...(url === original ? {} : { original_url: original }), title: page.title ?? url, body: page.text, form: "video", reader: "yt-dlp", site: "youtube.com" };
  }

  let fetched: Awaited<ReturnType<typeof fetchPage>>;
  try { fetched = await fetchPage(url); }
  catch (cause) {
    // sites that refuse a plain fetch (403, bot walls) are the rendering reader's to try
    const page = await readRendered(url);
    if (page === undefined) throw new Error(`Could not fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { external_id: url, url, ...(url === original ? {} : { original_url: original }), title: page.title ?? url, body: page.text.trim(), form: "page", reader: "tf" };
  }
  const { bytes, final } = fetched;
  const common = { external_id: final, url: final, ...(final === original ? {} : { original_url: original }) };
  if (isPdf(bytes)) {
    const pdf = await readPdf(bytes, decodeURIComponent(basename(new URL(final).pathname)).replace(/\.pdf$/i, "") || final);
    if (pdf.text === "") throw new Error("The PDF has no text layer (a scan); nothing to keep.");
    return { ...common, title: pdf.title, body: pdf.text, form: "pdf", reader: "unpdf", ...(pdf.author ? { author: pdf.author } : {}), snapshot: { bytes, ext: "pdf" } };
  }
  if (!/html|xml|^text\//.test(fetched.type) && fetched.type !== "") throw new Error(`Not a page or a PDF (${fetched.type}).`);
  const html = decode(bytes, fetched.charset);
  let page = await readHtml(html, final);
  let reader = "defuddle";
  if (words(page.body) < THIN_WORDS) {
    const rendered = await readRendered(final);
    if (rendered !== undefined && words(rendered.text) > words(page.body)) { page = { ...page, title: rendered.title || page.title, body: rendered.text.trim() }; reader = "tf"; }
  }
  if (page.body === "") throw new Error("The page has no readable text.");
  return { ...common, title: page.title || final, body: page.body, form: "page", reader, ...(page.site ? { site: page.site } : {}), ...(page.author ? { author: page.author } : {}), ...(page.published ? { published: page.published } : {}), snapshot: { bytes: gzipSync(Buffer.from(html)), ext: "html.gz" } };
}

/** A pasted note, verbatim; its title is `title` or its first line. */
export function readText(text: string, title?: string): Captured {
  const body = text.replace(/\0/g, "").trim();
  if (body === "") throw new Error("The text is empty.");
  return { external_id: contentId("text", body), url: null, title: title?.trim() || body.split("\n", 1)[0]!.replace(/^#+\s*/, "").slice(0, 100), body, form: "note", reader: "text" };
}

/** A file on this machine: a PDF, an HTML page, or text. */
export async function readFileAt(path: string, title?: string): Promise<Captured> {
  const bytes = await readFile(path);
  const name = basename(path);
  const common = { external_id: contentId("file", bytes), url: null, form: "file" as const };
  if (isPdf(bytes)) {
    const pdf = await readPdf(bytes, name.replace(/\.pdf$/i, ""));
    if (pdf.text === "") throw new Error("The PDF has no text layer (a scan); nothing to keep.");
    return { ...common, title: title?.trim() || pdf.title, body: pdf.text, reader: "unpdf", ...(pdf.author ? { author: pdf.author } : {}), snapshot: { bytes, ext: "pdf" } };
  }
  if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${name} is not a PDF or a text file.`);
  const raw = bytes.toString("utf8");
  if (/^\.html?$/i.test(extname(name))) {
    const page = await readHtml(raw, `file:///${name}`);
    return { ...common, title: title?.trim() || page.title || name, body: page.body, reader: "defuddle", ...(page.author ? { author: page.author } : {}), ...(page.published ? { published: page.published } : {}), snapshot: { bytes: gzipSync(bytes), ext: "html.gz" } };
  }
  const body = raw.replace(/\0/g, "").trim();
  if (body === "") throw new Error(`${name} is empty.`);
  return { ...common, title: title?.trim() || name, body, reader: "text" };
}
