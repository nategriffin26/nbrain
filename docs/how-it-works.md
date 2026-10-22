# How nbrain works

Two processes do the work. Ingest (`bin/run-ingest.sh`, `src/ingest.ts`) reads sources into `brain.events`, indexes them into schema `memory` and runs the upkeep loops. memory-mcp (`bin/run-memory-mcp.sh`, `src/mcp/server.ts`) serves memory and the context repo to agents. Both read `$BRAIN_HOME/env`. The reasons behind each choice, with sources, are in [research](research.md).

## Sources

Connectors run only when named in `CONNECTORS`. Each keeps its position in `brain.cursors`, so a restart or an outage resumes where it stopped; `nbrain doctor` shows each connector's last success.

| Connector | Reads | Every |
|---|---|---|
| `gmail` | New mail through the `gmail` app in [Executor](https://executor.sh), skipping drafts and spam | 1 min |
| `imessage` | Messages through Executor's `apple-messages` app; once an hour the last 48 hours again, so later reactions and edits land | 1 min |
| `calendar` | Executor's `apple-calendar` app, a week back to 30 days ahead, read whole; a missing upcoming event is marked deleted | 5 min |
| `x` | New bookmarks through `xurl`, stopping at the first one already known; the first run only records where the bookmarks are | 06:45 and 17:45 |
| `omp` | Your typed turns in top-level omp sessions, each with the answer that closed it; subagent and scratch sessions are skipped | 5 min |

Each X bookmark is hydrated from free sources: the post, its thread and parents, quotes, the article, replies, linked pages (through the rendering page reader, `TF_PY`) and a model's description of each image.

`chat` items are conversations your own bots write into `brain.events` as `chat.turn` events; no connector for them ships here. They are searchable with life scope and feed notes and the gardener.

## Capture

Any agent with write scope can call `save`; from a shell, `nbrain save <url> --why "…"`, or `nbrain save -` to save text from stdin. Each kind of input has its own reader:

- X posts are hydrated like bookmarks.
- YouTube goes through `yt-dlp`: title, channel, description and the caption transcript.
- PDFs go through unpdf; a scan with no text layer is refused.
- Pages go through Defuddle. A page that yields fewer than 200 words, or refuses a plain fetch, is read again through the rendering page reader when `TF_PY` is set.
- Local files (PDF, HTML or text) are read only for local callers.

URLs are canonicalised (tracking parameters removed, `twitter.com` read as `x.com`), so saving the same thing twice answers `already`. The fetched page or PDF, up to 25 MB, is kept under `$BRAIN_HOME/captures`, because pages disappear. Within minutes one model call adds a summary, up to five tags and a context sentence for every chunk, and that sentence is indexed with the chunk ([contextual retrieval](research.md#capture-and-retrieval-of-saved-things)). `nbrain search <query> --source saved` searches saved items from a shell.

## Upkeep

| Loop | Every | What it does |
|---|---|---|
| `memory_events` | 1 min | Events to items and chunks, with embeddings |
| `memory_records` | 1 min | Records out of new mail, texts and calendar events |
| `capture_enrich` | 1 min | Summary, tags and chunk context for saved items |
| `memory_skills` | 1 min | Skills and styles into search |
| `memory_notes` | 5 min | Notes from new conversation turns, texts, mail and `remember` notes, then the life profile if they changed |
| `garden` | 03:30 | Yesterday's journal and small edits to the profile files |
| `eval` | weekly | The retrieval eval, early Sunday, when a question file exists |

A loop never overlaps itself; a failed run is logged and tried again at the next tick.

### Notes

A notes model reads chats with your bots, coding-session turns, texts, mail (not Gmail's promotions, social or forums tabs) and the notes agents `remember`, and writes facts, preferences, rules, decisions and situations. Latest wins: a note that changes another replaces it, and only current notes are searchable. Nothing is deleted; whatever a retired note said that its replacement does not stays as a note of its own. A `remember` note is kept verbatim at once and, within minutes, retires the notes it corrects; one that names a note by id ("note #123") retires all of it.

The life profile, about 5 KB, is rewritten from the current notes whenever they change. `context_get` and `memory_profile` serve it to life-scope tokens.

### Records

Mail, texts and calendar events that mention money, an order, a booking or a due date are read into typed records (bill, payment, order, appointment and a few more), each pointing at the item it came from. A later record that replaces one sets `superseded_by`. An `archive` token sums and counts them with `memory_query`.

### The gardener

Once a night it writes `journal/YYYY-MM-DD.md` and proposes a few line edits to each profile file, each citing its evidence. It never rewrites a file:

- The default is no change, and an edit that cites no evidence is dropped.
- Each file has a byte budget; a set of edits that would break it is dropped whole.
- `goals.md` is yours: the gardener only adds lines marked "(proposed)" and never changes or removes one of yours.
- A journal bullet that restates one already there is dropped. Mail and texts stay out of the journal: they are other people's words.
- Every changed file is its own commit by `gardener`, so `git log -p` in the context repo is the audit trail and `git revert` undoes an edit.

Preview a day with `nbrain garden --day YYYY-MM-DD --dry-run`. The context repo's own `README.md` lists each file's scope, owner and budget.

### The eval

`nbrain eval questions.json` runs each question through the same search `memory_search` uses (all sources, reranked, 10 hits). A question passes only if every expected fact appears in the hits, so there is no LLM judge. Each miss names the stage that lost it. A miss whose fact is no longer anywhere in memory (the note was rewritten as the truth changed) is `stale`: a question to update, not a search failure.

```json
{ "questions": [{ "id": "saved-1", "category": "saved", "query": "how much did context per chunk cut retrieval failures", "facts": ["49%"] }] }
```

Results land in `$BRAIN_HOME/eval/recall-<time>.json`; the score goes on the `eval` cursor and, with the stale questions, into that day's journal. With `$BRAIN_HOME/eval/memory-v2.json` (or `EVAL_QUESTIONS`) in place, ingest runs it every Sunday after 04:00, or the first morning after a missed week.

## Search

`memory_search` runs its channels side by side over the chunks:

- BM25 through ParadeDB, with headings and people boosted.
- Vectors from Qwen3-Embedding-0.6B through Ollama, in pgvector.
- Date, person and source channels when the query names one, and, when it names two or more, a channel for the items that meet them all.
- A newest-first channel when the query asks for the latest of something, and one for identifiers (order numbers, codes, phones).

Reciprocal rank fusion merges them, one hit per item, and a local cross-encoder (Qwen3-Reranker-0.6B under `llama-server`) reorders the top 30. Without `RERANK_URL` it skips the rerank. A work token searches only `x`, `wiki`, `saved`, `skill` and `omp`; a token with `life` or `archive` sees every source.

## Skills and styles

A skill says how you want a kind of work done; a style says how your things should look. Both are [Agent Skills](https://agentskills.io/specification) directories (`SKILL.md` plus `examples/`, `references/`, `assets/`) in the context repo, under `skills/<name>/` and `styles/<name>/`.

- **Authored** after you approve finished work. The agent loads the built-in guide (`nbrain/write-skill` or `nbrain/write-style`), distills from that session (your corrections quoted, each rule with its reason and value) and calls `skill_save`. Each save is a git commit signed with the agent's name. An update must pass the digest of the `SKILL.md` it read, so writers merge instead of rewriting from memory.
- **Found** without being asked for: each skill is indexed for search within a minute, `context_get` lists the three that best fit the topic plus your defaults, and the server instructions carry the catalog.
- **Loaded** 1-3 per task. In SkillsBench, one skill added 18.0 points and two or three added 19.0, but four or more added only 10.1. Compact skills beat comprehensive ones, and skills an agent wrote for itself before the task scored below none ([research](research.md#skills-and-styles)).

A style becomes the default only when you say so. From a shell: `nbrain skill list`, `nbrain skill show <name>`, `nbrain skill check <dir>`.

## A first run

On an empty database, a Codex CLI agent connected through the stdio relay called `context_get`, loaded the built-in `write-skill` guide and saved [an article on contextual retrieval](https://www.anthropic.com/news/contextual-retrieval). Within a minute the article had a summary, five tags and context on all 14 chunks. The agent then wrote a skill, `research-writeup`, from a document that had been approved. A second, fresh Codex agent asked for a research write-up loaded `research-writeup` first without being told to, followed it, and cited the saved article.
