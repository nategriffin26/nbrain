import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { readCursor } from "./events/store.js";
import { freshDatabase } from "./testdb.js";
import { recallLine, rerankerLine, weeklyTick } from "./weekly.js";

vi.hoisted(() => {
  process.env.BRAIN_HOME = "/tmp/nbrain-fixes/home-weekly";
  process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/home-weekly/context";
  delete process.env.BRAIN_NOTIFY;
});

afterEach(() => { delete process.env.RERANK_URL; });

/** A reranker on a free port answering every call with `status` and `body`. */
async function reranker(status: number, body: unknown): Promise<Server> {
  const server = createServer((_request, response) => { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); });
  await once(server.listen(0, "127.0.0.1"), "listening");
  process.env.RERANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return server;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await once(server.close(), "close");
}

it("bug: a dead reranker went unnoticed (search quietly falls back to fused rank); the checkup says so", async () => {
  let server = await reranker(200, { results: [{ index: 0, relevance_score: 0.5 }] });
  expect(await rerankerLine()).toBe("- Reranker answered.");
  await stop(server);
  server = await reranker(503, { error: "loading model" });
  expect(await rerankerLine()).toMatch(/^- Reranker did not answer \(503 .*\): search is running without it\.$/);
  await stop(server);
  server = await reranker(200, { results: [] });
  expect(await rerankerLine()).toBe("- Reranker did not answer (no scores): search is running without it.");
  await stop(server);
  // nothing listens on the port any more
  expect(await rerankerLine()).toBe("- Reranker did not answer (ECONNREFUSED): search is running without it.");
  delete process.env.RERANK_URL;
  expect(await rerankerLine()).toBe("- No reranker set (RERANK_URL): search is running without it.");
});

it("bug: the score line had no place for questions with no answer; it gives both numbers, and only recall for older runs", async () => {
  const dir = `${process.env.BRAIN_HOME}/eval`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/recall-2026-10-18-09-00.json`, JSON.stringify({ summary: { ok: 124, n: 172 } }));
  expect(await recallLine()).toBe("- Recall: 124 of 172 found on Sun, Oct 18.");
  writeFileSync(`${dir}/recall-2026-10-25-09-00.json`, JSON.stringify({ summary: { ok: 128, n: 172, abstain: { ok: 18, n: 19 } } }));
  expect(await recallLine()).toBe("- Recall: 128 of 172 found on Sun, Oct 25, 124 of 172 the week before. 18 of 19 questions with no answer got nothing strong.");
});

it.runIf(!!process.env.TEST_DATABASE_URL)("bug: with BRAIN_NOTIFY unset the Sunday tick threw every time and never marked the week; it logs the message once and marks it", async () => {
  const { pool } = await freshDatabase("weekly");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const sunday = new Date("2026-10-25T15:00:00Z"); // 10:00 in Chicago
    expect(await weeklyTick(pool, sunday)).toBe(true);
    expect(await weeklyTick(pool, new Date(sunday.getTime() + 600_000))).toBe(false);
    expect(log.mock.calls.filter(call => String(call[0]).includes("Your brain this week"))).toHaveLength(1);
    expect(await readCursor(pool, "weekly")).toBe("2026-10-25");
  } finally {
    log.mockRestore();
    await pool.end();
  }
}, 60_000);
