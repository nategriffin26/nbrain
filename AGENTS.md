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
