// The memory tools' public contract (names, descriptions, inputs) every connected agent sees. Bots call them by name:
// add tools freely; renaming one or changing its inputs breaks them. The set, by layer:
//   brief                       start of a task: the rules for this work, where the project stands, what to load
//   search, fetch, changes, sql the record, verbatim (search and fetch are also the shape ChatGPT deep research calls)
//   person                      who someone is
//   library, library_mark       tools, techniques, references and reads the owner kept, and what came of trying them
//   save, remember, correct, private   writes: keep a thing, leave a note, fix what is wrong, keep something out
//   skill_get, skill_save       how a kind of work is done and how things look
import * as z from "zod";
import { OWNER, ZONE } from "../config.js";

const O = OWNER.name;
const OS = `${O}'s`;

export const CARD_KINDS = ["tool", "technique", "reference", "idea", "read", "person"] as const;
export const CARD_STATUSES = ["new", "tried", "adopted", "dropped"] as const;

export const MCP_TOOLS = {
  brief: {
    description:
      `Start here, once per task. A short brief on ${O} for the work in hand: the rules ${OWNER.they} set for this kind of work, where the project stands now, and up to three skills or library cards worth loading. Pass the task in a sentence (or the request as given) and the project when there is one. Then search for specifics.`,
    input: z.object({
      task: z.string().min(3).max(2000).describe("What you are about to do, in a sentence, or the request as given"),
      project: z.string().max(200).optional().describe('The project, repo directory or desk, e.g. "nbrain" or "~/Projects/nbrain"'),
    }),
  },
  search: {
    description:
      `Search everything ${OS} life touched, verbatim: texts, mail, records read from them (bills, payments, orders, appointments), calendar, X bookmarks and their articles, saved pages, research notes, chats with ${OWNER.their} bots, coding sessions, notes agents left, skills. Dates and people in the query are understood ("what did Mom text last week"). Each result is strong or weak; nothing_strong: true means there is no good answer, so say that instead of guessing from weak results. Look-alikes (one order's shipping mails, one thread's messages) fold into one result with more: n. Filters: person (only items they sent or received), source (imessage, gmail, x, calendar, record, chat, omp, saved, research, skill, note, wiki), from/to (YYYY-MM-DD or ISO). Open a result with fetch.`,
    input: z.object({
      query: z.string(),
      person: z.string().optional(),
      source: z.array(z.string()).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().optional().describe("Results, default 10, at most 30"),
      private: z.boolean().optional().describe(`Include what ${O} marked private; only when ${OWNER.they} asks about it`),
    }),
  },
  fetch: {
    description:
      `Open one thing by id: a search result (or <id>#<chunk>) with its full text in pages of 8 KB, who is on it and the neighbouring messages of its thread; a library card (card:…); ${OS} whole profile (profile); or what is going on now (now).`,
    input: z.object({ id: z.string(), page: z.number().optional(), private: z.boolean().optional().describe(`Open something ${O} marked private; only when ${OWNER.they} asks about it`) }),
  },
  changes: {
    description:
      `What came in since a time, newest first, grouped by thread: texts, mail, calendar changes, records, bookmarks, saves, chats with the bots and coding sessions, with a count per source. Use it to catch up ("since this morning", "anything new from Sam since Monday"). Filters: source, person.`,
    input: z.object({
      since: z.string().describe('ISO time, YYYY-MM-DD, or "yesterday", "this morning", "3 days ago"'),
      source: z.array(z.string()).optional(),
      person: z.string().optional(),
      limit: z.number().optional().describe("Threads, default 30, at most 100"),
    }),
  },
  sql: {
    description:
      `Answer who / how many / how much / latest by SQL over ${OS} memory (Postgres, read-only, schema memory, times in ${ZONE}, 100 rows). Use it to count, sum, list or pick the latest; use search to find what was said. ` +
      `records: bills, payments, receipts, orders and appointments read out of ${OWNER.their} mail, texts and calendar (id, item_id, type bill|payment|order|appointment|commitment|request|plan|family_date, org, title, amount, currency, due_at, paid_at (a payment's day, an order's day), start_at, end_at, status, ref, at, superseded_by); filter \`superseded_by is null\`: a set one was replaced by a later record or retracted by a correction. ` +
      "items: every text, mail, post, calendar event, chat turn, coding session turn, saved page, note and skill (id, source imessage|gmail|x|calendar|record|chat|omp|saved|skill|note|wiki, kind, thread, title, at, sender, sender_name, from_me, url, body); never select body of many rows. " +
      "item_people(item_id, person_id, role sender|recipient|mentioned|subject); people(id, kind person|org|self, name, aliases jsonb, handles jsonb of emails and phones, relationship). " +
      `cards: the library (id, item_id, kind ${CARD_KINDS.join("|")}, what, why, craft, projects text[], url, status ${CARD_STATUSES.join("|")}, status_note, at). ` +
      "Example: select org, count(*), sum(amount) from records where type = 'payment' and org ilike '%venmo%' and superseded_by is null and paid_at >= '2026-01-01' group by org. Open a row's item with fetch.",
    input: z.object({ sql: z.string().describe("One SELECT statement") }),
  },
  person: {
    description:
      `Who someone is to ${O}: relationship, other names, phones, emails, birthday, their records and last threads. Give a name, alias, phone or email; a misspelled or half-remembered name finds the closest people, marked close. Up to 3 matches.`,
    input: z.object({ name: z.string().min(1).max(200) }),
  },
  library: {
    description:
      `${OS} library: tools, techniques, design references, ideas, reads and people worth following that ${OWNER.they} bookmarked or saved, each a card saying what it is, why it fits ${OWNER.them}, which projects it bears on, and whether ${OWNER.they} tried it (${CARD_STATUSES.join(", ")}). Design references carry a full-page screenshot and a note on their craft. Look here before picking a tool, library, technique or look ("drag and drop for React", "dense dashboard tables"). Filters: kind, project, status.`,
    input: z.object({
      query: z.string().min(1).max(500),
      kind: z.enum(CARD_KINDS).optional(),
      project: z.string().max(200).optional(),
      status: z.enum(CARD_STATUSES).optional(),
      limit: z.number().optional().describe("Cards, default 8, at most 20"),
    }),
  },
  library_mark: {
    description:
      `Record what came of using a library card for ${O}: tried, adopted or dropped, with one line on why. The weekly digest and later briefs read it.`,
    input: z.object({
      id: z.string().describe("The card id, card:…"),
      status: z.enum(["tried", "adopted", "dropped"]),
      note: z.string().min(3).max(300).describe("What happened, in a line"),
    }),
  },
  save: {
    description:
      `Keep a web page, article, PDF, video, post or a pasted note/file in ${OS} brain, verbatim: searchable within about a minute, and a library card within minutes (a design site also gets a full-page screenshot). Give one of url, text or file (a path on this machine, local callers only). Pass why (why it is being saved, from the conversation): it is what ${O} will look for later. Use it when ${O} says save this / put this in my brain. Saving the same thing again answers already: true.`,
    input: z.object({
      url: z.string().optional().describe("A page, article, PDF, YouTube video or X post"),
      text: z.string().optional().describe("A note or pasted text, kept verbatim"),
      file: z.string().optional().describe("A local file path (PDF, HTML or text); local callers only"),
      title: z.string().optional(),
      why: z.string().optional().describe("Why it is being saved, in the owner's terms"),
      project: z.string().max(200).optional().describe("The project it is for, when there is one"),
    }),
  },
  remember: {
    description:
      `Leave a note in ${OS} brain, signed with your agent's name: something ${O} said about how ${OWNER.they} works or what ${OWNER.they} wants, or a fact about ${OWNER.their} life that came up. Quote ${OWNER.them} where you can. Searchable at once (source note); each night the curator moves what ${O} said into ${OWNER.their} profile. When something the brain told you is wrong, use correct instead.`,
    input: z.object({
      text: z.string().min(3).max(1000).describe(`One self-contained statement with absolute dates; quote ${O} where you can`),
      about: z.string().max(100).optional().describe("A person, project or topic"),
    }),
  },
  correct: {
    description:
      `Fix something the brain has wrong: a line of ${OS} profile or brief, a record (a bill, order or appointment read wrongly), a library card, or what it says is going on now. Say what is wrong and what is right, in ${OS} words when ${OWNER.they} said it. Applied within a minute: the next brief carries it and nothing overwrites it later. To undo a profile change from the weekly list, pass its id and say undo.`,
    input: z.object({
      text: z.string().min(3).max(2000).describe("What is wrong and what is right"),
      id: z.string().max(300).optional().describe("What it is about, when known: a record, card, item or profile change id"),
    }),
  },
  private: {
    description:
      `Keep something out of every brief, profile, library and search result: one item, or its whole thread (thread: true). Use it when ${O} says something is private or secret. It stays in the record; search finds it only when asked with private: true. private: false undoes it.`,
    input: z.object({
      id: z.string().describe("An item id from search or fetch"),
      thread: z.boolean().optional().describe("The whole conversation or mail thread the item is in"),
      private: z.boolean().optional().describe("false undoes it; default true"),
      why: z.string().max(300).optional(),
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
