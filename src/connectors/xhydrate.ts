// One X bookmark, hydrated as fully as free sources allow, into one markdown document (the body of its `x.bookmark`
// event, which is what memory indexes and quotes). Everything comes from FxTwitter (no auth, no credits): the
// post and its note text, the thread above and below it (the parent chain when the bookmark is a reply), the quoted post
// with its own thread, the X Article in full, the best replies by other people, and any post it links to; outside pages
// (articles, docs, READMEs, PDFs, YouTube transcripts) are read to text and images are described by a vision model.
// Network readers are injected so tests run offline (`xreaders.ts` has the real ones).
import { createHash } from "node:crypto";
import { type XPost, parseXPost } from "./xpost.js";

export type PageResult = { title?: string; text: string } | { error: string; transient: boolean };

export interface HydrateDeps {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Outside pages read to text, keyed by the URL asked for. */
  readPages: (urls: string[]) => Promise<Map<string, PageResult>>;
  /** One or two sentences on what an image shows, with its visible text; throws when it can't. */
  describeImage: (url: string) => Promise<string>;
}

export interface Hydrated {
  title: string;
  body: string;
  url: string;
  at: number;
  data: Record<string, unknown>;
}

/** What `data.hydration.v` says about how a row was made; a row below this is worth hydrating again. */
export const HYDRATION_VERSION = 3;
const MAX_LINKED_PAGES = 15;
const MAX_IMAGES = 12;
const MAX_PAGE_CHARS = 120_000;
const MAX_REPLIES = 12;
const MAX_UP = 30;
const MAX_EMBEDDED = 25;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const day = (at: number | undefined) => (at === undefined ? "" : new Date(at).toISOString().slice(0, 10));
const idOrder = (a: XPost, b: XPost) => a.id.length - b.id.length || a.id.localeCompare(b.id);
const sameAuthor = (a: XPost, b: XPost) => (a.authorId !== undefined && b.authorId !== undefined ? a.authorId === b.authorId : a.author !== undefined && a.author.toLowerCase() === b.author?.toLowerCase());

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

type Fx = { json: Record<string, unknown> } | { gone: true } | { error: string };

/** One FxTwitter call; transient failures (rate limit, 5xx, network) are retried, a 404 is the post being gone. */
async function fx(deps: HydrateDeps, path: string): Promise<Fx> {
  let error = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const response = await deps.fetch(`https://api.fxtwitter.com/${path}`, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404 || response.status === 401 || response.status === 403) return { gone: true };
      if (response.ok) return { json: record(await response.json()) };
      error = `FxTwitter ${response.status}`;
      if (response.status < 500 && response.status !== 429) return { error };
    } catch (cause) {
      error = `FxTwitter: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  return { error };
}

async function fxPost(deps: HydrateDeps, id: string): Promise<{ post: XPost } | { gone: true } | { error: string }> {
  const answer = await fx(deps, `i/status/${encodeURIComponent(id)}`);
  if (!("json" in answer)) return answer;
  const post = parseXPost(record(answer.json).tweet, id);
  return post === undefined ? { gone: true } : { post };
}

const threadish = (post: XPost) => (post.replies ?? 0) > 0 || post.parentId !== undefined || post.replyingTo !== undefined || /(?:^|\s)\(?\d+\s*\/\s*(?:\d+|n)\)?(?:\s|[.:]|$)|🧵|\bthread\b/i.test(post.text);

/**
 * The posts above `post` (its parent chain, any author, oldest first) and the same-author posts that continue below it,
 * from FxTwitter's thread. `failed` when FxTwitter couldn't say (the caller notes the gap).
 */
async function unroll(deps: HydrateDeps, post: XPost): Promise<{ up: XPost[]; down: XPost[]; failed?: string }> {
  if (!threadish(post)) return { up: [], down: [] };
  const answer = await fx(deps, `2/thread/${encodeURIComponent(post.id)}`);
  if (!("json" in answer)) return { up: [], down: [], ...("error" in answer ? { failed: answer.error } : {}) };
  const found = (Array.isArray(answer.json.thread) ? answer.json.thread : []).flatMap(each => { const parsed = parseXPost(each); return parsed === undefined ? [] : [parsed]; });
  const byId = new Map(found.map(each => [each.id, each]));
  const up: XPost[] = [];
  let failed: string | undefined;
  for (let parent = post.parentId; parent !== undefined && up.length < MAX_UP;) {
    let each = byId.get(parent);
    if (each === undefined) {
      const read = await fxPost(deps, parent);
      if ("post" in read) each = read.post;
      else { if ("error" in read) failed = read.error; break; }
    }
    up.unshift(each);
    parent = each.parentId;
  }
  const connected = new Set([post.id]);
  const down: XPost[] = [];
  for (const each of found.filter(candidate => candidate.id !== post.id && sameAuthor(candidate, post)).sort(idOrder)) {
    if (each.parentId === undefined || !connected.has(each.parentId) || idOrder(each, post) < 0) continue;
    connected.add(each.id);
    down.push(each);
  }
  return { up, down, ...(failed === undefined ? {} : { failed }) };
}

const SUMMONS = /@(?:bot|grok|askperplexity|perplexity_ai|chatgpt|claudeai|gork|aixbt_agent|truth_terminal)\b/i;
const strip = (text: string) => text.replace(/^(?:@\w+\s*)+/, "").trim();

/**
 * The replies worth keeping, best first: the author's own and those people reacted to (a like or a reply), without
 * "@bot do this for me" summons, one-word reactions and link-only posts; a quiet post keeps its longest few instead.
 */
export function selectReplies(replies: readonly XPost[], focal: XPost, taken: ReadonlySet<string>): XPost[] {
  const seen = new Set<string>();
  const usable = replies.filter(reply => {
    const text = strip(reply.text);
    if (reply.id === focal.id || taken.has(reply.id) || seen.has(reply.id)) return false;
    seen.add(reply.id);
    return !SUMMONS.test(reply.text) && /[\p{L}\p{N}]/u.test(text.replace(/https?:\/\/\S+/g, "")) && text.length >= 12;
  });
  const score = (reply: XPost) => (reply.likes ?? 0) * 4 + (reply.replies ?? 0) * 3 + Math.min((reply.views ?? 0) / 500, 5) + (sameAuthor(reply, focal) ? 100 : 0) + (strip(reply.text).length > 140 ? 2 : 0);
  const best = usable.filter(reply => sameAuthor(reply, focal) || (reply.likes ?? 0) > 0 || (reply.replies ?? 0) > 0).sort((a, b) => score(b) - score(a)).slice(0, MAX_REPLIES);
  if (best.length >= 3) return best;
  const rest = usable.filter(reply => !best.includes(reply) && strip(reply.text).length >= 80).sort((a, b) => strip(b.text).length - strip(a.text).length);
  return [...best, ...rest.slice(0, 3 - best.length)];
}

/**
 * The chosen replies as the conversations they sit in: a reply to another reply is shown under it (that parent is pulled in
 * when it wasn't chosen itself), each conversation placed by its best-ranked reply. `chosen` is in rank order.
 */
export function replyTree(chosen: readonly XPost[], all: readonly XPost[], focal: XPost): { text: string; count: number } {
  const byId = new Map(all.map(reply => [reply.id, reply]));
  const kept = new Set(chosen.map(reply => reply.id));
  const rank = new Map<string, number>();
  chosen.forEach((reply, index) => {
    let top = reply;
    for (let parent = reply.parentId; parent !== undefined && parent !== focal.id && byId.has(parent); parent = top.parentId) { top = byId.get(parent)!; kept.add(top.id); }
    rank.set(top.id, Math.min(rank.get(top.id) ?? index, index));
  });
  const children = (id: string) => [...kept].map(each => byId.get(each)!).filter(reply => reply.parentId === id).sort(idOrder);
  const lines: string[] = [];
  const walk = (reply: XPost, depth: number) => {
    const pad = "  ".repeat(depth);
    const orphan = depth === 0 && reply.parentId !== undefined && reply.parentId !== focal.id;
    lines.push(`${pad}- **@${reply.author ?? "someone"}**${reply.likes ? ` (${reply.likes} ${reply.likes === 1 ? "like" : "likes"})` : ""}${orphan ? ` in reply to @${reply.replyingTo ?? "another reply"}` : ""}: ${strip(reply.text).replace(/\n+/g, `\n${pad}  `)}`);
    for (const child of children(reply.id)) walk(child, depth + 1);
  };
  const roots = [...kept].map(id => byId.get(id)!).filter(reply => reply.parentId === undefined || !kept.has(reply.parentId));
  for (const root of roots.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))) walk(root, 0);
  return { text: lines.join("\n"), count: kept.size };
}

async function readReplies(deps: HydrateDeps, post: XPost): Promise<{ all: XPost[]; failed?: string }> {
  if ((post.replies ?? 0) === 0) return { all: [] };
  const answer = await fx(deps, `2/conversation/${encodeURIComponent(post.id)}`);
  if (!("json" in answer)) return { all: [], ...("error" in answer ? { failed: answer.error } : {}) };
  return { all: (Array.isArray(answer.json.replies) ? answer.json.replies : []).flatMap(each => { const parsed = parseXPost(each); return parsed === undefined ? [] : [parsed]; }) };
}

/** Headings in markdown moved `by` levels down, so a page's own `#` never competes with the document's sections (fenced code is left alone). */
export function demote(markdown: string, by: number): string {
  let fenced = false;
  return markdown.split("\n").map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const heading = /^(#{1,6})(\s.*)$/.exec(line);
    return !fenced && heading !== null ? `${"#".repeat(Math.min(6, heading[1]!.length + by))}${heading[2]}` : line;
  }).join("\n");
}

const MEDIA_FILE = /\.(?:jpe?g|png|gif|webp|svg|mp4|mov|webm|mp3|zip|dmg|exe|pkg|gz)(?:[?#].*)?$/i;
const trackingParam = /^(?:utm_\w+|fbclid|gclid|ref|ref_src|s|t)$/i;

/** A link as one comparable key: no fragment, tracking parameters or trailing slash. */
export function linkKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) if (trackingParam.test(key)) parsed.searchParams.delete(key);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch { return undefined; }
}

const cutPage = (text: string): string => {
  if (text.length <= MAX_PAGE_CHARS) return text;
  const at = text.lastIndexOf("\n", MAX_PAGE_CHARS);
  return `${text.slice(0, at > MAX_PAGE_CHARS / 2 ? at : MAX_PAGE_CHARS)}\n\n…[page continues; ${text.length - MAX_PAGE_CHARS} more characters not kept]`;
};

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : line;
};

type Seed = { id: string; handle?: string; text?: string; at?: number };

/**
 * The hydrated document for one bookmark. `seed` is what the bookmark list already says (used when FxTwitter can't read the
 * post). `failed.gone`: the post is deleted or private, nothing was built.
 */
export async function hydrateBookmark(deps: HydrateDeps, seed: Seed): Promise<Hydrated | { failed: string; gone: boolean }> {
  const incomplete: string[] = [];
  const notes: string[] = [];
  const read = await fxPost(deps, seed.id);
  let focal: XPost;
  if ("post" in read) focal = read.post;
  else if (seed.text !== undefined) {
    focal = { id: seed.id, url: `https://x.com/${seed.handle ?? "i"}/status/${seed.id}`, ...(seed.handle === undefined ? {} : { author: seed.handle }), text: seed.text, ...(seed.at === undefined ? {} : { at: seed.at }) };
    incomplete.push("post");
  } else return { failed: "error" in read ? read.error : "post unavailable (deleted or private)", gone: "gone" in read };

  const [{ up, down, failed: threadFailed }, replied] = await Promise.all([unroll(deps, focal), readReplies(deps, focal)]);
  if (threadFailed !== undefined) { incomplete.push("thread"); notes.push(`Couldn't read the thread: ${threadFailed}`); }
  if (replied.failed !== undefined) { incomplete.push("replies"); notes.push(`Couldn't read replies: ${replied.failed}`); }
  const inThread = new Set([focal.id, ...up.map(each => each.id), ...down.map(each => each.id)]);
  const replies = selectReplies(replied.all, focal, inThread);

  // The quoted post, read in full (the bookmark's payload carries it without its own thread), and posts it links to.
  const quoted = focal.quoted === undefined ? undefined : await (async () => {
    const full = await fxPost(deps, focal.quoted!.id);
    const post = "post" in full ? full.post : focal.quoted!;
    if (!("post" in full) && "error" in full) incomplete.push("quote");
    return { post, ...(await unroll(deps, post)) };
  })();
  const shown = new Set([...inThread, ...(quoted === undefined ? [] : [quoted.post.id, ...quoted.up.map(each => each.id), ...quoted.down.map(each => each.id)])]);
  const chain = [focal, ...down, ...up, ...(quoted === undefined ? [] : [quoted.post, ...quoted.up, ...quoted.down])];
  const embeddedIds = [...new Set(chain.flatMap(each => [...(each.embedded ?? []), ...(each !== focal && each.quoted !== undefined ? [each.quoted.id] : [])]))].filter(id => !shown.has(id)).slice(0, MAX_EMBEDDED);
  const fetched = new Map<string, XPost>();
  await pool(embeddedIds, 5, async id => { const each = await fxPost(deps, id); if ("post" in each) fetched.set(id, each.post); });
  const embedded = embeddedIds.flatMap(id => fetched.get(id) ?? []);

  // Outside pages and images, in the order the document tells them: the post, its thread, what is above it, the quote.
  const posts = [focal, ...down, ...up, ...(quoted === undefined ? [] : [quoted.post, ...quoted.down, ...quoted.up]), ...embedded];
  const wanted: string[] = [];
  const keys = new Set<string>();
  for (const url of posts.flatMap(each => each.links ?? [])) {
    const key = linkKey(url);
    if (key === undefined || keys.has(key) || MEDIA_FILE.test(url)) continue;
    keys.add(key);
    wanted.push(url);
  }
  const skipped = wanted.splice(MAX_LINKED_PAGES);
  const pages = wanted.length === 0 ? new Map<string, PageResult>() : await deps.readPages(wanted).catch(cause => new Map<string, PageResult>(wanted.map(url => [url, { error: `page reader failed: ${cause instanceof Error ? cause.message : String(cause)}`, transient: true }])));
  const images = [...new Set(posts.flatMap(each => each.images ?? []))];
  const described = new Map<string, string>();
  await pool(images.slice(0, MAX_IMAGES), 3, async url => {
    try { described.set(url, await deps.describeImage(url)); }
    catch (cause) { incomplete.push(`image:${url}`); described.set(url, `(not described: ${oneLine(cause instanceof Error ? cause.message : String(cause), 120)})`); }
  });

  // One post as a block: its text, any quote it makes (the bookmarked post's is its own section), images and videos, and its Article.
  const postBlock = (each: XPost): string => [
    `### ${each.author === undefined ? "Someone" : `@${each.author}`}${each.at === undefined ? "" : ` · ${day(each.at)}`} · ${each.url}`,
    ...(each.article !== undefined && /^https?:\/\/t\.co\/\S+$/.test(each.text.trim()) ? [] : [each.text]),
    ...(each !== focal && each.quote !== undefined && !fetched.has(each.quoted?.id ?? "") ? [`Quoting ${each.quote}`] : []),
    ...(each.images ?? []).map(url => `[Image] ${described.get(url) ?? "(not described: more images than are described per bookmark)"}`),
    ...(each.videos ?? []).map(video => `[${video.gif ? "GIF" : "Video"}${video.duration === undefined ? "" : `, ${Math.round(video.duration)}s`}] ${video.url}`),
    ...(each.article === undefined ? [] : [`#### ${each.title === undefined ? "Article" : `Article: ${each.title}`}`, demote(each.article, 4)]),
  ].join("\n\n");

  const sections: string[] = [];
  const section = (heading: string, ...parts: string[]) => sections.push([`## ${heading}`, ...parts].join("\n\n"));
  section("Post", postBlock(focal));
  if (up.length > 0) section(focal.parentId === undefined ? "Earlier in the thread" : "Conversation above the post", ...up.map(postBlock));
  if (down.length > 0) section(`Thread continues (${down.length} more ${down.length === 1 ? "post" : "posts"})`, ...down.map(postBlock));
  if (quoted !== undefined) section("Quoted post", ...[...quoted.up, quoted.post, ...quoted.down].map(postBlock));
  else if (focal.quote !== undefined) section("Quoted post", `Quoting ${focal.quote}`, ...(focal.quoteArticle === undefined ? [] : [focal.quoteArticle]));
  if (embedded.length > 0) section("Posts it links to", ...embedded.map(postBlock));
  const conversation = replyTree(replies, replied.all, focal);
  if (conversation.count > 0) section(`Replies (${conversation.count} of ${Math.max(focal.replies ?? 0, replied.all.length)}, by engagement)`, conversation.text);
  let linksOk = 0;
  const linksFailed: { url: string; reason: string }[] = [];
  const linked: string[] = [];
  for (const url of wanted) {
    const page = pages.get(url) ?? { error: "no answer from the page reader", transient: true };
    if ("error" in page) {
      linksFailed.push({ url, reason: page.error });
      if (page.transient) incomplete.push(`link:${url}`);
      linked.push(`### ${url}\n\n(Couldn't read this page: ${page.error})`);
    } else {
      linksOk++;
      linked.push(`### ${page.title === undefined || page.title.trim() === "" ? url : `${oneLine(page.title, 160)} — ${url}`}\n\n${demote(cutPage(page.text.trim()), 3)}`);
    }
  }
  if (linked.length > 0) section("Linked pages", ...linked);
  if (skipped.length > 0) notes.push(`Links not read (over ${MAX_LINKED_PAGES} per bookmark): ${skipped.join(" ")}`);
  if (images.length > MAX_IMAGES) notes.push(`${images.length - MAX_IMAGES} images not described (over ${MAX_IMAGES} per bookmark)`);
  if (notes.length > 0) section("Not read", ...notes.map(note => `- ${note}`));

  const author = focal.author ?? seed.handle ?? "";
  const titleText = focal.title ?? oneLine(focal.text, 100);
  const title = `${author === "" ? "Someone" : `@${author}`}${titleText === "" ? "" : ` — ${titleText}`}`;
  const engagement = [focal.likes ? `${focal.likes} likes` : "", focal.replies ? `${focal.replies} replies` : "", focal.views ? `${focal.views} views` : ""].filter(Boolean).join(" · ");
  // A NUL byte (some PDFs and pages carry them) is not storable in Postgres text.
  const body = [`# ${title}`, `Bookmarked X post${author === "" ? "" : ` by @${author}`}${focal.at === undefined ? "" : `, posted ${day(focal.at)}`}${engagement === "" ? "" : ` (${engagement})`}: ${focal.url}`, ...sections].join("\n\n").replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const at = focal.at ?? seed.at ?? Date.now();
  return {
    title,
    body,
    url: focal.url,
    at,
    data: {
      author,
      posted_at: new Date(at).toISOString(),
      ...(focal.title === undefined ? {} : { article_title: focal.title }),
      ...(down.length > 0 ? { thread: down.length + 1 } : {}),
      ...(wanted.length > 0 ? { links: wanted } : {}),
      hydration: {
        v: HYDRATION_VERSION,
        sha: createHash("sha256").update(body).digest("hex"),
        parts: { parents: up.length, thread: down.length, replies: replies.length, quote: quoted !== undefined || focal.quote !== undefined, article: focal.article !== undefined, links_ok: linksOk, links_failed: linksFailed.length, images: Math.min(images.length, MAX_IMAGES) },
        ...(linksFailed.length > 0 ? { links_failed: linksFailed } : {}),
        ...(incomplete.length > 0 ? { incomplete } : {}),
      },
    },
  };
}
