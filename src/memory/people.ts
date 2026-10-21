// Person pages: who someone is to the owner (relationship, other names, phones, emails, birthday), what memory knows
// about them, their records, and the last threads with them (memory_person and context://people/{name}).
import type { Pool } from "pg";
import { OWNER, ZONE } from "../config.js";

const FACTS = 6;
const RECORDS = 5;
const RECENT = 5;
const FACT_CHARS = 220;
const SNIPPET_CHARS = 140;

interface PersonRow { id: string; kind: string; name: string; aliases: string[]; handles: string[]; relationship: string | null; meta: { birthday?: { day: number; month: number } } }

const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ZONE });
const clip = (value: string, chars: number) => { const flat = value.replace(/\s+/g, " ").trim(); return flat.length > chars ? `${flat.slice(0, chars).trimEnd()}…` : flat; };
const money = (amount: string | null) => (amount === null ? "" : ` $${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Lowercased names and aliases only this person goes by: a record's org "James" belongs to neither of two Jameses. */
async function ownNames(pool: Pool, person: PersonRow): Promise<string[]> {
  const names = [...new Set([person.name, ...person.aliases].map(name => name.toLowerCase()))];
  const { rows } = await pool.query<{ name: string }>(
    "SELECT DISTINCT lower(n) AS name FROM memory.people o, jsonb_array_elements_text(o.aliases || to_jsonb(o.name)) n WHERE o.id <> $1 AND lower(n) = ANY($2)", [person.id, names]);
  const shared = new Set(rows.map(row => row.name));
  return names.filter(name => !shared.has(name));
}

/** The page of one person or organisation; undefined when memory has no such id. */
export async function personPage(pool: Pool, id: string): Promise<string | undefined> {
  const { rows: [person] } = await pool.query<PersonRow>("SELECT id, kind, name, aliases, handles, relationship, meta FROM memory.people WHERE id = $1", [id]);
  if (!person) return undefined;
  const [facts, records, recent] = await Promise.all([
    pool.query<{ id: string; at: string; body: string }>(
      `SELECT i.id, i.at, i.body FROM memory.items i JOIN memory.item_people p ON p.item_id = i.id WHERE p.person_id = $1 AND i.source IN ('memory', 'note') ORDER BY i.at DESC LIMIT ${FACTS}`, [id]),
    pool.query<{ id: string; at: string; type: string; org: string | null; title: string; amount: string | null; status: string | null; ref: string | null; due_at: string | null; start_at: string | null }>(
      `SELECT r.id, r.at, r.type, r.org, r.title, r.amount, r.status, r.ref, r.due_at, r.start_at FROM memory.records r
       WHERE r.superseded_by IS NULL AND r.type IN ('bill', 'payment', 'order', 'appointment') AND (r.people ? $1 OR lower(r.org) = ANY($2) OR EXISTS (SELECT 1 FROM memory.item_people p WHERE p.item_id = r.item_id AND p.person_id = $1 AND p.role = 'sender'))
       ORDER BY r.at DESC LIMIT ${RECORDS}`, [id, await ownNames(pool, person)]),
    // what they sent, and what the owner sent them
    pool.query<{ id: string; at: string; source: string; title: string; from_me: boolean; body: string }>(
      `SELECT i.id, i.at, i.source, i.title, i.from_me, left(i.body, 400) AS body
       FROM memory.items i WHERE i.source IN ('imessage', 'gmail') AND EXISTS (SELECT 1 FROM memory.item_people p WHERE p.item_id = i.id AND p.person_id = $1 AND p.role = CASE WHEN i.from_me THEN 'recipient' ELSE 'sender' END)
       ORDER BY i.at DESC LIMIT ${RECENT}`, [id]),
  ]);
  const phones = person.handles.filter(handle => handle.startsWith("+"));
  const emails = person.handles.filter(handle => handle.includes("@"));
  const others = person.aliases.filter(alias => alias.toLowerCase() !== person.name.toLowerCase());
  const birthday = person.meta.birthday ? `${new Date(2000, person.meta.birthday.month - 1, person.meta.birthday.day).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : undefined;
  const lines = [
    `${person.name === person.name.toLowerCase() ? person.name.replace(/(^|\s)\S/g, letter => letter.toUpperCase()) : person.name} (${person.id})${person.relationship ? `, ${OWNER.name}'s ${person.relationship}` : ""}${person.kind === "org" ? ", an organisation" : ""}`,
    others.length > 0 ? `Also called: ${others.join(", ")}` : "",
    phones.length > 0 ? `Phones: ${phones.join(", ")}` : "",
    emails.length > 0 ? `Emails: ${emails.join(", ")}` : "",
    birthday ? `Birthday: ${birthday}` : "",
    ...(facts.rows.length > 0 ? ["Known:", ...facts.rows.map(row => `- ${clip(row.body, FACT_CHARS)} (${day(row.at)}, ${row.id})`)] : []),
    ...(records.rows.length > 0 ? ["Records:", ...records.rows.map(row => `- ${day(row.at)} ${row.type}${money(row.amount)}: ${clip(row.title, 80)}${row.org && !row.title.includes(row.org) ? ` · ${row.org}` : ""}${row.ref ? ` #${row.ref}` : ""}${row.status ? ` (${row.status})` : ""}${row.start_at ? `, on ${day(row.start_at)}` : row.due_at ? `, due ${day(row.due_at)}` : ""} (${row.id})`)] : []),
    ...(recent.rows.length > 0 ? ["Latest with them:", ...recent.rows.map(row => `- ${day(row.at)} ${row.source === "gmail" ? "mail" : "text"} ${row.from_me ? `from ${OWNER.name}` : "from them"}: ${clip(row.title ? `${row.title} — ${row.body}` : row.body, SNIPPET_CHARS)} (${row.id})`)] : []),
  ];
  return lines.filter(Boolean).join("\n");
}
