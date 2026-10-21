# SKILL.md skeleton

Fill every section from the session's trace. Delete a section only when it truly has nothing; never pad one. `skill_save` writes the frontmatter from its fields (`name`, `description`, `kind`, `source`, `default`); `body` is everything after it.

## Fields

- **name**: the kind of work, lowercase with hyphens: `explainer`, `release-notes`, `bug-triage`. Not the project (`kino2-explainer`) unless it truly only applies there.
- **description** (1-1024 characters, the only part a host reads before choosing): what it does, then "Use it when…" with the phrases that should trigger it and the kinds of request it covers, then what it is not for. Lean toward over-triggering: hosts under-use skills.
  - Weak: `Guidelines for explainers.`
  - Strong: `Build an interactive explainer page that teaches one system by letting the reader poke it. Use it when the owner asks to "explain how X works", "make a teaching page", "an explorable", "walk me through X visually", or wants a doc that a newcomer can learn from. Not for reference docs or API pages.`
- **source**: where it came from, e.g. `~/Projects/kino2 (session 2026-10-20, explainer for the scheduler)`.

## Body

```markdown
# <Title: the kind of work>

<One paragraph: what this produces and the standard it is held to.>

## Use when
- <request shape 1, in the owner's kind of words>
- <request shape 2>
- <3-5 in all>

## Not for
- <adjacent work it should not be used for, and what to use instead>

## The bar
<The owner's own words, quoted, with dates. Every request and correction that defined "done".>
- "<quote>" (YYYY-MM-DD)

## Steps
1. <rule>: <why>. <exact value, command or file where there is one>.
2. ...
<5-15 rules. Each one would have saved real time in the session it came from.>

## Light version
<What to do when the request is small: the two or three steps that matter, and what to skip.>

## Pitfalls
- <what failed in the trace> → <the verified cause> → <what to do instead>.

## Examples
- `examples/<name>.md`: <what it shows>. Load the closest one, not all.

## References
- `references/<file>.md`: <what it holds>. Read it when <condition>.

## Provenance
- <paths of the finished work, the session, the date the owner accepted it>
```

## Checks before saving

- Under ~200 lines of body (hard limit 500); detail moved to `references/`.
- Every rule has a why; every value that matters is exact.
- Every quote is the owner's verbatim words with a date.
- Nothing in it is something a capable agent does without being told.
- Boundaries and the light version are there.
- Exemplars carry their do-not-copy lists.
