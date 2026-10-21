import { describe, expect, it } from "vitest";
import { demote, HYDRATION_VERSION, type HydrateDeps, hydrateBookmark, linkKey, type PageResult, replyTree, selectReplies } from "./xhydrate.js";
import type { XPost } from "./xpost.js";

const post = (id: string, over: Partial<XPost> = {}): XPost => ({ id, url: `https://x.com/a/status/${id}`, author: "a", authorId: "1", text: `post ${id} with some words`, ...over });

describe("selectReplies", () => {
  const focal = post("100");
  it("keeps the author's and liked replies, drops summons, one-word and link-only posts", () => {
    const replies = [
      post("101", { author: "b", authorId: "2", text: "@a @bot set this up for me please", likes: 5 }),
      post("102", { author: "c", authorId: "3", text: "@a nice", likes: 9 }),
      post("103", { author: "d", authorId: "4", text: "@a https://example.com/x", likes: 9 }),
      post("104", { author: "e", authorId: "5", text: "@a this is the part that matters: the cache key includes the tenant", likes: 3 }),
      post("105", { author: "a", authorId: "1", text: "@e right, and that is why the fix is small" }),
      post("106", { author: "f", authorId: "6", text: "@a no reaction to this one at all, and nothing more to say" }),
    ];
    const chosen = selectReplies(replies, focal, new Set()).map(each => each.id);
    expect(chosen).toEqual(["105", "104"]);
  });

  it("falls back to the longest few when nobody reacted", () => {
    const replies = ["a", "b", "c", "d"].map((letter, index) => post(`20${index}`, { author: letter, authorId: letter, text: `@a ${"word ".repeat(20 + index * 5)}` }));
    expect(selectReplies(replies, focal, new Set())).toHaveLength(3);
  });
});

describe("replyTree", () => {
  it("shows a reply under the reply it answers, pulling the parent in", () => {
    const focal = post("100");
    const parent = post("101", { author: "b", authorId: "2", text: "@a a question about the cache key", parentId: "100", likes: 1 });
    const answer = post("102", { author: "a", authorId: "1", text: "@b it includes the tenant", parentId: "101" });
    const other = post("103", { author: "c", authorId: "3", text: "@a a separate remark worth keeping", parentId: "100", likes: 8 });
    const tree = replyTree([other, answer], [parent, answer, other], focal);
    expect(tree.count).toBe(3);
    expect(tree.text).toBe(["- **@c** (8 likes): a separate remark worth keeping", "- **@b** (1 like): a question about the cache key", "  - **@a**: it includes the tenant"].join("\n"));
  });
});

describe("demote and linkKey", () => {
  it("moves headings down but leaves fenced code alone", () => {
    expect(demote("# Title\ntext\n```sh\n# comment\n```\n## Sub", 2)).toBe("### Title\ntext\n```sh\n# comment\n```\n#### Sub");
  });
  it("compares links without tracking, fragments, www or a trailing slash", () => {
    expect(linkKey("https://www.example.com/a/?utm_source=x&id=1#top")).toBe(linkKey("https://example.com/a?id=1"));
    expect(linkKey("mailto:a@b.c")).toBeUndefined();
  });
});

type Tweet = Record<string, unknown>;
const tweet = (id: string, over: Tweet = {}): Tweet => ({ id, text: `text ${id}`, author: { screen_name: "a", id: "1" }, created_timestamp: 1_700_000_000, replies: 0, likes: 3, ...over });

function world(options: { tweets: Record<string, Tweet>; thread?: Record<string, Tweet[]>; replies?: Record<string, Tweet[]>; pages?: Record<string, PageResult>; failImages?: boolean }): HydrateDeps & { asked: string[] } {
  const asked: string[] = [];
  const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
  return {
    asked,
    fetch: async input => {
      const url = String(input);
      asked.push(url);
      const status = /\/i\/status\/(\d+)$/.exec(url)?.[1];
      if (status !== undefined) return options.tweets[status] === undefined ? json({}, 404) : json({ tweet: options.tweets[status] });
      const thread = /\/2\/thread\/(\d+)$/.exec(url)?.[1];
      if (thread !== undefined) return json({ thread: options.thread?.[thread] ?? [] });
      const conversation = /\/2\/conversation\/(\d+)$/.exec(url)?.[1];
      if (conversation !== undefined) return json({ replies: options.replies?.[conversation] ?? [] });
      return json({}, 404);
    },
    readPages: async urls => new Map(urls.map(url => [url, options.pages?.[url] ?? { error: "not in the test world", transient: false }])),
    describeImage: async url => { if (options.failImages) throw new Error("gateway down"); return `a chart at ${url}`; },
  };
}

describe("hydrateBookmark", () => {
  it("builds one document from a reply: parents above, replies, linked page, image, and a content hash", async () => {
    const root = tweet("10", { text: "the question", replies: 2 });
    const parent = tweet("11", { text: "@a an answer", author: { screen_name: "b", id: "2" }, replying_to: { screen_name: "a", status: "10" }, replies: 1 });
    const bookmarked = tweet("12", {
      text: "the part worth saving https://t.co/x",
      raw_text: { text: "the part worth saving https://t.co/x", facets: [{ type: "url", original: "https://t.co/x", replacement: "https://blog.example/post", indices: [23, 37] }] },
      replying_to: { screen_name: "b", status: "11" },
      replies: 1,
      media: { photos: [{ url: "https://pbs.twimg.com/media/abcde.jpg?name=orig" }] },
    });
    const reply = tweet("13", { text: "@a this is the reaction that matters most", author: { screen_name: "c", id: "3" }, likes: 7, replying_to: { screen_name: "a", status: "12" } });
    const deps = world({
      tweets: { "12": bookmarked },
      thread: { "12": [root, parent, bookmarked] },
      replies: { "12": [reply] },
      pages: { "https://blog.example/post": { title: "The post", text: "# Heading\n\nBody of the linked page." } },
    });
    const result = await hydrateBookmark(deps, { id: "12" });
    if ("failed" in result) throw new Error(result.failed);
    expect(result.body).toContain("## Conversation above the post");
    expect(result.body.indexOf("## Post")).toBeLessThan(result.body.indexOf("## Conversation above the post"));
    expect(result.body.indexOf("the question")).toBeLessThan(result.body.indexOf("an answer"));
    expect(result.body).toContain("**@c** (7 likes): this is the reaction that matters most");
    expect(result.body).toContain("### The post — https://blog.example/post");
    expect(result.body).toContain("#### Heading");
    expect(result.body).toContain("[Image] a chart at https://pbs.twimg.com/media/abcde.jpg?name=orig");
    expect(result.data).toMatchObject({ author: "a", links: ["https://blog.example/post"], hydration: { v: HYDRATION_VERSION, parts: { parents: 2, replies: 1, links_ok: 1, images: 1 } } });
    expect((result.data.hydration as { sha: string }).sha).toMatch(/^[0-9a-f]{64}$/);
    expect((result.data.hydration as { incomplete?: string[] }).incomplete).toBeUndefined();
  });

  it("marks what it could not read so a later run can retry it", async () => {
    const bookmarked = tweet("20", { text: "see https://t.co/y", raw_text: { text: "see https://t.co/y", facets: [{ type: "url", original: "https://t.co/y", replacement: "https://slow.example/", indices: [4, 18] }] }, media: { photos: [{ url: "https://pbs.twimg.com/media/zzzzz.jpg" }] } });
    const deps = world({ tweets: { "20": bookmarked }, pages: { "https://slow.example/": { error: "rate limited", transient: true } }, failImages: true });
    const result = await hydrateBookmark(deps, { id: "20" });
    if ("failed" in result) throw new Error(result.failed);
    expect(result.body).toContain("(Couldn't read this page: rate limited)");
    expect(result.body).toContain("(not described: gateway down)");
    expect((result.data.hydration as { incomplete: string[] }).incomplete).toEqual(["image:https://pbs.twimg.com/media/zzzzz.jpg", "link:https://slow.example/"]);
  });

  it("says gone for a deleted post and falls back to the list's text when given one", async () => {
    const deps = world({ tweets: {} });
    expect(await hydrateBookmark(deps, { id: "30" })).toEqual({ failed: "post unavailable (deleted or private)", gone: true });
    const fallback = await hydrateBookmark(deps, { id: "30", handle: "z", text: "what the list said" });
    if ("failed" in fallback) throw new Error(fallback.failed);
    expect(fallback.body).toContain("what the list said");
    expect((fallback.data.hydration as { incomplete: string[] }).incomplete).toEqual(["post"]);
  });
});
