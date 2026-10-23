# How nbrain works

Two processes do the work. Ingest (`bin/run-ingest.sh`, `src/ingest.ts`) reads sources into `brain.events`, indexes them into schema `memory` and runs the upkeep loops. memory-mcp (`bin/run-memory-mcp.sh`, `src/mcp/server.ts`) serves the record and the context repo to agents. Both read `$BRAIN_HOME/env`.

The layers build on each other. The record is everything read, verbatim. The profile, now and the library are derived from it and live in small, readable places: the profile and now as files in the context repo (`$BRAIN_HOME/context`, a git repo), the library as cards in Postgres. The brief is cut from all three for each task. The reasons behind each choice, with sources, are in [research](research.md).

## Sources

Connectors run only when named in `CONNECTORS`. Each keeps its position in `brain.cursors`, so a restart or an outage resumes where it stopped; `nbrain doctor` shows each connector's last success.

| Connector | Reads | Every |
|---|---|---|
| `gmail` | New mail through the `gmail` app in [Executor](https://executor.sh), skipping drafts and spam | 1 min |
| `imessage` | Messages through Executor's `apple-messages` app; once an hour the last 48 hours again, so later reactions and edits land | 1 min |
| `calendar` | Executor's `apple-calendar` app, a week back to 30 days ahead, read whole; a missing upcoming event is marked deleted | 5 min |
| `x` | New bookmarks through `xurl`, stopping at the first one already known; the first run only records where the bookmarks are | 06:45 and 17:45 |
| `omp` | Your typed turns in top-level omp sessions, each with the answer that closed it; subagent and scratch sessions are skipped | 5 min |

Each X bookmark is hydrated from free sources: the post, its thread and parents, quotes, the article, replies, linked pages (through the rendering page reader, `PAGE_READER`) and a model's description of each image.

These arrive without a connector:

- `chat`: conversations your own bots write into `brain.events` as `chat.turn` events. No connector for them ships here.
- `saved` and `research`: what the `save` tool or `nbrain save` keeps. `nbrain save … --as research` stores a research write-up as source `research`: searchable by work tokens, never carded.
- `note`: what agents leave with `remember`, searchable at once.

### Capture

Any agent with write scope can call `save`; from a shell, `nbrain save <url> --why "…"`, or `nbrain save -` for text on stdin. Each kind of input has its own reader:

- X posts are hydrated like bookmarks.
- YouTube goes through `yt-dlp`: title, channel, description and the caption transcript.
- PDFs go through unpdf; a scan with no text layer is refused.
- Pages go through Defuddle. A page that yields fewer than 200 words, or refuses a plain fetch, is read again through `PAGE_READER` when it is set.
- Local files (PDF, HTML or text) are read only for local callers.

URLs are canonicalised (tracking parameters removed, `twitter.com` read as `x.com`), so saving the same thing twice answers `already`. The fetched page or PDF, up to 25 MB, is kept under `$BRAIN_HOME/captures`, because pages disappear. The reason given with `why` becomes each chunk's context line at once, so the item is found by why it was kept. Within minutes the library triage adds a summary, up to five tags and a context sentence for every chunk, indexed with the chunk ([contextual retrieval](research.md#capture-and-retrieval-of-saved-things)).

## Search

`search` runs its channels side by side over the chunks:

- Words: BM25 through ParadeDB, with headings and people boosted.
- Meaning: Qwen3-Embedding-0.6B vectors through Ollama, in pgvector.
- Date, person and source channels when the query names one ("last week", "Mom", "texts"), and, when it names two or more, a channel for the items that meet them all.
- A newest-first channel when the query asks for the latest of something, and one for codes it names (order numbers, bookings, phones).

Reciprocal rank fusion merges them, one hit per item. A local cross-encoder (Qwen3-Reranker-0.6B under `llama-server`) reorders the head of the list; without `RERANK_URL` the fused order stands. An item id in the query comes first.

What comes back is built to be read honestly:

- **Strong or weak.** A result is strong when the reranker judges that it answers the query, it falls in the dates the query names (by when it was sent, or a nearby message in its conversation naming that day), and it holds the names the query names. Without the reranker, a result is strong only when it holds every word that matters. `nothing_strong: true` means no result is strong, and the tool tells agents to say so instead of guessing.
- **Folding.** One mail thread, one order's mails and delivery notices, and texts already shown in another hit's conversation fold into one result with `more: n`.
- **Conversations.** A text, or a bot chat turn imported in pieces, is shown with the messages around it in its thread, and nearby conversations in one thread show as one.
- **Dates.** `from` and `to` filter (a bare date is a whole local day, `to` included). Dates written in the query rank, but never filter.
- **People.** `person` keeps only items that person sent or received, matched by person record, not by name text. Similar names stay separate people; a half-remembered name finds the closest ones, marked `close`.
- **Private.** Items and threads marked with `private` are left out of search, and `fetch` refuses them, unless a life-scope caller passes `private: true`. Verification codes are left out unless the query asks for a code.

`fetch` opens one result (or `<id>#<chunk>`) in 8 KB pages with the people on it and the neighbouring messages of its thread; it also opens a library card (`card:…`), the profile (`profile`) or now (`now`). `changes` lists what arrived since a time ("yesterday", "this morning", "3 days ago", "Monday" for the most recent one, a date), newest first, grouped by thread, with a count per source. `person` answers who someone is. `sql` runs one read-only `SELECT` over schema `memory` as a role that can read nothing else; it is the way to count, sum or pick the latest.

### Records

Mail and texts that mention money, an order, a booking or a due date (not Gmail's promotions, social or forums tabs) are read by the extraction model into typed records: bill, payment, order, appointment and a few more, each pointing at the item it came from. Calendar events become appointments as they stand. A later record of the same thing sets `superseded_by` on the earlier one; so does a correction that shows a record was never true. Search shows a current record with the item it was read from and leaves superseded ones out; `fetch` by id still opens them.

## The profile

Short statements about the owner in markdown files in the context repo:

| File | Scope |
|---|---|
| `basics.md`, `work-style.md`, `principles.md`, `tastes.md`, `goals.md`, `projects.md`, `outputs.md` | work |
| `life.md` | life |
| `closed.md` | read by nothing; every line that left the profile |

Each statement is one `- ` line that ends with where it came from and when:

```markdown
- Plain words, outcome first. <!-- omp:abc123#4 2026-10-22 -->
```

The source is an item id (the owner's words in a chat, session or note), `correction:<id>`, or `owner` for a line written by hand; a line with no comment is the owner's own. Lines under a `## Always` heading go into every brief of their file's scope; the rest are picked by how near they are to the task. A line is never deleted: closing it moves it to `closed.md` with the day, who closed it, why and where it came from. Files have no size cap: the brief picks the lines that fit each task within its own budget, so a true line never waits for room.

### The curator

Besides the owner's own hand, the curator (`src/curator.ts`) is the only writer of these files. It closes and adds lines and never rewrites a file. Each change is its own git commit, so `git log -p` in the context repo is the audit trail.

- **Corrections, within a minute.** An agent passes on what is wrong with `correct`. The curator closes the wrong profile lines and adds the right one, retracts records that were never true, rewrites a library card (and the context lines search finds it by), or has now rewritten, and commits in the name of the agent that passed it on. A line sourced to a correction changes only by a later correction, and a card field a correction set survives the card being read again, so nothing overwrites what the owner fixed.
- **Nightly, from the owner's own words.** At 03:30 it reads what reached the record since its last run: the owner's turns in chats with the bots, the owner's prompts in coding sessions, notes agents left, and records the owner is a party to, never anything private. It proposes closes and additions that each quote the item they come from word for word; an edit whose quote is not in that item is dropped. Other people's words are never evidence. Most nights the right answer is no change.
- **Undo, weekly.** The Sunday message lists the week's changes with their commit ids. Telling the assistant "undo `<id>`" passes a correction that takes that commit back: the lines it added leave, and the lines it removed return. An undo is refused, and logged, when a later change already took away lines it added, since bringing the old line back would stand it beside the newer one.

## Now

`now.md` says what is in flight, rewritten whole at 05:30 each day and by `nbrain now`, never edited by hand. One model call writes it from the last 7 days:

- A block per repo with commits in the last week under `NOW_ROOTS` (each folder and its children), from its commits, its fresh `local/nstack/*.md` ledgers, and the owner's prompts in coding sessions run there.
- A block per desk under `NOW_DESKS` with fresh files, a fresh `memory/<desk>/journal.md`, or chats and notes this week.
- A `Life` block (life scope) from the next 14 days: calendar, bills due, appointments and commitments, and what the owner told the bots this week.

Corrections from the last two weeks override what they contradict. A work block has at most four lines plus when it was last touched, since the brief shows a project's block whole. Under each block's heading, `<!-- dirs: … -->` names the directories and names it answers to, so a brief for a project or a working directory finds its block.

## The library

Every X bookmark and saved page is read once per version by the reading model, with the work profile and now in hand, and either becomes a card or is set aside as not worth one. Research notes stay record only. A card has:

- `kind`: tool, technique, reference, idea, read or person.
- `what` it is and `why` it fits the owner, a sentence each; they become every chunk's context line, so plain search finds the item by them.
- `projects` it bears on, from now's blocks and `projects.md`; a save's `project` comes first.
- `craft`, for a reference: what is good about it in terms of type, layout, motion, density or colour.
- `status`: new, tried, adopted or dropped.

Each reference card whose link is a web page gets captures under `$BRAIN_HOME/captures`: a full-page screenshot, an MHTML archive and, when the page moves on load, a ten-second WebM recording. Google Chrome runs headless in a throwaway profile for each page. A page that is not a web page, or fails, is marked and not tried again. Without Chrome the run stops, logs it, and leaves the cards to try later.

`library` finds cards for a plain description ("drag and drop for React", "dense dashboard tables"), each strong or weak as search judged it. `library_mark` records what came of trying one, in a line. The Sunday message's library part counts the cards the week added and lists up to five untried cards for projects in flight, one per project first, this week's first.

## The brief

`brief` is the first call of a task: the task in a sentence and, when there is one, the project (a name, a repo directory or the working directory). It is built per call, around 1,500 tokens:

1. **Rules for this work.** The caller's `## Always` lines, then the profile lines nearest the task. A line that is near every task (a project list, a home folder) is ranked down.
2. **Now.** The project's block; with no project, every block, nearest first.
3. **Earlier on this.** Up to three strong record results for the task, the project's own coding sessions first, so an agent does not redo what was done or reopen what was settled.
4. **Worth loading.** Up to three: the default style when the task is screen work, skills search finds strong for it, and strong library cards, each with the call that loads it.

Within the budget, room goes first to the pointers and Always lines; past it, the near lines go first, then other now blocks, then the record results. Scopes apply: a work token's brief has no `life.md`, Life block, mail or texts. `nbrain brief --task "…" [--project …]` asks memory-mcp for one over HTTP, and the omp extension uses it to brief each main session.

## The Sunday message

Once a week, at the first tick from 09:00 on Sunday, ingest sends a message through `BRAIN_NOTIFY`, a command that gets the text on stdin (a mail command, a push service's CLI, or the assistant's own channel, which is asked to pass it on word for word). Without `BRAIN_NOTIFY`, the message goes to ingest's log instead and the week counts as done. It has three parts:

- **Profile changes.** Each curator and correction commit of the week in plain words, with the id that takes it back.
- **Library.** The digest above.
- **Checkup.** The recall eval's latest score beside the week before, connectors not read in the last day or whose last read failed, and how many bookmarks and saves are still to card.

`nbrain weekly` prints this week's message; `nbrain weekly --send` sends it now.

## Upkeep

| Loop | Runs | What it does |
|---|---|---|
| `memory_events` | every minute | Events to items and chunks, with embeddings |
| `memory_records` | every minute | Records out of new mail and texts; calendar events as appointments |
| `library_triage` | every minute | A card or a skip for each new bookmark and save; summary, tags and chunk context for saves |
| `library_capture` | every 5 minutes | Screenshot, archive and recording for reference cards |
| `curator_corrections` | every minute | Corrections into the profile, records, cards and now |
| `curator_nightly` | 03:30 | The owner's own words into the profile |
| `now` | 05:30 | `now.md` rewritten |
| `eval` | Sunday after 04:00 | The retrieval eval, when a question file exists; the first morning after a missed week |
| `weekly` | Sunday from 09:00 | The Sunday message |
| `memory_skills` | every minute | Skills and styles into search |

A loop never overlaps itself; a failed run is logged and tried again at the next tick.

## Scopes

Every caller is a token: an agent name and its scopes. A tool is offered to a token holding any one of its scopes.

| Tool | Scopes |
|---|---|
| `brief`, `search`, `changes`, `library`, `skill_get` | work, life |
| `fetch` | work, life, archive |
| `person` | life |
| `sql` | archive |
| `save`, `remember`, `correct`, `private`, `library_mark`, `skill_save` | write |

- `work` reads the work profile files and now's project blocks, and searches and opens only X bookmarks, saved pages, research notes, skills, coding sessions and an older store's `wiki`.
- `life` adds `life.md`, the Life block, people and every source, including mail, texts, calendar, records, chats and notes, and private items when asked.
- `archive` adds `sql` and `fetch` of any item.
- `write` signs each write with the token's agent name, never a name the caller gives.

Privacy and safety:

- **Local.** Postgres, the context repo, embeddings and reranking run on your machine. The server listens on 127.0.0.1; anything remote comes through a proxy you set up ([connect](connect.md#remote-access)).
- **What leaves.** Brain content leaves only in model calls to `LLM_URLS` (records, library triage, image descriptions, the curator, now) and in the Sunday message through `BRAIN_NOTIFY`. Other outbound requests fetch what you asked to keep: a saved URL, X bookmarks and their links, YouTube transcripts, the pages of reference cards.
- **Private.** `private` marks an item or its whole thread. Search, `fetch`, `changes`, briefs, the curator's evidence, now, the library and its captures leave it out; only a life-scope `search` or `fetch` with `private: true` opens it. Within a minute, profile and `closed.md` lines sourced to it (or to a record read from it) are removed in one commit, and now is rewritten; corrections about it are never shown to a model. It stays in the record, and `sql` still reads it.
- **Least privilege.** The server never gets the Postgres superuser. It reads as `memory_ro`, which can only `SELECT` schema `memory`, and writes as `memory_writer`, which can only insert notes, saves and corrections, mark and unmark private, and set a card's status.
- **Hashed tokens.** `$BRAIN_HOME/memory-mcp/tokens.json` stores only the SHA-256 of each token.
- **Logs and a kill switch.** Each call is logged with its arguments clipped and never its result; writes log metadata only. `touch $BRAIN_HOME/memory-mcp/DISABLED` makes `/mcp` answer 503.

## Skills and styles

A skill says how you want a kind of work done; a style says how your things should look. Both are [Agent Skills](https://agentskills.io/specification) directories (`SKILL.md` plus `examples/`, `references/`, `assets/`) in the context repo, under `skills/<name>/` and `styles/<name>/`.

- **Authored** after you approve finished work. The agent loads the built-in guide (`nbrain/write-skill` or `nbrain/write-style`), distills from that session (your corrections quoted, each rule with its reason and value) and calls `skill_save`. Each save is a git commit signed with the agent's name. An update must pass the digest of the `SKILL.md` it read, so writers merge instead of rewriting from memory.
- **Found** without being asked for: each skill is indexed for search within a minute, the brief points to the ones search finds strong for the task, and the server instructions carry the catalog.
- **Loaded** 1-3 per task. In SkillsBench, one skill added 18.0 points and two or three added 19.0, but four or more added only 10.1. Compact skills beat comprehensive ones, and skills an agent wrote for itself before the task scored below none ([research](research.md#skills-and-styles)).

A style becomes the default only when you say so; the brief points to it for screen work. From a shell: `nbrain skill list`, `nbrain skill show <name>`, `nbrain skill check <dir>`.

## The eval

`nbrain eval questions.json` runs each question through the same search agents get (all sources, reranked, 10 results). A question passes only if every expected fact appears in the results, so there is no LLM judge. Each miss names the stage that lost it. A miss whose fact is no longer anywhere in memory is `stale`: a question to update, not a search failure.

```json
{ "questions": [{ "id": "saved-1", "category": "saved", "query": "how much did context per chunk cut retrieval failures", "facts": ["49%"] }] }
```

Results land in `$BRAIN_HOME/eval/recall-<time>.json`, and the Sunday message reports the score. With `$BRAIN_HOME/eval/memory-v2.json` (or `EVAL_QUESTIONS`) in place, ingest runs it every Sunday after 04:00.
