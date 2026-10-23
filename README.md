# nbrain

One memory shared by every AI agent you use. nbrain keeps five things on your machine:

- **The record.** Your mail, texts, calendar, X bookmarks, coding sessions, saved pages and research notes, verbatim in Postgres, with a search that says when nothing it found is a good answer.
- **The profile.** Short statements about how you work, what you want and your life, in a git repo. Each line names where it came from, and only your own words or a correction change it.
- **Now.** What you have in flight this week, per project and for your life, rewritten every morning.
- **The library.** A card for each bookmark or saved page worth keeping: what it is, why it fits you, which projects it bears on, and whether you tried it. Design references also get a screenshot.
- **Skills and styles.** How you want a kind of work done and how your things should look, distilled from work you approved.

At the start of a task an agent asks for a **brief**: about 1,500 tokens drawn from all of the above for that task. It searches the record for the rest. Every agent reaches nbrain through one MCP server with its own token and scopes, so a coding agent in your terminal and a chat app on your phone start from the same context.

It runs on your machine. Brain content leaves it only in model calls and in the weekly message it sends you.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/system-dark.svg">
    <img src="docs/img/system-light.svg" width="480" alt="Mail, texts and calendar, X bookmarks, coding sessions, bot chats, saves and research notes flow into the record, kept verbatim in Postgres with hybrid search. From it nbrain keeps the profile, sourced lines only your own words change; now, rewritten each morning; and the library, a card per bookmark or save. A brief is cut from them for each task. One MCP server gives each client, with its own scopes, the brief and direct search, fetch, changes and sql over the record.">
  </picture>
</p>

## A brief

What a coding agent gets for "cut the 0.5 release" in the nbrain repo, for a made-up owner:

```text
## Alex's rules for this work
- Run the tests before every commit.
- Plain words, outcome first; no marketing in READMEs.
- Release notes list what changed for users, not commit subjects.

## Now (2026-10-22)

### nbrain
- Library cards and captures are live; the 0.5 release waits on the docs.
- Next: Alex reviews the docs, then tags 0.5.
- Last touched Thu, Oct 22.

## Earlier on this
- Oct 14, 2026 · omp · Cut v0.4: Tag after the changelog, then push the tag and write the notes from it… [omp:…]

## Worth loading
- release (skill): How Alex cuts a release: changelog, tag, notes. Load: skill_get {"name":"release"}
```

## Tools

| Tool | Scope | Does |
|---|---|---|
| **Start** | | |
| `brief` | work, life | The brief for a task and project: your rules for it, where the project stands, what came before, what to load |
| **The record** | | |
| `search` | work, life | Hybrid search over the record. Each result is strong or weak; `nothing_strong` says there is no good answer |
| `fetch` | work, life, archive | One thing by id: an item in 8 KB pages with its thread, a library card, the profile, or now |
| `changes` | work, life | What came in since a time, grouped by thread, with a count per source |
| `sql` | archive | One read-only `SELECT` over schema `memory`, up to 100 rows |
| `person` | life | Who someone is: relationship, other names, handles, records, last threads |
| **The library** | | |
| `library` | work, life | Cards for a plain description, with kind, project and status filters |
| `library_mark` | write | Record that a card was tried, adopted or dropped, and why |
| **Writes** | | |
| `save` | write | Keep a URL, text or local file; searchable in about a minute, carded within minutes |
| `remember` | write | Leave a note, signed with the agent's name |
| `correct` | write | Fix a profile line, record, card or now; applied within a minute, and it sticks |
| `private` | write | Keep an item or its whole thread out of search, briefs, the profile and the library |
| **Skills and styles** | | |
| `skill_get` | work, life | The catalog, or one skill or style with a manifest of its files |
| `skill_save` | write | Add or update a skill or style; an update names the digest of the version it read |

A token sees only the tools its scopes allow. `search` and `fetch` also answer in the shape ChatGPT deep research reads. The server also offers the brief as a prompt, every skill file as a `skill://` resource, and the MCP Skills extension. Tool names and inputs are a stable contract.

| Scope | Grants |
|---|---|
| `work` | The work profile files and now's project blocks; the record limited to X bookmarks, saved pages, research notes, skills and coding sessions |
| `life` | `life.md`, now's Life block, people, and every source, including mail, texts, calendar, records and chats |
| `archive` | `sql`, and `fetch` of any item |
| `write` | `save`, `remember`, `correct`, `private`, `library_mark`, `skill_save` |

## Requirements

| Needs | For |
|---|---|
| macOS | launchd jobs and the Keychain; on Linux, run the same scripts under systemd ([setup](docs/setup.md#linux)) |
| [Docker](https://www.docker.com) | Postgres 17 with [pgvector](https://github.com/pgvector/pgvector) and [ParadeDB pg_search](https://github.com/paradedb/paradedb), from `compose.yml` |
| Node 26 | The server, ingest and CLI |
| [Ollama](https://ollama.com) | Local embeddings, `qwen3-embedding:0.6b` |
| An OpenAI-compatible chat endpoint | Records, library cards, the curator and now |

Optional: `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) for the local reranker, Google Chrome for library captures, [Executor](https://executor.sh) for mail, texts and calendar, [xurl](https://github.com/xdevplatform/xurl) for X bookmarks, [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube, and [restic](https://restic.net) for backups.

## Quickstart

From a clone of this repository:

```sh
npm install
docker compose up -d                 # Postgres on 127.0.0.1:5433
ollama pull qwen3-embedding:0.6b
bin/nbrain init --name "Alex Rivera" # writes ~/.brain/env, stops
```

Edit `~/.brain/env`: check `OWNER_*`, `TZ` and `DATABASE_URL`, and set `LLM_URLS` and `LLM_API_KEY` (or `LLM_API_KEY_FILE`). Then:

```sh
bin/nbrain init                      # context repo, schema, roles
bin/run-memory-mcp.sh                # own shell: server on :8830
bin/run-ingest.sh                    # own shell: ingest loops
bin/nbrain doctor                    # every line should read ok
bin/nbrain connect claude-code
```

`connect` also takes `omp`, `codex`, `cursor`, `claude-desktop` and `json`. It mints a token for the client, writes the server into its config and says where:

```text
claude-code: nbrain at http://127.0.0.1:8830/mcp as agent "claude-code" (work, write) → claude mcp (user scope)
```

Restart the client and ask it what it knows about you. On an empty brain, save something first:

```sh
bin/nbrain save https://www.anthropic.com/engineering/contextual-retrieval \
  --why "chunk context for retrieval"
bin/nbrain search "contextual retrieval"
```

## Docs

- [How it works](docs/how-it-works.md): sources, search, the profile and curator, now, the library, the brief, the Sunday message, the upkeep loops and scopes.
- [Connecting clients](docs/connect.md): omp, Claude Code, Codex, Cursor, Claude Desktop, ChatGPT and claude.ai, remote access, plain HTTP.
- [Setup](docs/setup.md): running it under launchd, connectors, readers, backups, Linux, every setting and every command.
- [Research](docs/research.md): the evidence behind each design decision.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # vitest run
```

Tests run as a made-up owner in a fixed time zone. Point them at a throwaway `BRAIN_HOME` and database, never a live brain. Tool names, inputs and scopes are a public contract: add tools freely, but renaming one or changing its inputs breaks connected clients.

## License

MIT. See [LICENSE](LICENSE).
