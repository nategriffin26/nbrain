---
name: write-style
description: How to capture a look the owner approved as a style in their brain, so later work can be done "in this style" or follow it by default. Use it whenever the owner says "save this look", "make this a style", "remember this design", "this is how my UIs should look", "use this style by default", "add this to my styles", or asks you to capture the visual language, design philosophy or feel of something you built together. Read it before calling skill_save with kind style. For a process or workflow, use write-skill instead.
metadata:
  kind: skill
  source: nbrain built-in
---

# Write a style from finished work

A style is how the owner's things should look and feel: a taste thesis, a few principles with their reasons, exact tokens, the defaults to refuse, and real screenshots. Agents load it when the owner says "do it in the X style", and the default style when the owner names none. It works only if it is specific enough that two agents following it would produce work the owner recognises as theirs.

Example requests that mean "use this":
- "Save this look as a style."
- "This is how my dashboards should look. Make it the default."
- "Remember the design of Helm so the next thing matches."
- "Add what we figured out about the typography to the helm style."
- "Capture the feel of this page, I want to reuse it."

## When not to

- **The look is not settled.** Capture what the owner approved, after the work, from the real artifact. A style written from taste words before anything was built is a mood board, and models fill mood words with the average ("clean" and "modern" give the generic default).
- **It is a procedure.** How to build, test or ship something goes in a skill: load `write-skill`.
- **It differs from an existing style in a detail.** Update that style rather than fork it.

## The bar for a saved style

1. **From the real artifact.** Tokens are read from the code (CSS variables, theme file, Tailwind config), not eyeballed from a screenshot; screenshots are of the real rendered thing. Why: a value guessed from pixels drifts, and drift is the generic default creeping back.
2. **The owner's words, quoted.** What they praised and every correction ("less padding", "the grey is too blue"), verbatim with dates. Why: corrections are the taste; they mark exactly where the default was wrong.
3. **A thesis in one line.** The idea every decision serves ("dense and calm: information first, chrome last"). Why: principles conflict at the edges; the thesis settles them.
4. **3-7 principles, each rule + why + value.** More dilutes; practitioners who encode taste well pick two or three to stress per project. Why: a rule with its reason is applied correctly where the rule did not foresee.
5. **Exact tokens, compactly.** Hex with roles, type families with roles and a scale, spacing grid, radii, shadows, motion durations and easing; about 30-60 lines. Why: exact values up front beat iterating away from defaults afterwards; long brand prose does not help.
6. **Named anti-patterns.** The specific generic defaults this style refuses, so an agent can catch itself. Why: a style that only says what to do leaves every unsaid choice at the default.
7. **1-3 screenshots with what to steal.** In `assets/`, each with one line on what to take (rhythm, density, hierarchy) and what not to copy (its content). Why: images carry spacing and hierarchy that tokens cannot; exemplars also get copied verbatim, so say which parts are the lesson.
8. **A plan → build → screenshot-critique checklist.** Why: a screenshot checked against named rules catches drift a model will not notice in code; interaction states and motion need their own pass because one frame cannot show them.
9. **150-400 lines.** The SKILL.md body; longer detail (full component specs, every token) goes in `references/`.
10. **`default` only on the owner's word.** Set it only when they say this style is the one for that kind of work when they name none, and say in the description which kind of work ("UI and dashboards", "slides").

## Steps

1. **Check what exists.** `skill_get` with no name. If a style covers this look, read it and go to "Updating".
2. **Gather the trace.** From this session: the owner's requests and corrections about the look (verbatim, dated); the accepted artifact's paths; the files where its tokens live; the before/after of each correction.
3. **Extract tokens from the code.** Every colour with its role (background, surface, text, muted text, border, accent, danger, focus…), type families and the scale actually used (size / line height / weight), the spacing steps actually used and their base unit, radii, shadows, motion durations and easing. Where the code has a value used once, ask whether it is the system or an accident; keep only the system.
4. **Take 1-3 screenshots** of the accepted result that show the thesis best: the densest real screen, a detail of a component, an empty or error state. Real data, not lorem ipsum. Save them as PNG.
5. **Write the style** following `references/template.md`: identity, thesis, principles, tokens, components and interactions, anti-patterns, visual references, checklist.
6. **Name it** after the look or the project that defined it: `helm`, `quiet-dense`, `print-editorial`. Lowercase, hyphens.
7. **Save** with `skill_save`: `kind: "style"`, `source` (the project path and session), `default: true` only if the owner said so, screenshots in `files` as `base64` or `from` (a local path, when you run on the owner's machine), long specs under `references/`.
8. **Read it back as a stranger.** `skill_get` it and ask: given only this and a new brief, would an agent build something the owner recognises as this style, and avoid the corrections they had to make? If you can, build one small screen with it and compare the screenshot side by side with the reference.
9. **Tell the owner** the style's name, its thesis, whether it is the default and for what, and the commit.

## Updating

- Read the current style and pass its SKILL.md `digest` as `base`; saves without the current one are refused.
- Merge: change the token or principle the new work proved wrong, add the new correction with its date, keep the rest. Never regenerate the whole style from memory: a rewrite drops the corrections that made it the owner's.
- Replace a screenshot when the look moved, and update its "what to steal" line.

## Do not

- Write "clean", "modern", "minimal", "sleek" without values; they mean the default.
- Copy brand assets, logos or product copy into the style as things to reuse.
- Mix two styles in one piece of work, or load a style for work it is not about.
- Mark a style default because you liked it.

## References

- `references/template.md`: the style SKILL.md skeleton with a token block. Read it at step 5.
- `references/evidence.md`: the sources behind each rule. Read it when a rule here seems wrong for your case.
- `examples/ledger.md`: a complete style written with this guide, with notes on why each part is there. Read it before your first style; do not reuse its values.
