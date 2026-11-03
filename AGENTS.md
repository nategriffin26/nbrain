# nbrain: agent notes

- This repo is public: no personal names, data, paths or secrets in code, tests, docs or commit messages. Anything
  personal goes in `$BRAIN_HOME`; a change only one owner wants becomes a setting there, not code here.
- Read README.md and docs/ first. A running brain's own notes (services, doors, secrets' names) are in
  `$BRAIN_HOME/OPERATIONS.md` (default `~/.brain`); read them before touching a live install.
- Tool names and inputs (`src/mcp/contract.ts`) and each tool's scopes (where it is registered: `src/mcp/server.ts`,
  `writes.ts`, `src/library/mcp.ts`, `src/capture/save.ts`, `src/skills/mcp.ts`) are a public contract: connected bots,
  and ChatGPT deep research through `search` and `fetch`, call them by name. Add tools freely; renaming one or changing
  its inputs breaks them.
- Never print secrets: tokens.json stores sha256 only; role passwords live in the env file or the Keychain.
- Never kill processes by pattern: `pkill -f "tsx src/mcp/server.ts"` also matches the live server. Stop a test server
  by its PID or `lsof -tiTCP:<port> -sTCP:LISTEN`.
- Never point tests at the owner's brain: use a throwaway `BRAIN_HOME`, and for the database tests a throwaway Postgres
  cluster (roles are cluster-wide, and schema.sql grants and revokes them), e.g. the same image on another port with
  `POSTGRES_DB=nbrain_t_gate`, then `TEST_DATABASE_URL=postgres://…/nbrain_t_gate`. Without it those tests skip.
- Checks: `npx tsc --noEmit -p tsconfig.json`, `npx vitest run`.

## Decisions

- Conversation history is the source of record and search reads it directly. Don't build an extracted-fact, summary or graph memory layer on the retrieval path: a derived layer over the raw records degrades results, and "add a memory layer" keeps coming back as a proposal.
- Notes store the real time they were written, never a defaulted placeholder. A default destroys same-day ordering and with it any recency-based supersession.
- Notes record who actually said what and to whom. A fact from a conversation where the owner is not the subject is never attributed to the owner, and people with similar names stay separate records.
- Facts tagged private stay out of the life profile and out of every result surfaced into a bot's start-of-task context.
- Newest wins at every read-out: notes, the life profile and the start-of-task summary show the most recently recorded state. A note can supersede or retract an earlier one, and superseded notes drop out of every derived surface. A correction that only sits beside the false note is rejected, because profiles keep showing the stale fact until rebuilt.
- A full pass over the whole message history must finish within two hours; correct but slower is not done. Choose the optimization from measured cost.
- Defects that can feed false or private content into a bot's start-of-task context (attribution, correction and retraction, privacy tagging) outrank search relevance, deduplication and encoding polish.
