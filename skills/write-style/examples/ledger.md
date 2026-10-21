# Worked example: the `ledger` style

A complete style written with this guide, with notes in the margin (› lines) on why each part is there. The project, quotes and values are invented for the illustration. **Do not reuse its values, palette or name**: they show the level of exactness, not a look to adopt.

## The trace it came from

- Asked (2026-10-20): "A page for my monthly spending. I want it to feel like a well-kept paper ledger, not a fintech app."
- Corrected (2026-10-20): "No cards. Rules between rows, like a ledger."
- Corrected (2026-10-20): "The green is too minty. Darker, like ink."
- Accepted (2026-10-20): "That's the one. Use this for anything with money in it."
- Tokens read from `~/Projects/ledger/src/theme.css`; screenshots of the real page with October's data.

## The style

```markdown
---
name: ledger
description: The look of a well-kept paper ledger on screen: warm paper, ink-coloured type, ruled rows, figures that line up. Use it for anything with money in it (budgets, spending, invoices, statements) and when the owner says "in the ledger style" or "like my spending page". Not for marketing pages or playful tools.
metadata:
  kind: style
  source: ~/Projects/ledger (session 2026-10-20)
---

# Ledger

**Use for** budgets, spending, invoices, statements, any table of money. **Not for** landing pages, games, or anything meant to feel light; use the owner's default style there.

**Thesis:** a paper ledger kept with care: the figures are the design, everything else is ruling.

› One line that settles conflicts: when a choice is unclear, ask whether it makes the figures easier to read.

## The bar
- "Like a well-kept paper ledger, not a fintech app." (2026-10-20)
- "No cards. Rules between rows, like a ledger." (2026-10-20) → cards replaced by 1 px rules
- "The green is too minty. Darker, like ink." (2026-10-20) → credit #2E6B4F

› Corrections are quoted with what changed, because they mark where the default was wrong.

## Principles
1. **Figures line up.** Tabular numerals, right-aligned, same decimals in a column. Why: a ledger is read down columns; ragged digits break the scan.
2. **Rule, don't box.** Rows are separated by 1 px rules (#D9D2C3); no cards, no shadows. Why: the owner rejected cards; boxes fragment a table into objects.
3. **Ink on paper.** Warm paper ground, near-black ink, colour only for credit and debit. Why: colour means money moving; anywhere else it is noise.
4. **Quiet labels, loud totals.** Labels in muted ink at 12 px; totals at 20 px semibold. Why: the eye should land on what the page answers.

› Four principles, each rule + why + a value. The first two matter most for this style.

## Tokens
Colour
- paper: #F7F3EA · paper-raised: #FBF8F2 · rule: #D9D2C3
- ink: #1F1B16 · ink-muted: #6B6358 · focus ring: #1F1B16 at 2 px
- credit: #2E6B4F · debit: #9A3B2E · selected row: #EFE8D8

Type
- families: ui "Source Serif 4" for headings · "IBM Plex Sans" for text · figures "IBM Plex Mono" or tabular-nums
- scale: 12/16/400 labels · 14/20/400 body · 14/20/500 figures · 20/28/600 totals · 28/34/600 page title

Space and shape
- base 4 px; steps 4 · 8 · 12 · 16 · 24 · 40
- rows 32 px; column gap 24 px; page max width 960 px
- radii 2 px on controls only; no shadows

Motion
- hover 80 ms ease-out on row background only; nothing else moves

› About 20 lines: exact hex with roles, a real type scale, a grid. No adjectives.

## Components and interaction
- Table rows: 32 px, rule below, hover = selected-row colour; totals row has a 2 px rule above.
- Buttons: text buttons in ink with underline on hover; one filled button per page (ink on paper inverted).
- Empty month: one line in ink-muted, "No entries for October", no illustration.
- Error: the row turns debit-coloured with the reason inline.

## Refuse
- Cards with rounded corners and shadows → ruled rows.
- Mint or neon greens, red/green traffic-light badges → the two inks above.
- Big charts at the top → the totals row is the summary; charts only on request.
- Inter at every size → the serif/sans/mono split above.
- Gradient headers, emoji icons → nothing.

› Each is a concrete default an agent reaches for, named so it can catch itself.

## Visual references
- `assets/october.png`: steal the row rhythm (32 px, rules, right-aligned figures) and how quiet the labels are. Do not copy: the categories and amounts.
- `assets/empty.png`: steal how little an empty state needs. Do not copy: its wording.

## Checklist
1. Plan the columns and which figure is the answer before code; check against Refuse.
2. Build with the tokens only.
3. Screenshot at 1440 px wide with a real month of data.
4. Check: figures aligned, rules not boxes, colour only on money, text contrast ≥ 4.5:1.
5. Check hover, focus, empty month, a 9-digit amount, a missing category.
6. Fix and compare side by side with assets/october.png.

## Provenance
- ~/Projects/ledger/src/theme.css and /spending, accepted 2026-10-20.
```

› About 90 lines here; a real style runs 150-400 with fuller components. It was saved with `kind: "style"` and `default` left unset: the owner said "for anything with money in it", which belongs in the description, not "the default when no style is named".
