// memory_skills: every skill, style and built-in as one memory item (source `skill`), so memory_search and context_get
// find the one that fits a task. The item's body is the description plus the whole SKILL.md body: retrieval over name and
// description alone misses (SkillRouter: BM25 on them scored 0 Hit@1, 34.7% with the body; arxiv.org/html/2603.22455v1).
import type { Pool } from "pg";
import { stat } from "node:fs/promises";
import { type ItemInput, writeItems } from "../memory/store.js";
import { catalog, firstSentence, getSkill } from "./library.js";

/** Index every skill on disk and drop the items of skills that are gone; answers how many items were written. */
export async function indexSkills(pool: Pool): Promise<number> {
  const { skills } = await catalog();
  const items = await Promise.all(skills.map(async ({ path }): Promise<ItemInput> => {
    const { entry, body, files } = await getSkill(path);
    const updated = entry.updated ? new Date(entry.updated) : undefined;
    const at = updated && !Number.isNaN(updated.getTime()) ? updated : (await stat(`${entry.dir}/SKILL.md`)).mtime;
    return {
      id: `skill:${path}`, source: "skill", kind: entry.kind, ext_id: path, title: `${entry.name}: ${firstSentence(entry.description)}`, at,
      sender: entry.author ?? null, url: entry.uri, body: `${entry.description}\n\n${body.trim()}`, origin: "skill",
      meta: { kind: entry.kind, default: entry.default, uri: entry.uri, digest: files.find(file => file.path === "SKILL.md")!.digest, files: files.length },
    };
  }));
  const written = await writeItems(pool, items);
  // writeItems keys on what is searched; a changed supporting file changes only meta
  await pool.query("UPDATE memory.items i SET meta = x.meta FROM jsonb_to_recordset($1) AS x(id text, meta jsonb) WHERE i.id = x.id AND i.meta IS DISTINCT FROM x.meta",
    [JSON.stringify(items.map(item => ({ id: item.id, meta: item.meta })))]);
  await pool.query("DELETE FROM memory.items WHERE source = 'skill' AND origin = 'skill' AND NOT (id = ANY($1))", [items.map(item => item.id)]);
  return written;
}
