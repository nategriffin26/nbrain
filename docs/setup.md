# Setup

The [quickstart](../README.md#quickstart) gets a brain running in two shells. This page keeps it running and covers every setting.

## Where things live

`BRAIN_HOME` (default `~/.brain`) holds everything personal; the repository holds none of it. Set `BRAIN_HOME` in your shell, not in the env file, to keep a brain elsewhere.

| Path | Holds |
|---|---|
| `env` | Every setting, from [`env.example`](../env.example); `bin/nbrain` and every `bin/run-*.sh` load it |
| `context/` | The context repo, in git: profile files, `closed.md`, `now.md`, skills and styles |
| `captures/` | Snapshots of saved pages and PDFs; screenshots, archives and recordings of library references |
| `memory-mcp/` | `tokens.json` (hashes only) and the `DISABLED` kill switch |
| `logs/` | Each job's log, `memory-mcp.log` and `memory-mcp-writes.log` |
| `eval/` | Your eval questions and results |

`nbrain init` is safe to run again: it never overwrites a file or resets a role that exists. The two roles are created with a connection limit above memory-mcp's pool (`MEMORY_POOL` in `src/config.ts`); `nbrain doctor` flags a role whose limit is below it. The first run writes `env` and stops. The second creates the folders, starts the context repo from `templates/context`, applies the schema and creates the server's two database roles, `memory_ro` and `memory_writer`. Their passwords go into `env`, or into the login Keychain when `KEYCHAIN_PREFIX` is set.

If port 5433 is taken, run `PG_PORT=5444 docker compose up -d` and change `DATABASE_URL` to match.

## Keep it running on macOS

`bin/install-launchd.sh` renders the jobs in `launchd/` into `$BRAIN_HOME/launchd` and links them into `~/Library/LaunchAgents`. Leave out the ones you don't run with `SKIP`. It never loads a job; load each one yourself:

```sh
SKIP="backup" bin/install-launchd.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.brain.memory-mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.brain.ingest.plist
```

| Job | Runs | Log |
|---|---|---|
| `dev.brain.memory-mcp` | The MCP server, kept alive | `memory-mcp.out.log` |
| `dev.brain.ingest` | Connectors and upkeep loops, kept alive | `brain-ingest.log` |
| `dev.brain.backup` | `bin/backup.sh` every 6 hours | `backup.log` |

`bin/restart-memory-mcp.sh` restarts the launchd server without dropping a request.

## Models

Embeddings come from Ollama on this machine (`ollama pull qwen3-embedding:0.6b`, at `OLLAMA_URL`). The search judge, `@cf/cloudflare/clef`, runs on [Workers AI](https://developers.cloudflare.com/workers-ai/): set `CLOUDFLARE_ACCOUNT_ID` and an API token with Workers AI access, as `CLOUDFLARE_API_TOKEN` in the env file or, with `KEYCHAIN_PREFIX` set, in the login Keychain item `<prefix>-cf-ai`. Without Ollama nothing new is indexed, and a search or brief whose embedding fails or takes over 6 s goes on without it (search without its meaning channel, a brief with the profile in its own order). Without the judge, search keeps the fused order and calls a hit strong only when it holds every word that matters. Each logs it, and `nbrain doctor` and the Sunday checkup say which model is down.

## Connectors

Name the ones you want in `CONNECTORS` (for example `CONNECTORS=gmail,imessage,calendar,x,omp`) and restart ingest.

- **Mail, texts, calendar.** Run an [Executor](https://executor.sh) with the `gmail`, `apple-messages` and `apple-calendar` apps connected. Ingest calls its MCP server at `EXECUTOR_MCP_URL` with the CLI key from `~/.executor/v2/cli/keys.json`.
- **X bookmarks.** Install [xurl](https://github.com/xdevplatform/xurl) and sign it in to your account. Each post read costs money on X's API, so only new bookmarks are read, twice a day.
- **Coding sessions.** Reads [omp](https://github.com/can1357/oh-my-pi) sessions from `OMP_SESSIONS`.
- **Readers.** `yt-dlp` reads YouTube. For pages that render in JavaScript and for the pages X posts link to, set `PAGE_READER` to a command that answers `read <urls> --json --lane <name> --max-wait <s> --max-chars 0`; without it, thin pages are kept as read and linked pages are skipped.
- **Library captures.** `npm install` brings `playwright-core`, which drives an installed Google Chrome, headless. Without Chrome, captures wait: the run stops, logs it, and leaves the cards for when Chrome is there.

## Now and the Sunday message

`now.md` is written each morning from the repos under `NOW_ROOTS` (a colon list; each folder and its children) with commits in the last week, and from the desks under `NOW_DESKS`: one per folder in `$NOW_DESKS/memory/`, with its `journal.md` and a `$NOW_DESKS/<desk>/` folder when there is one. With neither set, it has only the Life block. `nbrain now --dry-run` prints it without writing.

The Sunday message goes out through `BRAIN_NOTIFY`: a command that reads the text on stdin, split into words like a shell line but never run through a shell, such as `mail -s "Your brain this week" you@example.com`. Without it, ingest logs the message instead of sending it. `nbrain weekly` prints it.

## Backups

`bin/backup.sh` takes a `pg_dumpall` from the Postgres container (`PG_CONTAINER`), then backs up `$BRAIN_HOME` (without raw Postgres data) and the repository to any [restic](https://restic.net) repository in `RESTIC_REPOSITORY`. Add paths with `BACKUP_PATHS` and excludes with `$BRAIN_HOME/backup-excludes`. An append-only restic REST server means this machine cannot delete or change snapshots.

## Linux

The launchd templates, `KEYCHAIN_PREFIX`, `bin/restart-memory-mcp.sh` and the Claude Desktop config path are macOS-only. Run `bin/run-memory-mcp.sh` and `bin/run-ingest.sh` under systemd or a shell.

## Settings

All in `$BRAIN_HOME/env`; [`env.example`](../env.example) has each one with a comment.

| Setting | Default | Meaning |
|---|---|---|
| `OWNER_NAME`, `OWNER_FULL_NAME`, `OWNER_PRONOUNS` | `the owner`, `they/them/their` | Who the brain is about, in prompts and tool descriptions |
| `ASSISTANT_NAME` | `the assistant` | What you call your assistant |
| `TZ` | the system zone | Your time zone: days, "this morning" and every rendered time |
| `BRAIN_NAME` | `nbrain` | The server's name in clients and the head of its instructions |
| `DATABASE_URL` | | Postgres superuser URL, for ingest and the CLI only |
| `MEMORY_RO_DATABASE_URL`, `MEMORY_WRITER_DATABASE_URL` | | The server's roles; `nbrain init` writes them. Without a writer URL, `remember`, `save` and `skill_save` are off |
| `KEYCHAIN_PREFIX` | | Keep the role passwords and the Workers AI token in the macOS login Keychain instead |
| `MEMORY_MCP_PORT` | `8830` | The server's port on 127.0.0.1 |
| `PUBLIC_URL` | | HTTPS origin for remote clients and OAuth ([connect](connect.md#remote-access)) |
| `OWNER_TAILSCALE_LOGIN` | | The Tailscale login allowed to approve OAuth grants |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Embeddings |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | | Workers AI, for the search judge |
| `LLM_URLS` | `http://127.0.0.1:4000` | OpenAI-compatible endpoints, tried in order |
| `LLM_API_KEY`, `LLM_API_KEY_FILE` | | The key, or a file holding it |
| `MODEL_READING`, `MODEL_CARDS`, `MODEL_EXTRACTION`, `MODEL_CURATOR` | `src/models.ts` | Per-role model, `model` or `model@thinking`: reading (image descriptions), cards (library cards, enrichment), extraction (records), curator (the curator and now) |
| `CONNECTORS` | none | `gmail`, `imessage`, `calendar`, `x`, `omp` |
| `EXECUTOR_MCP_URL` | `http://127.0.0.1:4312/mcp` | Executor's MCP server |
| `OMP_SESSIONS` | `~/.omp/agent/sessions` | omp session files |
| `NOW_ROOTS`, `NOW_DESKS` | | Where now finds repos and desks |
| `BRAIN_NOTIFY` | | The command that sends the Sunday message |
| `YTDLP_BIN`, `XURL_BIN` | `yt-dlp`, `xurl` | Reader binaries |
| `PAGE_READER` | | The rendering page reader |
| `EVAL_QUESTIONS` | `$BRAIN_HOME/eval/memory-v2.json` | The weekly eval's question file |
| `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` | `$BRAIN_HOME/restic-password` | Backups |
| `BACKUP_PATHS`, `BACKUP_HOST` | | More paths to back up; the snapshot's host name |
| `PG_CONTAINER` | `nbrain-postgres-1` in `env.example` | The Postgres container `bin/backup.sh` dumps |
| `BRAIN_CONTEXT`, `BRAIN_LOGS`, `MEMORY_MCP_HOME` | `$BRAIN_HOME/context`, `/logs`, `/memory-mcp` | Move the context repo, logs or token store |

`PG_PORT` goes in the shell that runs `docker compose`.

## Commands

Put `bin/` on your `PATH` to type `nbrain`. `nbrain help` lists them:

| Command | Does |
|---|---|
| `init [--name "Full Name"]` | Env file, folders, context repo, database and roles |
| `doctor` | Checks the database, embeddings and search judge, chat models, connectors, the server and the public door |
| `connect <client>` | Gives a client a token and writes the brain into its config |
| `token list \| add \| revoke` | Agent tokens and OAuth grants |
| `mcp` | The stdio relay for clients that only start local commands |
| `brief --task "…" [--project <name or dir>]` | A brief from memory-mcp, as `NBRAIN_TOKEN` or the token omp was given |
| `save <url \| ->` | Saves a URL, or text from stdin, with `--why`, `--title`, `--project`; `--as research` keeps a research write-up |
| `search <query>` | Searches, with `--source` and `--limit` |
| `skill list \| show \| check` | Skills and styles |
| `now [--dry-run]` | Writes `now.md` now, or only prints it |
| `weekly [--send]` | Prints this week's Sunday message, or sends it |
| `omp` | Reads new omp sessions now |
| `eval [questions.json]` | The retrieval eval |
