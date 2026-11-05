---
name: ledger
description: 'The look of a well-kept paper ledger on screen: warm paper, ink-coloured type, ruled rows, figures that line up. Use it for anything with money in it (budgets, spending, invoices, statements) and when the owner says "in the ledger style" or "like my spending page". Not for marketing pages or playful tools.'
metadata:
  kind: style
  source: ~/Projects/ledger (session 2026-10-20)
---

# Ledger

**Use for** budgets, spending, invoices, statements, any table of money. **Not for** landing pages, games, or anything meant to feel light.

**Thesis:** a paper ledger kept with care: the figures are the design, everything else is ruling.

## Build with it
1. Read DESIGN.md whole: tokens, the reason for each, and the rules in Do's and Don'ts.
2. Build the page from `blocks/month.md`.
3. Match every state in `components/table-row.md`.
4. Use tokens only; a new value needs a reason or a question to the owner.
5. Screenshot at 1440 px with a real month of data and compare with `screens/spending/original.png`.

## Files
- `DESIGN.md`: the system.
- `components/`: table-row.
- `blocks/`: month.
- `screens/spending/`: the accepted page and its blind rebuild.

## Provenance
- ~/Projects/ledger/src/theme.css and /spending, accepted 2026-10-20.
