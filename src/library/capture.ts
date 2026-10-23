// Captures of design references: how a reference card's page looks and moves, kept under $BRAIN_HOME/captures because
// pages change and disappear. A full-page screenshot (PNG) and the page as one MHTML archive; a ~10 s WebM recording when
// something moves on load (a playing video in view, or a visible share of the screen changing within a second). The
// installed Google Chrome runs headless in a fresh, throwaway profile per page.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { BRAIN_HOME } from "../config.js";
import { sha256 } from "../memory/text.js";

const VIEWPORT = { width: 1440, height: 900 };
const LOAD_TIMEOUT = 45_000;
const IDLE_TIMEOUT = 10_000;
const SHOT_TIMEOUT = 90_000;
const RECORD_MS = 10_000;
/** Chrome draws nothing past about 16K pixels in one capture; longer pages are cut there. */
const MAX_HEIGHT = 16_000;
/** Share of the viewport's pixels that must change within a second for the page to count as moving. */
const MOTION_SHARE = 0.005;
/** A playing video counts when it covers this share of the viewport (not a thumbnail or an icon). */
const VIDEO_SHARE = 0.05;
/** Hosts whose pages are not the reference itself: a post, a video player, a short link. */
const NOT_PAGES = /^(?:(?:www\.|mobile\.)?(?:x|twitter)\.com|t\.co|(?:www\.|m\.)?youtube\.com|youtu\.be)$/;
const MEDIA = /\.(?:pdf|png|jpe?g|gif|webp|svg|mp4|mov|webm|zip)$/i;

export interface Capture { screenshot?: string; archive?: string; recording?: string; none?: string; failed?: string }

/** Whether a card gets captures: a reference whose url is a web page. */
export function capturable(card: { kind: string; url?: string | null }): boolean {
  if (card.kind !== "reference" || !card.url) return false;
  let url: URL;
  try { url = new URL(card.url); } catch { return false; }
  return (url.protocol === "https:" || url.protocol === "http:") && !NOT_PAGES.test(url.hostname) && !MEDIA.test(url.pathname);
}

/** Motion that matters: a playing video big enough to be the point, or enough of the screen changing on its own. */
export const moves = (seen: { videos: number; changed: number }) => seen.videos > 0 || seen.changed >= MOTION_SHARE;

// In-page code, as source text: a function passed to page.evaluate is serialized, and tsx's transform leaves helper calls
// (__name) in it that the page does not have.
const PLAYING_VIDEOS = `[...document.querySelectorAll("video")].filter(video => {
  const box = video.getBoundingClientRect();
  return !video.paused && video.readyState > 2 && box.bottom > 0 && box.top < innerHeight && box.width * box.height >= ${VIDEO_SHARE} * innerWidth * innerHeight;
}).length`;
const CHANGED_SHARE = `async ([a, b]) => {
  const pixels = async png => {
    const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    canvas.drawImage(bitmap, 0, 0);
    return canvas.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const [x, y] = await Promise.all([pixels(a), pixels(b)]);
  if (x.length !== y.length) return 1;
  let changed = 0;
  for (let at = 0; at < x.length; at += 4) if (Math.abs(x[at] - y[at]) + Math.abs(x[at + 1] - y[at + 1]) + Math.abs(x[at + 2] - y[at + 2]) > 24) changed++;
  return changed / (x.length / 4);
}`;
// lazy images and scroll-triggered sections load only once scrolled into view
const SCROLL_THROUGH = `(async () => {
  for (let y = 0; y < Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT}); y += innerHeight) {
    scrollTo(0, y);
    await new Promise(done => setTimeout(done, 250));
  }
  scrollTo(0, 0);
  return document.documentElement.scrollHeight;
})()`;

async function open(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT }).catch(() => { /* pages that keep polling never go idle */ });
  return page;
}

/** Does the page move on load? Two viewport frames a second apart, compared in a blank page of the same browser. */
async function seenMoving(context: BrowserContext, page: Page): Promise<boolean> {
  const first = await page.screenshot();
  await page.waitForTimeout(1000);
  const second = await page.screenshot();
  const videos = await page.evaluate<number>(PLAYING_VIDEOS);
  if (first.equals(second)) return moves({ videos, changed: 0 });
  const blank = await context.newPage();
  // a string passed to evaluate is an expression, never called with an argument: the frames go in the call itself
  try { return moves({ videos, changed: await blank.evaluate<number>(`(${CHANGED_SHARE})(${JSON.stringify([first.toString("base64"), second.toString("base64")])})`) }); }
  finally { await blank.close(); }
}

/** Screenshot, archive and (when it moves) recording of `url`, written under $BRAIN_HOME as captures/<year>/<name>.*; answers their paths there. */
export async function capturePage(browser: Browser, url: string, name: string, now = new Date()): Promise<Capture> {
  const base = join("captures", String(now.getUTCFullYear()), name);
  await mkdir(dirname(join(BRAIN_HOME, base)), { recursive: true });
  const capture: Capture = {};
  const context = await browser.newContext({ viewport: VIEWPORT });
  let moving: boolean;
  try {
    const page = await open(context, url);
    moving = await seenMoving(context, page);
    const height = await page.evaluate<number>(SCROLL_THROUGH);
    await page.waitForTimeout(1000);
    // a long page of live canvases takes a while to draw whole
    await page.screenshot({ path: join(BRAIN_HOME, `${base}.png`), fullPage: true, timeout: SHOT_TIMEOUT, ...(height > MAX_HEIGHT ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_HEIGHT } } : {}) });
    capture.screenshot = `${base}.png`;
    const { data } = await (await context.newCDPSession(page)).send("Page.captureSnapshot", { format: "mhtml" });
    await writeFile(join(BRAIN_HOME, `${base}.mhtml`), data);
    capture.archive = `${base}.mhtml`;
  } finally { await context.close(); }
  if (!moving) return capture;
  // recording starts with the context, so the page is loaded again in one that records
  const recording = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: tmpdir(), size: VIEWPORT } });
  const page = await recording.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(RECORD_MS);
  } finally { await recording.close(); }
  const video = page.video()!;
  await video.saveAs(join(BRAIN_HOME, `${base}.webm`));
  await video.delete();
  capture.recording = `${base}.webm`;
  return capture;
}

/** Captures for reference cards that have none, newest first, one page at a time until `deadline` (epoch ms). A card
 *  that is not a web page, or whose page failed, is marked so it is not tried again. With no Chrome to launch the run
 *  stops, logged once, and leaves the cards for a run that has one. Answers how many were captured. */
export async function captureCards(pool: Pool, deadline: number): Promise<number> {
  let browser: Browser | undefined;
  let captured = 0;
  try {
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ id: string; kind: string; url: string | null }>(
        `SELECT c.id, c.kind, coalesce(c.url, i.url) AS url FROM memory.cards c JOIN memory.items i ON i.id = c.item_id
         WHERE c.kind = 'reference' AND c.capture = '{}' AND NOT EXISTS (SELECT 1 FROM memory.private p WHERE p.target = i.id OR p.target = 'thread:' || i.source || ':' || i.thread)
         ORDER BY c.at DESC LIMIT 1`);
      const card = rows[0];
      if (!card) break;
      let capture: Capture;
      if (!capturable(card)) capture = { none: "not a web page" };
      else {
        if (!browser) {
          try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
          catch (error) {
            console.error(`${new Date().toISOString()} library capture: no browser, nothing captured this run:`, error instanceof Error ? error.message.split("\n")[0] : error);
            break;
          }
        }
        try { capture = await capturePage(browser, card.url!, `card-${sha256(card.id).slice(0, 16)}`); captured++; }
        catch (error) {
          console.error(`${new Date().toISOString()} library capture ${card.id}:`, error instanceof Error ? error.message : error);
          capture = { failed: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
        }
      }
      await pool.query("UPDATE memory.cards SET capture = $2::jsonb, updated_at = now() WHERE id = $1", [card.id, JSON.stringify(capture)]);
    }
  } finally { await browser?.close(); }
  return captured;
}
