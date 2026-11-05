---
name: write-style
description: How to capture a look as a style in the owner's brain, so later work can be done "in this style" or follow it by default. A visual style is a design system an agent can build from (Google's DESIGN.md with tokens and the reason for each, component docs with a screenshot per state, blocks, and rules), proven by rebuilding a real screen from it. Use it whenever the owner says "save this look", "make this a style", "make a design system from X", "remember this design", "this is how my UIs should look", "use this style by default", or asks you to capture the visual language of something you built or a product they named. Read it before calling skill_save with kind style. For a process or workflow, use write-skill instead.
metadata:
  kind: skill
  source: nbrain built-in
---

# Write a style

A style is how the owner's things should look. A **visual style** is a small design system: exact values with the reason for each, the components built from them, the sections built from the components, and the rules that hold it together. Agents load it when the owner says "do it in the X style", and the default style when the owner names none.

Values alone are not enough. An agent given only colours and fonts builds a screen that is consistent and still wrong: it reassembles the parts the way the average product does. What makes a screen right is in the judgment behind the values, in how the components behave in each state, and in how they are put together into sections. A style carries all four layers.

A **prose style** (how writing reads, such as an essay voice) has no DESIGN.md; it is a SKILL.md with principles and examples. The rest of this guide is about visual styles.

Example requests:
- "Save this look as a style."
- "Make a design system from Stripe Press so my site reads like it."
- "Add what we figured out about the typography to the grok-bot style."
- "This is how my iPhone apps should look. Make it the default for native apps."

## When not to

- **The look is not settled.** Capture what the owner approved or named, from the real artifact. A style written from taste words before anything exists is a mood board, and models fill mood words with the average.
- **It is a procedure.** How to build, test or ship something is a skill: load `write-skill`.
- **It differs from an existing style in a detail.** Update that style rather than fork it.

## The shape

```
styles/<name>/
  SKILL.md                     entry: when to use it, how to build with it, provenance (short)
  DESIGN.md                    the design system, in Google's DESIGN.md format (github.com/google-labs-code/design.md)
  components/<component>.md    one per component: when to use it, default variant, states, a good and a bad example
  components/<component>/<state>.png   a screenshot of each state
  blocks/<block>.md            a real section made from the components, with its markup and screenshot
  blocks/<block>.png
  screens/<screen>/            the proof: original.png, rebuild.png, the rebuild's source, notes.md
  references/                  extraction output and sources, read only when a value is in doubt
```

**DESIGN.md** is the core, and it follows the open spec exactly: YAML tokens (`colors`, `typography`, `rounded`, `spacing`, `components`) plus prose sections in the spec's order (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts). Inside it:

- **Primitives and semantic tokens in one map.** Raw values (`gray-900: "#18181B"`) and the tokens that say what each is for (`text-primary: "{colors.gray-900}"`). Components reference semantic tokens, never primitives.
- **A reason for every semantic token**, in the section's prose: `- **text-muted** (#71717A): metadata and timestamps; dim enough that the message text leads, still 4.6:1 on the surface.` The reason is what lets an agent handle a case the style did not foresee.
- **Values the spec has no token for** (shadows, motion, dark-mode pairs, blur) go in the prose of their section as exact values. Dark mode: colour tokens with a `-dark` suffix beside their light pair.
- **Rules are the Do's and Don'ts section**: one sentence each with its reason after it. `- Do use one filled button per screen. Why: if everything is important, nothing is.` Write a rule when an agent gets something wrong: what it did, what was wanted, why.
- **Undecided values are marked**: `ask the owner before choosing`. Otherwise an agent fills the gap with a guess and the guess becomes the style.

**Components** document only what exists in the real product. A variant described but never built gets used anyway. Each states file is a screenshot of that state from the real product; where a state cannot be captured there, say so and show the rebuild's state, labelled.

**Blocks** come from real screens: the sections the product keeps rebuilding (a message group, a composer, a book header). Each one names the components it uses, its layout values, its states, and carries its markup. A screen is a stack of blocks; a screen that needs a block the style lacks is a sign to ask before inventing one.

## The bar

1. **Values from the source, not from pixels.** Read them from the code (CSS variables, the theme, the app bundle, computed styles from a headless browser) or from the platform's own published values. A value eyeballed from a screenshot drifts, and drift is the generic default creeping back.
2. **A reason for every choice.** Study the real product (its writing about itself, its designers' talks, how it behaves) and write why. Where the reason is your reading rather than the source's words, say so.
3. **The owner's words, quoted.** What they praised and every correction, verbatim with dates, in the Overview.
4. **Lint clean.** `npx @google/design.md lint DESIGN.md`: no errors. `skill_save` runs the same linter and refuses errors; read its warnings.
5. **Proven by a blind rebuild.** An agent that sees only DESIGN.md (plus the screen's text content) rebuilds one real screen; compare its screenshot with the original side by side and as a pixel diff. Every difference is a gap in the style: fix DESIGN.md, components or blocks, never the rebuild, and rebuild again until the two match. Keep both screenshots in `screens/`.
6. **Compact.** DESIGN.md about 150-400 lines; SKILL.md under 80. Long tables and raw extraction go in `references/`.
7. **`default` only on the owner's word**, with the kind of work named in the description.

## Steps

1. **Check what exists.** `skill_get` with no name. If a style covers this look, read it and go to "Updating".
2. **Extract.** Pull the values automatically from the real product: computed styles and CSS variables from a site, the bundled CSS of an app, the platform's published values for a native system. Save the raw output in `references/`.
3. **Keep the system, drop the accidents.** A value used once is usually an accident; a value used everywhere is the system. Name primitives, then the semantic tokens over them.
4. **Write the reasons.** For each semantic token, component and rule, why the product chose it. Read what its makers wrote; study how it behaves in use.
5. **Document the components** the product actually uses, each with a screenshot per state (default, hover, pressed, focused, disabled, loading, empty, error: the ones that exist).
6. **Name the blocks** from real screens and write each with its markup and screenshot.
7. **Rebuild and compare** (bar 5) until the screenshots match. Note in `screens/<screen>/notes.md` what each round changed in the style.
8. **Lint**, then **save** with `skill_save`: `kind: "style"`, `source`, every file in `files` (`from` a local path when you run on the owner's machine). Use `references/template.md` for SKILL.md, DESIGN.md, component and block files.
9. **Tell the owner** the style's name, its one-line thesis, whether it is the default and for what, the before/after screenshots and the commit.

## Updating

- Read the current style and pass its SKILL.md `digest` as `base`; saves without the current one are refused.
- Merge: change the token, component or rule the new work proved wrong, add the correction with its date, keep the rest. Never regenerate a style from memory: a rewrite drops the corrections that made it the owner's.
- Diff before saving: `npx @google/design.md diff old/DESIGN.md DESIGN.md` shows token-level changes and regressions.
- Replace a screenshot when the look moved.

## Do not

- Write "clean", "modern", "minimal" or "sleek" without values; they mean the default.
- Describe a component or variant the product does not have.
- Copy logos, brand assets or product copy into the style as things to reuse.
- Mix two styles in one piece of work, or load a style for work it is not about.
- Mark a style default because you liked it.

## References

- `references/template.md`: skeletons for SKILL.md, DESIGN.md, a component and a block. Read it at step 8, or before you start your first style.
- `references/evidence.md`: the sources behind each rule. Read it when a rule here seems wrong for your case.
- `examples/ledger/`: a complete small style in this shape, with notes on why each part is there. Do not reuse its values.
