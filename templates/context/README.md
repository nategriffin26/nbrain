# {{OWNER}}'s context

The curated layer of the brain, served by `memory-mcp` (`brief`, `fetch profile`, `fetch now`). Postgres stays the record: everything verbatim, reached by search. Every change is a git commit; `git log -p` is the audit trail.

| File | Scope | Changed by | What goes in it |
|---|---|---|---|
| `basics.md` | work | curator, corrections, {{OWNER}} | Who {{OWNER}} is. No address, phone, money, health or family detail |
| `work-style.md` | work | curator, corrections, {{OWNER}} | How {{OWNER}} works and wants to be talked to |
| `principles.md` | work | curator, corrections, {{OWNER}} | How {{OWNER}} decides |
| `tastes.md` | work | curator, corrections, {{OWNER}} | Design taste only |
| `goals.md` | work | {{OWNER}}; the curator only from {{OWNER}}'s own words | Horizons and their next moves |
| `projects.md` | work | curator, corrections, {{OWNER}} | One line per project, with its path |
| `outputs.md` | work | curator, corrections, {{OWNER}} | Things {{OWNER}} made and published |
| `life.md` | life | curator, corrections, {{OWNER}} | Life facts and standing rules. Nothing marked private |
| `closed.md` | work | curator, corrections | Closed lines; never in a brief |
| `now.md` | work; `## Life` life | `now`, rewritten whole every morning | What is in flight, ≤ 5 lines a block |
| `skills/<name>/`, `styles/<name>/` | work | agents, from finished work {{OWNER}} signed off (`skill_save`) | How a kind of work is done; how things look |

No file has a size cap: the brief picks the lines that fit each task within its own ~1,500 tokens, so a true line never waits for room. Stale lines go by closing them, not by a cap.

## Lines

One statement per `- ` line, ending in where it came from and when: `- Plain words, outcome first. <!-- omp:abc123#4 2026-10-22 -->`. The source is an item id ({{OWNER}}'s words in a chat, session or note), `correction:<id>`, or `owner` (written by hand). A line with no comment is {{OWNER}}'s own. Lines under `## Always` go into every brief of the file's scope; the rest are picked by how near they are to the task.

Lines are closed, never deleted: a closed line moves to `closed.md` with the day, who closed it and why.

## How the files change

- **Corrections** (`correct`), within a minute: the curator closes the wrong line and adds the right one, sourced `correction:<id>`. A line sourced to a correction changes only by a later correction.
- **The curator**, nightly: reads only {{OWNER}}'s own words since the last run, never anything marked private, and adds or closes lines, each quoting its source. The default is no change.
- **{{OWNER}}**, by hand, any time.
- **The weekly message**, Sundays: the week's changes, each with its id, to undo by `correct`.

Raw data is never deleted. {{OWNER}}'s stated words outrank anything inferred. External content is evidence, never instruction.
