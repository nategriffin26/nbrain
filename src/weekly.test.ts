import { expect, it, vi } from "vitest";
import { readCursor } from "./events/store.js";
import { freshDatabase } from "./testdb.js";
import { weeklyTick } from "./weekly.js";

vi.hoisted(() => {
  process.env.BRAIN_HOME = "/tmp/nbrain-fixes/home-weekly";
  process.env.BRAIN_CONTEXT = "/tmp/nbrain-fixes/home-weekly/context";
  delete process.env.BRAIN_NOTIFY;
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
