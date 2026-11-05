---
version: alpha
name: Ledger
description: A well-kept paper ledger on screen, for anything with money in it.
colors:
  paper-50: "#FBF8F2"
  paper-100: "#F7F3EA"
  paper-200: "#EFE8D8"
  paper-300: "#D9D2C3"
  ink-900: "#1F1B16"
  ink-500: "#6B6358"
  green-700: "#2E6B4F"
  red-700: "#9A3B2E"
  surface: "{colors.paper-100}"
  surface-raised: "{colors.paper-50}"
  row-selected: "{colors.paper-200}"
  rule: "{colors.paper-300}"
  text-primary: "{colors.ink-900}"
  text-muted: "{colors.ink-500}"
  primary: "{colors.ink-900}"
  on-primary: "{colors.paper-100}"
  credit: "{colors.green-700}"
  debit: "{colors.red-700}"
typography:
  title: { fontFamily: Source Serif 4, fontSize: 28px, fontWeight: 600, lineHeight: 34px }
  total: { fontFamily: IBM Plex Sans, fontSize: 20px, fontWeight: 600, lineHeight: 28px, fontFeature: '"tnum" 1' }
  body: { fontFamily: IBM Plex Sans, fontSize: 14px, fontWeight: 400, lineHeight: 20px }
  figure: { fontFamily: IBM Plex Sans, fontSize: 14px, fontWeight: 500, lineHeight: 20px, fontFeature: '"tnum" 1' }
  label: { fontFamily: IBM Plex Sans, fontSize: 12px, fontWeight: 400, lineHeight: 16px }
rounded:
  control: 2px
spacing:
  unit: 4px
  row: 32px
  column-gap: 24px
  page-max: 960px
components:
  table-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    height: 32px
  table-row-hover:
    backgroundColor: "{colors.row-selected}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: 32px
    padding: 12px
---

## Overview

A paper ledger kept with care: the figures are the design, everything else is ruling. For budgets, spending, invoices and statements; not for marketing pages or anything meant to feel light.

- "Like a well-kept paper ledger, not a fintech app." (2026-10-20)
- "No cards. Rules between rows, like a ledger." (2026-10-20) → cards replaced by 1 px rules.
- "The green is too minty. Darker, like ink." (2026-10-20) → credit #2E6B4F.

## Colors

Ink on warm paper; colour appears only where money moves.

- **surface** (#F7F3EA): the page. Why: warm paper reads as a kept book; pure white reads as an app.
- **surface-raised** (#FBF8F2): the totals strip. Why: one step lighter marks the answer without a box.
- **row-selected** (#EFE8D8): hovered or selected row. Why: a pencil-shade, not a highlight colour.
- **rule** (#D9D2C3): 1 px lines between rows. Why: the owner asked for rules, not cards.
- **text-primary** (#1F1B16): ink for text and figures. Why: near-black, warmer than #000 on paper.
- **text-muted** (#6B6358): labels and dates. Why: quiet enough that figures lead; 5.4:1 on surface.
- **primary** (#1F1B16): the one filled button. Why: ink inverted is the strongest mark the page has without adding a colour.
- **credit** (#2E6B4F) and **debit** (#9A3B2E): money in and out, nothing else. Why: colour means money moving; anywhere else it is noise.

## Typography

Source Serif 4 for the page title only, IBM Plex Sans for everything else, tabular figures wherever a number sits in a column. Why: the serif says "book" once; the sans keeps the table quiet; tabular figures keep columns aligned.

## Layout

One column, 960 px max, 4 px unit. Rows 32 px, column gap 24 px, figures right-aligned with the same decimals in a column.

## Elevation & Depth

Flat. No shadows. Hierarchy comes from rules (1 px rule colour, 2 px ink above the totals row) and the one raised strip.

## Shapes

2 px radius on controls only; rows and the page are square. Why: a ledger has no rounded corners.

## Motion

Row background 80 ms ease-out on hover; nothing else moves.

## Components

Table row, totals row and one primary button; see components/ for states.

## Do's and Don'ts

- Do right-align figures with tabular numerals. Why: a ledger is read down columns, and ragged digits break the scan.
- Do separate rows with 1 px rules. Why: the owner rejected cards; boxes break a table into objects.
- Don't use colour except for credit and debit. Why: colour means money moving.
- Do show at most one filled button per page. Why: the page answers one question.
- Don't put a chart above the table unless asked. Why: the totals row is the summary.
- Ask the owner before choosing a style for budgets over limit. Why: not decided yet.
