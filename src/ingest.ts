// The brain's one ingest process. Connectors read their sources into brain.events (Gmail, iMessage and Calendar through
// Executor, X bookmarks through xurl; only those named in CONNECTORS run); memory_events indexes events into
// memory.items/chunks; records and notes consolidation (and the profile refresh) follow. Each loop runs on its own
// schedule and never overlaps itself; a failed run is logged and tried again at the next tick (connectors also record
// the failure on their brain.cursors row).
import { readFile } from "node:fs/promises";
import pg from "pg";
import { pollCalendar } from "./connectors/calendar.js";
import { pollGmail } from "./connectors/gmail.js";
import { pollMessages } from "./connectors/messages.js";
import { pollOmp } from "./connectors/omp.js";
import { pollX } from "./connectors/x.js";
import { enrichCaptures } from "./capture/enrich.js";
import { gardenNightly } from "./garden.js";
import { indexEvents } from "./memory/events.js";
import { consolidate, refreshProfile } from "./memory/notes.js";
import { extractRecords, prepareReader } from "./memory/records.js";
import { indexSkills } from "./skills/indexer.js";
import { slots } from "./time.js";

const MINUTE = 60_000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
pool.on("error", error => console.error("pool:", error.message));
await pool.query(await readFile(new URL("./memory/schema.sql", import.meta.url), "utf8"));
await prepareReader(pool);

interface Loop { name: string; every: number; run: () => Promise<unknown> }

/** X bookmarks cost per post read: twice a day (checked each minute, read once per slot). */
const xDue = slots(["06:45", "17:45"]);
/** The gardener writes yesterday's journal and context edits once a night, after the day's notes have settled. */
const gardenDue = slots(["03:30"]);
const connectors = new Set((process.env.CONNECTORS ?? "").split(",").map(name => name.trim()).filter(Boolean));

const LOOPS: Loop[] = [
  // mail and texts every minute: memory_events indexes what they write a minute later, so a new text is searchable within ~2 minutes
  { name: "gmail", every: MINUTE, run: () => pollGmail(pool) },
  { name: "imessage", every: MINUTE, run: () => pollMessages(pool) },
  { name: "calendar", every: 5 * MINUTE, run: () => pollCalendar(pool) },
  { name: "x", every: MINUTE, run: async () => { if (xDue()) await pollX(pool); } },
  { name: "omp", every: 5 * MINUTE, run: () => pollOmp(pool) },
].filter(loop => connectors.has(loop.name));
LOOPS.push(
  { name: "memory_events", every: MINUTE, run: () => indexEvents(pool) },
  { name: "memory_records", every: MINUTE, run: () => extractRecords(pool, Date.now() + 4 * MINUTE) },
  { name: "capture_enrich", every: MINUTE, run: () => enrichCaptures(pool) },
  // notes from what was said since the last run (a conversation settles over minutes), then the profile if they changed
  { name: "memory_notes", every: 5 * MINUTE, run: async () => { if (await consolidate(pool)) await refreshProfile(pool); } },
  { name: "garden", every: MINUTE, run: async () => { if (gardenDue()) await gardenNightly(pool); } },
  // skills and styles saved in the context repo (or edited by hand), searchable within a minute
  { name: "memory_skills", every: MINUTE, run: () => indexSkills(pool) },
);

const timers: NodeJS.Timeout[] = [];
let stopping = false;
const running = new Set<Promise<void>>();

function schedule(loop: Loop, delay: number): void {
  timers.push(setTimeout(() => {
    if (stopping) return;
    const started = Date.now();
    const job = loop.run().then(
      () => undefined,
      (error: unknown) => console.error(`${new Date().toISOString()} ${loop.name}:`, error instanceof Error ? error.message : error),
    ).finally(() => {
      running.delete(job);
      const ms = Date.now() - started;
      if (ms > loop.every) console.warn(`${new Date().toISOString()} ${loop.name}: took ${Math.round(ms / 1000)}s`);
      schedule(loop, Math.max(1000, loop.every - ms));
    });
    running.add(job);
  }, delay));
}

// Stagger the first runs so the connectors' Executor calls do not all land at once.
LOOPS.forEach((loop, index) => schedule(loop, 1000 + index * 2000));
console.info(`${new Date().toISOString()} brain ingest: ${LOOPS.map(loop => loop.name).join(", ")}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    // let runs in flight finish (launchd gives 20 s before SIGKILL), then close
    const grace = Promise.withResolvers<void>();
    setTimeout(grace.resolve, 15_000);
    void Promise.race([Promise.allSettled([...running]), grace.promise]).then(() => pool.end()).then(() => process.exit(0));
  });
}
