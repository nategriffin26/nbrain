# Worked example: the `ledger` style

A complete small style in the layered shape. The project, quotes and values are invented for the illustration, and the screenshots the files name are left out of this example. **Do not reuse its values, palette or name.**

Why each part is there:

- `SKILL.md` is short: when to use the style and the order to read it in. Hosts load it as an Agent Skill; the system itself is in DESIGN.md.
- `DESIGN.md` front matter holds primitives (`paper-100`) and semantic tokens over them (`surface: "{colors.paper-100}"`); components reference only semantic tokens. Each semantic token has its reason in the Colors section, which is what lets an agent decide a case the style did not foresee.
- The owner's corrections are quoted with what changed, because they mark where the default was wrong.
- Motion and the totals rule have no token in the spec, so their exact values are in prose.
- `Do's and Don'ts` holds the rules, one sentence and its reason each, and one value still undecided, so an agent asks instead of guessing.
- `components/table-row.md` documents only the variants that exist, with every state and a bad example: the card-feed default an agent reaches for.
- `blocks/month.md` is the real section the page is made of, with its empty and long-data states and its markup.

The trace it came from: asked 2026-10-20 "A page for my monthly spending. I want it to feel like a well-kept paper ledger, not a fintech app."; two corrections the same day; accepted with "That's the one. Use this for anything with money in it." Tokens read from the project's theme.css. It was saved with `kind: "style"` and `default` unset: "for anything with money in it" belongs in the description, not "the default when no style is named".
