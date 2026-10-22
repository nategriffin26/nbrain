# Setup

The [quickstart](../README.md#quickstart) gets a brain running in two shells. This page keeps it running and covers every setting.

## Where things live

`BRAIN_HOME` (default `~/.brain`) holds everything personal; the repository holds none of it. Set `BRAIN_HOME` in your shell, not in the env file, to keep a brain elsewhere.

| Path | Holds |
|---|---|
| `env` | Every setting, from [`env.example`](../env.example); `bin/nbrain` and every `bin/run-*.sh` load it |
| `context/` | The context repo: profile files, journal, skills and styles, in git |
| `captures/` | Snapshots of saved pages and PDFs |
| `memory-mcp/` | `tokens.json` (hashes only) and the `DISABLED` kill switch |
| `logs/` | Each job's log, `memory-mcp.log` and `memory-mcp-writes.log` |
| `eval/` | Your eval questions and results |
| `models/` | The reranker model, downloaded on first start |

`nbrain init` is safe to run again: it never overwrites a file or resets a role that exists. The first run writes `env` and stops. The second creates the folders, starts the context repo from `templates/context`, applies the schema and creates the server's two database roles, `memory_ro` and `memory_writer`. Their passwords go into `env`, or into the login Keychain when `KEYCHAIN_PREFIX` is set.

If port 5433 is taken, run `PG_PORT=5444 docker compose up -d` and change `DATABASE_URL` to match.

## Keep it running on macOS

`bin/install-launchd.sh` renders the jobs in `launchd/` into `$BRAIN_HOME/launchd` and links them into `~/Library/LaunchAgents`. Leave out the ones you don't run with `SKIP`. It never loads a job; load each one yourself:

```sh
SKIP="rerank backup" bin/install-launchd.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.brain.memory-mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.brain.ingest.plist
```

| Job | Runs | Log |
|---|---|---|
| `dev.brain.memory-mcp` | The MCP server, kept alive | `memory-mcp.out.log` |
| `dev.brain.ingest` | Connectors and upkeep loops, kept alive | `brain-ingest.log` |
| `dev.brain.rerank` | The reranker, kept alive | `rerank.log` |
| `dev.brain.backup` | `bin/backup.sh` every 6 hours | `backup.log` |

`bin/restart-memory-mcp.sh` restarts the launchd server without dropping a request.

## The reranker

`bin/run-rerank.sh` downloads Qwen3-Reranker-0.6B (Q8_0 GGUF) into `$BRAIN_HOME/models` on first start and serves it with `llama-server` on the port in `RERANK_URL`. Uncomment `RERANK_URL` in the env file when you run it; without it, search keeps the fused order.

## Connectors

Name the ones you want in `CONNECTORS` (for example `CONNECTORS=gmail,imessage,calendar,x,omp`) and restart ingest.

- **Mail, texts, calendar.** Run an [Executor](https://executor.sh) with the `gmail`, `apple-messages` and `apple-calendar` apps connected. Ingest calls its MCP server at `EXECUTOR_MCP_URL` with the CLI key from `~/.executor/v2/cli/keys.json`.
- **X bookmarks.** Install [xurl](https://github.com/xdevplatform/xurl) and sign it in to your account. Each post read costs money on X's API, so only new bookmarks are read, twice a day.
- **Coding sessions.** Reads [omp](https://github.com/can1357/oh-my-pi) sessions from `OMP_SESSIONS`. With `OMP_PROJECT_MEMORY` set, `context_get` adds a project's omp memory when the topic names it.
- **Readers.** `yt-dlp` reads YouTube. For pages that render in JavaScript and for the pages X posts link to, set `TF_PY` to a script that answers `fetch <urls> --json`; without it, thin pages are kept as read and linked pages are skipped.

## Backups

`bin/backup.sh` takes a `pg_dumpall` from the Postgres container (`PG_CONTAINER`), then backs up `$BRAIN_HOME` (without raw Postgres data and models) and the repository to any [restic](https://restic.net) repository in `RESTIC_REPOSITORY`. Add paths with `BACKUP_PATHS` and excludes with `$BRAIN_HOME/backup-excludes`. An append-only restic REST server means this machine cannot delete or change snapshots.

## Linux

The launchd templates, `KEYCHAIN_PREFIX`, `bin/restart-memory-mcp.sh` and the Claude Desktop config path are macOS-only. Run `bin/run-memory-mcp.sh`, `bin/run-ingest.sh` and, if you use it, `bin/run-rerank.sh` under systemd or a shell.

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
| `KEYCHAIN_PREFIX` | | Keep the role passwords in the macOS login Keychain instead |
| `MEMORY_MCP_PORT` | `8830` | The server's port on 127.0.0.1 |
| `PUBLIC_URL` | | HTTPS origin for remote clients and OAuth ([connect](connect.md#remote-access)) |
| `OWNER_TAILSCALE_LOGIN` | | The Tailscale login allowed to approve OAuth grants |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Embeddings |
| `RERANK_URL` | | The reranker; unset skips reranking |
| `LLM_URLS` | `http://127.0.0.1:4000` | OpenAI-compatible endpoints, tried in order |
| `LLM_API_KEY`, `LLM_API_KEY_FILE` | | The key, or a file holding it |
| `MODEL_READING`, `MODEL_EXTRACTION`, `MODEL_NOTES` | `src/models.ts` | Per-role model, `model` or `model@thinking` |
| `CONNECTORS` | none | `gmail`, `imessage`, `calendar`, `x`, `omp` |
| `EXECUTOR_MCP_URL` | `http://127.0.0.1:4312/mcp` | Executor's MCP server |
| `OMP_SESSIONS` | `~/.omp/agent/sessions` | omp session files |
| `OMP_PROJECT_MEMORY` | | omp's per-project memory, for `context_get` |
| `YTDLP_BIN`, `XURL_BIN`, `PYTHON_BIN` | `yt-dlp`, `xurl`, `python3` | Reader binaries |
| `TF_PY` | | The rendering page reader |
| `EVAL_QUESTIONS` | `$BRAIN_HOME/eval/memory-v2.json` | The weekly eval's question file |
| `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` | `$BRAIN_HOME/restic-password` | Backups |
| `BACKUP_PATHS`, `BACKUP_HOST` | | More paths to back up; the snapshot's host name |
| `PG_CONTAINER` | `nbrain-postgres-1` in `env.example` | The Postgres container `bin/backup.sh` dumps |
| `BRAIN_CONTEXT`, `BRAIN_LOGS`, `MEMORY_MCP_HOME` | `$BRAIN_HOME/context`, `/logs`, `/memory-mcp` | Move the context repo, logs or token store |

`PG_PORT` goes in the shell that runs `docker compose`.
