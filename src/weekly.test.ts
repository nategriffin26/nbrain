import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { readCursor } from "./events/store.js";
import { clef, embedding, fakeModels, notPulled, refused, restoreFetch, serverError } from "./testai.js";
import { freshDatabase } from "./testdb.js";
import { modelsLine, recallLine, weeklyTick } from "./weekly.js";

vi.hoisted(() => {
  process.env.BRAIN_HOME = "/tmp/nbrain-fixes/home-weekly";
  process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/home-weekly/context";
  delete process.env.BRAIN_NOTIFY;
});

afterEach(restoreFetch);

const unit = Array.from({ length: 1024 }, (_, dim) => dim === 0 ? 1 : 0);

it("bug: a dead judge went unnoticed (search quietly falls back to fused rank), and so would dead embeddings; the checkup says which", async () => {
  fakeModels(({ model, body }) => model === "@cf/cloudflare/clef" ? clef({ r1: 0.2 }) : embedding(body.text!, () => unit));
  expect(await modelsLine()).toBe("- Search judge and embeddings answered.");
  fakeModels(({ model, body }) => model === "@cf/cloudflare/clef" ? [500, serverError] : embedding(body.text!, () => unit));
  expect(await modelsLine()).toMatch(/^- Search judge did not answer \(@cf\/cloudflare\/clef 500 .*\): search is running without it\.$/);
  // an answer without the asked-for probability judges nothing
  fakeModels(({ model, body }) => model === "@cf/cloudflare/clef" ? clef({}) : embedding(body.text!, () => unit));
  expect(await modelsLine()).toBe("- Search judge did not answer (clef: no answer for result 1): search is running without it.");
  fakeModels(({ model }) => model === "@cf/cloudflare/clef" ? clef({ r1: 0.2 }) : notPulled);
  expect(await modelsLine()).toMatch(/^- Ollama's embeddings did not answer \(Ollama embed: 404 .*\): search is running without meaning, and nothing new is indexed\.$/);
  fakeModels(({ model }) => model === "@cf/cloudflare/clef" ? clef({ r1: 0.2 }) : refused);
  expect(await modelsLine()).toBe("- Ollama's embeddings did not answer (ECONNREFUSED): search is running without meaning, and nothing new is indexed.");
  restoreFetch();
  fakeModels(({ body }) => embedding(body.text!, () => unit));
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  expect(await modelsLine()).toBe("- Search judge did not answer (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN not set): search is running without it.");
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
