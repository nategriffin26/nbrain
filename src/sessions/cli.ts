import { readFile } from "node:fs/promises";
import pg from "pg";
import { SESSION_ARCHIVE } from "../config.js";
import { prepareReader } from "../memory/records.js";
import { ingestSessions } from "./store.js";

export async function sessionIngestCommand(args: string[]): Promise<void> {
  if (args.length) throw new Error("usage: nbrain session-ingest");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  try {
    await pool.query(await readFile(new URL("../memory/schema.sql", import.meta.url), "utf8"));
    await prepareReader(pool);
    const count = await ingestSessions(pool, { ...SESSION_ARCHIVE, drossPool: pool });
    console.log(JSON.stringify({ projected: count }));
  } finally { await pool.end(); }
}
