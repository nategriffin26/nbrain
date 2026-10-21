# Style SKILL.md skeleton

Fill every section from the accepted artifact and the owner's words. 150-400 lines of body; detail beyond that goes in `references/` with a line saying when to read it. `skill_save` writes the frontmatter from its fields; `body` is everything below the frontmatter.

## Fields

- **name**: the look, lowercase with hyphens (`helm`, `quiet-dense`).
- **description**: what the style is, the kind of work it is for, and the phrases that should load it. If it is the default, say for what. Example: `The look of Helm: dense, calm, dark-first tools where information leads and chrome recedes. Use it for dashboards, admin tools, CLIs with a UI, and any UI work when the owner names no other style; load it when they say "in the Helm style", "make it look like Helm" or "my usual look".`
- **default**: `true` only when the owner said this is the style for that kind of work when they name none.
- **source**: the project path and session it came from.

## Body

```markdown
# <Style name>

**Use for** <kinds of work>. **Not for** <kinds of work it does not fit, and what to do instead>.

**Thesis:** <one line every decision serves>.

## The bar
- "<owner quote about the look>" (YYYY-MM-DD)
- "<a correction>" (YYYY-MM-DD) → <what changed>

## Principles
1. **<rule>.** <why>. <exact value where there is one>.
2. ...
<3-7. Mark the two or three that matter most.>

## Tokens
Colour (role: hex)
- background: #……  · surface: #……  · surface-raised: #……
- text: #……  · text-muted: #……  · border: #……
- accent: #……  · accent-text: #……  · danger: #……  · focus ring: #……
- <dark/light variants if the style has both>

Type
- families: <ui: …> · <mono: …> · <display: … if any>
- scale (size/line-height/weight): 12/16/400 · 13/20/400 · 15/22/500 · 20/28/600 · …
- numbers: <tabular figures? where>

Space and shape
- base unit <4 or 8> px; steps: 4 · 8 · 12 · 16 · 24 · 32 · 48
- radii: <controls> · <cards> · <pills>
- borders: <width and when> · shadows: <none / exact values and when>
- layout: <max widths, columns, density>

Motion
- durations: <hover 100 ms · enter 150-200 ms · exit ~20% faster> · easing: <cubic-bezier(…)>
- what moves and what never does

## Components and interaction
- <buttons: sizes, primary vs quiet, disabled>
- <inputs, lists, tables, cards, menus: the few that define the look>
- <states: hover, focus (visible ring), active, loading, empty, error: each with its look>
- <copy: tone, casing, numbers and dates>

## Refuse
- <generic default 1, named exactly> → <what this style does instead>
- <default the owner corrected> → <their fix>
<5-10 items>

## Visual references
- `assets/<shot-1>.png`: <what to steal: e.g. the row rhythm, 28 px rows, muted labels>. Do not copy: its data and wording.
- `assets/<shot-2>.png`: …

## Checklist
1. Plan: write the screen's token use and a rough layout before code; check the plan against "Refuse".
2. Build with the tokens above only; a new value needs a reason.
3. Screenshot the real render at the size the owner uses it.
4. Critique the screenshot against named rules: spacing on the grid, type only from the scale, contrast at least 4.5:1 for text, one accent per view, alignment.
5. Exercise the states a screenshot cannot show: hover, focus, loading, empty, error, long and missing data, motion.
6. Fix, re-screenshot, compare side by side with the visual references.

## Provenance
- <artifact paths, session, date accepted>
```

## Checks before saving

- Every token is from the code, with a role.
- Every principle has a why; the thesis fits in one line.
- "Refuse" names concrete defaults, not adjectives.
- Screenshots are of the real artifact, each with what to steal and what not to copy.
- `default` set only on the owner's word, with the kind of work named in the description.
