// The memory tools' public contract (names, descriptions, inputs) every connected agent sees. Names and inputs must not
// change: bots in the cloud call them by name.
import * as z from "zod";
import { OWNER, ZONE } from "../config.js";

const O = OWNER.name;

export const MCP_TOOLS = {
  memory_search: {
    description:
      `Search everything ${O}'s life touched, verbatim: texts, mail (receipts too), records, calendar, bookmarks and their articles, saved pages, chats with ${OWNER.their} bots, coding sessions, notes, skills. Dates and people in the query are understood ("what did Mom text last week"). Filters: person (name, alias or handle), source (imessage, gmail, x, calendar, record, chat, omp, saved, skill, memory, note, wiki), from/to (YYYY-MM-DD or ISO).`,
    input: z.object({
      query: z.string(),
      person: z.string().optional(),
      source: z.array(z.string()).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().optional().describe("Hits, default 10, at most 30"),
    }),
  },
  memory_read: {
    description: "Open one memory item by id (or <id>#<chunk> from a hit): its full text in pages of 8 KB, who is on it, and the neighbouring messages of its thread.",
    input: z.object({ id: z.string(), page: z.number().optional() }),
  },
  memory_query: {
    description:
      `Answer who / how many / how much / latest by SQL over ${O}'s memory (Postgres, read-only, schema memory, times in ${ZONE}, 100 rows). Use it to count, sum, list or pick the latest; use memory_search to find what was said. ` +
      `records: bills, payments, receipts, orders and appointments read out of ${OWNER.their} mail, texts and calendar (id, item_id, type bill|payment|order|appointment|commitment|request|plan|family_date, org, title, amount, currency, due_at, paid_at (a payment's day, an order's day), start_at, end_at, status, ref, at, superseded_by); a record with superseded_by set was replaced by a later one, so filter \`superseded_by is null\`. ` +
      "items: every text, mail, post, calendar event, chat turn, coding session turn, saved page and skill (id, source imessage|gmail|x|calendar|record|chat|omp|saved|skill|memory|note|wiki, kind, thread, title, at, sender, sender_name, from_me, url, body); never select body of many rows. " +
      "item_people(item_id, person_id, role sender|recipient|mentioned|subject); people(id, kind person|org|self, name, aliases jsonb, handles jsonb of emails and phones, relationship). " +
      "Example: select org, count(*), sum(amount) from records where type = 'payment' and org ilike '%venmo%' and superseded_by is null and paid_at >= '2026-01-01' group by org. Open an item or record's source with memory_read.",
    input: z.object({ sql: z.string().describe("One SELECT statement") }),
  },
  save: {
    description:
      `Keep a web page, article, PDF, video, post or a pasted note/file in ${O}'s brain, verbatim: searchable within about a minute, summarized and tagged within minutes (memory_search source saved). Give one of url, text or file (a path on this machine, local callers only). Pass why (why it is being saved, from the conversation): it is what ${O} will search by later. Use it when ${O} says save this / put this in my brain. Saving the same thing again answers already: true.`,
    input: z.object({
      url: z.string().optional().describe("A page, article, PDF, YouTube video or X post"),
      text: z.string().optional().describe("A note or pasted text, kept verbatim"),
      file: z.string().optional().describe("A local file path (PDF, HTML or text); local callers only"),
      title: z.string().optional(),
      why: z.string().optional().describe("Why it is being saved, in the owner's terms"),
    }),
  },
  skill_get: {
    description:
      `${OWNER.name}'s skills and styles: how ${OWNER.they} wants a kind of work done (a skill: an explainer, a research brief, a release) and how ${OWNER.their} things should look (a style: principles, tokens, exemplars), written into the brain from finished work ${OWNER.they} signed off. Before you start work a skill or style covers, load it and follow it; when ${OWNER.they} says "do it in the X style", load styles/X; when ${OWNER.they} names no style for UI or visual work, load the style marked default. Load 1-3 per task, not more (more dilutes them). No name: the catalog (path, kind, description, default). name ("explainer", "styles/dashboard" or a skill:// URI): its SKILL.md frontmatter and body plus a manifest of every file with its digest. Add file ("examples/page.md", "assets/hero.png") to open one: text in 32 KB pages (page, 0-based), images as images.`,
    input: z.object({
      name: z.string().max(300).optional().describe('A skill or style: "explainer", "styles/dashboard", "nbrain/write-skill" or skill://styles/dashboard/SKILL.md; omit for the catalog'),
      file: z.string().max(500).optional().describe('A file of that skill, as its manifest lists it, e.g. "examples/page.md"'),
      page: z.number().int().min(0).optional().describe("0-based page of a long text, 32 KB each"),
    }),
  },
  skill_save: {
    description:
      `Add or update one of ${OWNER.name}'s skills or styles: how a kind of work is done, or how things should look. First load the guide and follow it: skill_get {"name":"write-skill"} (or "write-style"). Distill from the work you just finished: what ${OWNER.name} asked, what ${OWNER.they} corrected (quote ${OWNER.them}), what worked and what failed; never from general knowledge. To update, read it with skill_get, merge your change into the body you read (do not rewrite it from memory), and pass its SKILL.md digest as base; a save without the current base is refused. files add or replace supporting files (examples/, assets/, references/) as text content, base64, or from (an absolute path on the brain's machine, local agents only); remove deletes files. Set default only when ${OWNER.name} says this is the style for that kind of work when none is named. Every save is a git commit signed with your agent's name; answers its uri, commit, files and warnings.`,
    input: z.object({
      name: z.string().min(1).max(64).describe("Lowercase letters, digits and hyphens, e.g. explainer"),
      kind: z.enum(["skill", "style"]).describe("skill: how a kind of work is done; style: how things look"),
      description: z.string().min(1).max(1024).describe("What it does and when to use it, with the phrases that should trigger it"),
      body: z.string().min(1).describe("The SKILL.md markdown after the frontmatter: the whole body, merged with what is there"),
      default: z.boolean().optional().describe(`true only when ${OWNER.name} says it is the default for its kind of work; false clears it`),
      source: z.string().max(500).optional().describe("Where it came from: project path, session, URL"),
      base: z.string().optional().describe("Updating: the sha256:… digest of the SKILL.md you read"),
      files: z.array(z.object({
        path: z.string().describe("Relative path inside the skill, e.g. examples/page.md"),
        content: z.string().optional().describe("Text content"),
        base64: z.string().optional().describe("Binary content, base64"),
        from: z.string().optional().describe("Absolute local path to copy (local agents only)"),
      })).max(512).optional(),
      remove: z.array(z.string()).optional().describe("Relative paths of files to delete"),
    }),
  },
} as const;
