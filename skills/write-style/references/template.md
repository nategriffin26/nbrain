# Style skeletons

Fill each from the real product and the owner's words. `skill_save` writes SKILL.md's frontmatter from its fields (`name`, `description`, `default`, `source`); `body` is everything below it. Every other file goes in `files`.

## SKILL.md

Fields:
- **name**: the look or the product it comes from, lowercase with hyphens (`grok-bot`, `ledger`).
- **description**: what the style is, the kind of work it is for, and the phrases that should load it; if it is the default, for what. Example: `The look of a well-kept paper ledger on screen. Use it for anything with money in it (budgets, statements); load it when the owner says "in the ledger style". Not for marketing pages.`
- **default**: `true` only when the owner said this is the style for that kind of work when they name none.
- **source**: where it came from (product URL or app and version, project path, session).

Body:

```markdown
# <Style name>

**Use for** <kinds of work>. **Not for** <what it does not fit, and what to use instead>.

**Thesis:** <one line every decision serves>.

## Build with it
1. Read DESIGN.md whole: tokens, the reason for each, and the rules in Do's and Don'ts.
2. Break the screen into blocks from `blocks/`; open each block you use.
3. Open `components/<name>.md` for every component you place, and match its states.
4. Use tokens only. A value not in DESIGN.md needs a reason, or a question to the owner.
5. Screenshot the result at <the size the owner uses> and compare it with `screens/<screen>/original.png` and the block screenshots.

## Files
- `DESIGN.md`: the system.
- `components/`: <component names, comma-separated>.
- `blocks/`: <block names>.
- `screens/<screen>/`: the original and the blind rebuild that proved this style.
- `references/`: <raw extraction, sources, font licences>.

## Provenance
- <source product and version or URL, extraction tool and date, the owner's request with date>
```

## DESIGN.md

Sections in the spec's order; omit one only when the product has nothing for it. Keep tokens in the front matter.

````markdown
---
version: alpha
name: <Name>
description: <one sentence>
colors:
  # primitives: the palette
  gray-0: "#FFFFFF"
  gray-900: "#18181B"
  blue-500: "#3B82F6"
  # semantic: what each value is for; components use only these
  surface: "{colors.gray-0}"
  text-primary: "{colors.gray-900}"
  primary: "{colors.blue-500}"   # the spec requires primary: the colour of the main action
  surface-dark: "#000000"
typography:
  body-md: { fontFamily: <family>, fontSize: 15px, fontWeight: 400, lineHeight: 1.4, letterSpacing: 0em }
rounded:
  control: 8px
  full: 9999px
spacing:
  unit: 4px
  gap-stack: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    height: 36px
    padding: 16px
---

## Overview
<What the product is, who it is for, the feel in concrete terms, and the thesis. The owner's words, quoted with dates.>

## Colors
<The palette's logic in two or three sentences.>
- **surface** (#FFFFFF): <what it is for>. Why: <reason>.
- **text-primary** (#18181B): …
<One line per semantic token. Dark mode: each -dark token beside its light pair.>

## Typography
<Families, where each is used and why; the scale; tabular figures, features, fallbacks and font licences.>

## Layout
<Grid or flow model, max widths, margins, the spacing scale and when each step is used, density.>

## Elevation & Depth
<How hierarchy is shown: shadows with exact values, borders, tonal layers, blur and materials.>

## Shapes
<Radii and where each applies; why.>

## Motion
<Durations and easings with exact values, what moves and what never does. (Not in the spec's list; the linter keeps unknown sections.)>

## Components
<One paragraph per component with its token names and states; details in components/<name>.md.>

## Do's and Don'ts
- Do <rule>. Why: <reason>.
- Don't <rule>. Why: <reason>.
<8-20 rules. Mark values not yet decided: "Ask the owner before choosing X.">
````

Check: `npx @google/design.md lint DESIGN.md` shows 0 errors. Warnings about primitives no component references are expected.

## components/<component>.md

```markdown
# <Component>

<One sentence: what it is for.> Use <other component> instead when <case>.

Default variant: <name>. Variants: <only the ones that exist>.

Tokens: `components.<key>` in DESIGN.md; <anything the token schema cannot hold: border, shadow, icon size, with exact values>.

| State | Looks like | Screenshot |
| --- | --- | --- |
| default | … | `<component>/default.png` |
| hover | … | `<component>/hover.png` |
| pressed | … | … |
| disabled | … | … |
<only states the product has; "(rebuild)" after a screenshot taken from the rebuild because the original could not show it>

Good (from the product):
```html
<real markup or code>
```

Bad: <the generic default an agent reaches for, and why it is wrong here>.
```

## blocks/<block>.md

```markdown
# <Block>

<What this section is and where it appears in the product.>

Components: <list>. Layout: <widths, gaps, alignment, with token names>.
States: <empty, loading, long content, error: how the block holds each>.

![<block>](<block>.png)

```html
<the block's markup, built only from tokens and components>
```
```

## screens/<screen>/notes.md

```markdown
# <Screen>: blind rebuild

Original: `original.png` (<product, version or URL, viewport, date>).
Rebuild: `rebuild.png` from `<source file>`, built by an agent that saw only DESIGN.md and the screen's text.

| Round | Diff | What the rebuild got wrong | What changed in the style |
| --- | --- | --- | --- |
| 1 | <pixel diff %> | … | … |
```
