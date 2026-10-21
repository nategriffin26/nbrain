// X bookmarks through `xurl` (every post read costs money, so only new bookmarks are read): bookmarks come newest first,
// ten a page, and the read stops at the first one already known, so a page of old bookmarks is never paged through
// again. The first read only records the newest page (the brain starts from now).
// Each new bookmark is hydrated in full (xhydrate.ts: the post, thread and parents, quote, Article, replies, linked pages,
// image descriptions), all from free sources: FxTwitter, page reads, a vision model; `xurl` only lists bookmarks.
import { execFile } from "node:child_process";
import type { Pool } from "pg";
import { cursorOk, insertEvent, readCursor } from "../events/store.js";
import { guarded } from "./common.js";
import { fromX } from "./xpost.js";
import { hydrateBookmark } from "./xhydrate.js";
import { realDeps } from "./xreaders.js";

const SOURCE = "x";
const PAGE = 10;
const XURL = process.env.XURL_BIN ?? "xurl";

const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const xurl = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(XURL, [path], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error === null ? resolve(stdout) : reject(new Error(`xurl failed: ${(stderr || stdout || error.message).slice(0, 240)}`))));
  });

interface Bookmark { id: string; at: number; handle: string; text: string }

async function userId(pool: Pool): Promise<string> {
  const kept = await readCursor(pool, SOURCE);
  if (kept) return (JSON.parse(kept) as { user: string }).user;
  const id = object(object(JSON.parse(await xurl("/2/users/me"))).data).id;
  if (typeof id !== "string") throw new Error("X answered no user id");
  await cursorOk(pool, SOURCE, JSON.stringify({ user: id }));
  return id;
}

const known = async (pool: Pool, id: string) => (await pool.query("SELECT 1 FROM brain.events WHERE source = $1 AND external_id = $2", [SOURCE, id])).rowCount! > 0;

/** Bookmarks newer than the first one `isKnown` recognises (returned too, as `boundary`); `onePage`: read only the newest page. */
async function newBookmarks(user: string, isKnown: (id: string) => Promise<boolean>, onePage: boolean): Promise<{ fresh: Bookmark[]; boundary?: Bookmark }> {
  const fresh: Bookmark[] = [];
  let token: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ max_results: String(PAGE), "tweet.fields": "created_at,author_id,note_tweet", expansions: "author_id", "user.fields": "username", ...(token === undefined ? {} : { pagination_token: token }) });
    const page = object(JSON.parse(await xurl(`/2/users/${encodeURIComponent(user)}/bookmarks?${query}`)));
    const users = new Map((Array.isArray(object(page.includes).users) ? (object(page.includes).users as unknown[]) : []).map(object).map(each => [String(each.id), String(each.username ?? "")]));
    for (const post of (Array.isArray(page.data) ? page.data : []).map(object)) {
      const id = String(post.id);
      const note = object(post.note_tweet).text;
      const at = Date.parse(String(post.created_at));
      const mark = { id, at: Number.isFinite(at) ? at : Date.now(), handle: users.get(String(post.author_id)) ?? "", text: fromX(typeof note === "string" ? note : String(post.text ?? "")) };
      if (await isKnown(id)) return { fresh, boundary: mark };
      fresh.push(mark);
    }
    const next = object(page.meta).next_token;
    if (onePage || typeof next !== "string") return { fresh };
    token = next;
  }
}

const seedEvent = (mark: Bookmark) => ({ kind: "x.bookmark" as const, source: SOURCE, external_id: mark.id, at: Date.now(), title: `@${mark.handle}`, body: mark.text, url: `https://x.com/${mark.handle || "i"}/status/${mark.id}`, data: { seed: true }, route: "drop" as const });

export async function pollX(pool: Pool): Promise<void> {
  await guarded(pool, SOURCE, async () => {
    const user = await userId(pool);
    const first = !(await pool.query("SELECT 1 FROM brain.events WHERE source = $1 LIMIT 1", [SOURCE])).rowCount;
    const { fresh, boundary } = await newBookmarks(user, id => known(pool, id), first);
    // The boundary (or, on the first read, the newest page) marks where the bookmarks are: it is not news.
    if (boundary) await insertEvent(pool, seedEvent(boundary));
    if (first) for (const mark of fresh) await insertEvent(pool, seedEvent(mark));
    else {
      const deps = realDeps();
      // Oldest first, so a failure part-way leaves the newest-until-known read picking up what is still missing.
      for (const mark of fresh.reverse()) {
        // With the bookmark list's own text as the fallback, a post FxTwitter can't read still arrives (as that text).
        const hydrated = await hydrateBookmark(deps, { id: mark.id, handle: mark.handle, text: mark.text, at: mark.at });
        if ("failed" in hydrated) throw new Error(`hydrating ${mark.id}: ${hydrated.failed}`);
        await insertEvent(pool, { kind: "x.bookmark", source: SOURCE, external_id: mark.id, at: Date.now(), title: hydrated.title, body: hydrated.body, url: hydrated.url, data: hydrated.data });
      }
    }
    await cursorOk(pool, SOURCE);
  });
}
