// Ported from Context knowledge/kb/xpost.ts (free reads through FxTwitter). The two text helpers it imported from
// content/text.ts are inlined.
const X_ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&" };
/** A post's text as its author wrote it: X sends `&`, `<` and `>` escaped. One pass, so `&amp;lt;` is `&lt;`. */
export const fromX = (text: string): string => text.replace(/&(?:lt|gt|amp);/g, entity => X_ENTITIES[entity]!);
/** An X/Twitter post's id from its link (x.com, twitter.com, mobile, fxtwitter, vxtwitter), or undefined. */
export function xPostId(url: string): string | undefined {
  const match = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/(?:[\w]+|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/i.exec(url.trim());
  return match?.[1];
}


/**
 * An X post as fxtwitter tells it. `article`: an Article's body as markdown. `links`: pages its text links to (not X's
 * own), expanded, at most `MAX_LINKS`.
 */
export type XPost = {
  id: string; url: string; author?: string; authorId?: string; text: string; at?: number;
  quote?: string; quoteArticle?: string; quoted?: XPost;
  title?: string; article?: string; links?: string[];
  parentId?: string; replyingTo?: string; replies?: number; images?: string[];
  embedded?: string[]; likes?: number; views?: number; videos?: { url: string; duration?: number; gif: boolean }[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Outbound links one post lists, at most (its text's first, then its Article's). */
const MAX_LINKS = 12;

type Range = { key: number; offset: number; length: number };
type Block = { type?: unknown; text?: unknown; depth?: unknown; entityRanges?: unknown };
type Entity = { type?: unknown; data?: unknown };

/** The entity map as a lookup: fxtwitter sends an array of `{key, value}` (Draft.js itself an object). */
function entities(map: unknown): Map<string, Entity> {
  const found = new Map<string, Entity>();
  const items: [string, unknown][] = Array.isArray(map)
    ? map.map((each, index) => [String(record(each)?.key ?? index), record(each)?.value])
    : Object.entries(record(map) ?? {});
  for (const [key, value] of items) {
    const entity = record(value);
    if (entity !== undefined) found.set(key, entity);
  }
  return found;
}

const ranges = (value: unknown): Range[] =>
  (Array.isArray(value) ? value : []).flatMap((each) => {
    const range = record(each);
    return typeof range?.key === "number" && typeof range.offset === "number" && typeof range.length === "number" ? [{ key: range.key, offset: range.offset, length: range.length }] : [];
  });

/** A block's text with its link entities as markdown links (offsets are UTF-16 units, as in JavaScript). */
function inline(block: Block, known: Map<string, Entity>): string {
  let text = String(block.text ?? "");
  for (const range of ranges(block.entityRanges).sort((a, b) => b.offset - a.offset)) {
    const entity = known.get(String(range.key));
    const url = entity?.type === "LINK" ? record(entity.data)?.url : undefined;
    if (typeof url !== "string") continue;
    text = `${text.slice(0, range.offset)}[${text.slice(range.offset, range.offset + range.length)}](${url})${text.slice(range.offset + range.length)}`;
  }
  return text;
}

/** What an atomic block (one entity) stands for: code and other markdown as written, a divider, a short placeholder for media. */
function atomic(block: Block, known: Map<string, Entity>): string | undefined {
  const first = ranges(block.entityRanges)[0];
  const entity = first === undefined ? undefined : known.get(String(first.key));
  const data = record(entity?.data);
  switch (entity?.type) {
    case "MARKDOWN":
      return typeof data?.markdown === "string" ? data.markdown.trim() : undefined;
    case "DIVIDER":
      return "---";
    case "TWEET":
      return typeof data?.tweetId === "string" ? `[Embedded post: https://x.com/i/status/${data.tweetId}]` : "[Embedded post]";
    case "MEDIA":
      return typeof data?.caption === "string" && data.caption.trim() !== "" ? `[Image]\n\n${data.caption.trim()}` : "[Image]";
    default:
      return undefined;
  }
}

const HEADINGS: Record<string, string> = { "header-one": "##", "header-two": "###", "header-three": "####", "header-four": "####", "header-five": "####", "header-six": "####" };

/**
 * An Article's body as markdown: headings (one level down, so the capture's own `##` sections stay the top level),
 * lists, quotes, code, links; media and embedded posts as one-line placeholders. Undefined when it has no blocks.
 */
function renderArticle(content: unknown): string | undefined {
  const source = record(content);
  const blocks = Array.isArray(source?.blocks) ? source.blocks : [];
  if (blocks.length === 0) return undefined;
  const known = entities(source?.entityMap);
  const out: string[] = [];
  let list: "ul" | "ol" | undefined;
  let number = 0;
  for (const each of blocks) {
    const block = record(each) as Block | undefined;
    if (block === undefined) continue;
    const type = String(block.type ?? "unstyled");
    const text = type === "atomic" ? (atomic(block, known) ?? "") : inline(block, known).trim();
    if (text === "") continue;
    const indent = "  ".repeat(Math.min(4, typeof block.depth === "number" ? block.depth : 0));
    if (type === "unordered-list-item" || type === "ordered-list-item") {
      const kind = type === "ordered-list-item" ? "ol" : "ul";
      number = list === kind ? number + 1 : 1;
      const line = `${indent}${kind === "ol" ? `${number}.` : "-"} ${text}`;
      // consecutive items are one list; a different kind starts a new one
      if (list === kind) out[out.length - 1] += `\n${line}`;
      else out.push(line);
      list = kind;
      continue;
    }
    list = undefined;
    if (type === "code-block") out.push(`\`\`\`\n${text}\n\`\`\``);
    else if (type === "blockquote") out.push(text.split("\n").map((line) => `> ${line}`).join("\n"));
    else if (HEADINGS[type] !== undefined) out.push(`${HEADINGS[type]} ${text}`);
    else out.push(text);
  }
  return out.length === 0 ? undefined : out.join("\n\n");
}

/** Hosts whose links are the post itself, its media, its quote or another post: never followed as outside pages. */
const OWN_HOSTS = /^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com|t\.co|pic\.twitter\.com|pic\.x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/i;

/**
 * The text of a post with its t.co links expanded, and the expanded links worth reading: http(s) only, not X's own
 * links, each once, at most `MAX_LINKS`, in the order the post gives them.
 */
export function expandFacets(raw: unknown): { text: string | undefined; links: string[] } {
  const source = record(raw);
  let text = typeof source?.text === "string" ? source.text : undefined;
  const links: string[] = [];
  for (const each of Array.isArray(source?.facets) ? source.facets : []) {
    const facet = record(each);
    if (facet?.type !== "url" || typeof facet.replacement !== "string") continue;
    if (text !== undefined && typeof facet.original === "string" && facet.original !== "") text = text.replace(facet.original, () => facet.replacement as string);
    let url: URL;
    try {
      url = new URL(facet.replacement);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || OWN_HOSTS.test(url.hostname)) continue;
    if (!links.includes(facet.replacement)) links.push(facet.replacement);
  }
  return { text, links: links.slice(0, MAX_LINKS) };
}

/** An Article's body: its rendered blocks, else its preview text. */
function articleBody(article: Record<string, unknown> | undefined): string | undefined {
  return renderArticle(article?.content) ?? (typeof article?.preview_text === "string" && article.preview_text !== "" ? article.preview_text : undefined);
}

/** Both FxTwitter API versions, including embedded quotes; author avatars are deliberately not media. */
export function parseXPost(value: unknown, fallbackId?: string, depth = 0): XPost | undefined {
  const tweet = record(value);
  const id = typeof tweet?.id === "string" && /^\d+$/.test(tweet.id) ? tweet.id : fallbackId;
  if (tweet === undefined || id === undefined || !/^\d+$/.test(id) || typeof tweet.text !== "string") return undefined;
  const author = record(tweet.author);
  const quote = record(tweet.quote);
  const article = record(tweet.article);
  const handle = typeof author?.screen_name === "string" ? author.screen_name : undefined;
  const created = typeof tweet.created_timestamp === "number" ? tweet.created_timestamp * 1000 : Date.parse(String(tweet.created_at ?? ""));
  const expanded = expandFacets(tweet.raw_text);
  const body = articleBody(article);
  const links = [...expanded.links];
  const references = new Set<string>();
  // Plain URLs and Article link entities survive even when a nested payload has no raw_text facets.
  for (const match of `${expanded.text ?? tweet.text}\n${body ?? ""}`.matchAll(/https?:\/\/[^\s<>"\]]+/g)) {
    const value = match[0].replace(/[)\],.;:!?'"*_]+$/, "");
    const referenced = xPostId(value);
    if (referenced !== undefined && referenced !== id) references.add(referenced);
    try {
      if (!OWN_HOSTS.test(new URL(value).hostname) && !links.includes(value)) links.push(value);
    } catch { /* A malformed URL is not an outbound page. */ }
  }
  const quotedArticle = record(quote?.article);
  const quotedBody = articleBody(quotedArticle);
  const reply = record(tweet.replying_to);
  const parentId = typeof tweet.replying_to_status === "string" ? tweet.replying_to_status : typeof reply?.status === "string" ? reply.status : undefined;
  const replyingTo = typeof tweet.replying_to === "string" ? tweet.replying_to : typeof reply?.screen_name === "string" ? reply.screen_name : undefined;
  const media = record(tweet.media);
  const photos = Array.isArray(media?.photos) ? media.photos : Array.isArray(media?.all) ? media.all.filter(each => record(each)?.type === "photo") : [];
  const images = photos.flatMap(each => typeof record(each)?.url === "string" ? [String(record(each)!.url)] : []);
  const videos = (Array.isArray(media?.videos) ? media.videos : Array.isArray(media?.all) ? media.all.filter(each => record(each)?.type === "video" || record(each)?.type === "gif") : []).flatMap(each => {
    const item = record(each);
    return typeof item?.url === "string" ? [{ url: item.url, gif: item.type === "gif", ...(typeof item.duration === "number" ? { duration: item.duration } : {}) }] : [];
  });
  const embedded: string[] = [...references];
  const articleImages = new Set<string>();
  for (const entity of entities(record(article?.content)?.entityMap).values()) {
    const data = record(entity.data);
    if (entity.type === "TWEET" && typeof data?.tweetId === "string" && /^\d+$/.test(data.tweetId) && !embedded.includes(data.tweetId)) embedded.push(data.tweetId);
    if (entity.type === "MEDIA") {
      for (const each of Array.isArray(data?.mediaItems) ? data.mediaItems : []) {
        const item = record(each);
        if (typeof item?.mediaId === "string") articleImages.add(item.mediaId);
      }
    }
  }
  for (const each of Array.isArray(article?.media_entities) ? article.media_entities : []) {
    const media = record(each);
    const info = record(media?.media_info);
    if (typeof media?.media_id === "string" && articleImages.has(media.media_id) && info?.__typename === "ApiImage" && typeof info.original_img_url === "string" && !images.includes(info.original_img_url)) images.push(info.original_img_url);
  }
  const quoted = depth < 2 ? parseXPost(quote, undefined, depth + 1) : undefined;
  return {
    id,
    url: typeof tweet.url === "string" ? tweet.url : `https://x.com/${handle ?? "i"}/status/${id}`,
    ...(handle === undefined ? {} : { author: handle }),
    ...(typeof author?.id === "string" ? { authorId: author.id } : {}),
    text: fromX(expanded.text ?? tweet.text),
    ...(Number.isFinite(created) ? { at: created } : {}),
    ...(typeof quote?.text === "string" ? { quote: `${String(record(quote.author)?.screen_name ?? "")}: ${quote.text}` } : {}),
    ...(quotedBody === undefined ? {} : { quoteArticle: typeof quotedArticle?.title === "string" ? `${quotedArticle.title}\n\n${quotedBody}` : quotedBody }),
    ...(quoted === undefined ? {} : { quoted }),
    ...(typeof article?.title === "string" ? { title: article.title } : {}),
    ...(body === undefined ? {} : { article: body }),
    ...(links.length === 0 ? {} : { links: links.slice(0, MAX_LINKS) }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(replyingTo === undefined ? {} : { replyingTo }),
    ...(typeof tweet.replies === "number" ? { replies: tweet.replies } : {}),
    ...(typeof tweet.likes === "number" ? { likes: tweet.likes } : {}),
    ...(typeof tweet.views === "number" ? { views: tweet.views } : {}),
    ...(videos.length === 0 ? {} : { videos }),
    ...(images.length === 0 ? {} : { images }),
    ...(embedded.length === 0 ? {} : { embedded }),
  };
}
