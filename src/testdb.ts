// Postgres for tests: TEST_DATABASE_URL names a database starting nbrain_t_ on a throwaway cluster. Roles are
// cluster-wide and schema.sql grants and revokes memory_writer's, so a cluster that holds any other database is refused.
// Each caller gets its own fresh database, <that name>_<name>, built from schema.sql.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { prepareReader } from "./memory/records.js";

export const schemaSql = () => readFile(new URL("./memory/schema.sql", import.meta.url), "utf8");

export async function freshDatabase(name: string): Promise<{ pool: pg.Pool; url: string }> {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  if (!url.pathname.startsWith("/nbrain_t_")) throw new Error("TEST_DATABASE_URL must name a throwaway nbrain_t_ database.");
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  // test files run side by side, and two of them creating the cluster-wide roles at once collide: one setup at a time
  await admin.query("SELECT pg_advisory_lock(hashtext('nbrain test setup'))");
  try {
    const { rows } = await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' AND datname NOT LIKE 'nbrain_t_%'");
    if (rows.length) throw new Error(`Roles are cluster-wide: run these tests on a throwaway cluster (this one holds ${rows.length} other databases).`);
    const db = `${url.pathname.slice(1)}_${name}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    url.pathname = `/${db}`;
    const pool = new pg.Pool({ connectionString: url.href });
    await pool.query(await schemaSql());
    await prepareReader(pool);
    return { pool, url: url.href };
  } finally {
    await admin.end();
  }
}
