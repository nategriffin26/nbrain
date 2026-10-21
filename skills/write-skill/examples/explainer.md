# Worked example: from a session to an `explainer` skill

An illustration of this guide end to end. The session, project and quotes below are invented to show the shape; the explainer craft rules are real (sources at the end). Read it for the moves, not the content.

## 1. The trace, gathered before writing

- **Asked** (2026-10-20): "Make a page that teaches how the scheduler decides what runs next. Someone new should get it in five minutes."
- **Corrected** (2026-10-20): "Too much text up top. Let me drag a job and see what happens first, explain after."
- **Corrected** (2026-10-20): "The three controls at once is overwhelming. One thing at a time."
- **Worked**: a single draggable queue at the top; each section adds one mechanic (priority, then deadlines, then preemption) with its own small sandbox; a one-question check after each section; final page at `~/Projects/scheduler/docs/explainer/index.html`.
- **Failed**: first version opened with 600 words of background and a combined sandbox with all three mechanics. Cause, verified with the owner's reaction and a re-read: the reader had no question yet when the answer arrived, and three interacting controls hid which one caused what.
- **Accepted** (2026-10-20): "Yes, that's it. This is how explainers should feel."

## 2. The rules that would have saved the most time

Picked from the corrections and the failure, not from what explainers usually say:
1. Open with something to poke, not prose.
2. One mechanic per section, each with its own sandbox.
3. Explain after the reader has seen the effect.
4. A one-question check closes each section.
5. Cut background the reader does not need to use the sandbox.

## 3. The SKILL.md that came out

```markdown
---
name: explainer
description: Build an interactive explainer page that teaches one system by letting the reader poke it before reading about it. Use it when the owner asks to "explain how X works", "make a teaching page", "an explorable", "walk me through X visually", or wants a newcomer to understand a system fast. Not for API reference or setup docs.
metadata:
  kind: skill
  source: ~/Projects/scheduler/docs/explainer (session 2026-10-20)
---

# Explainer

A single page that teaches one system so a newcomer gets it in about five minutes, by doing before reading.

## Use when
- "Make a page that teaches how X works."
- "Explain X so someone new gets it."
- "An explorable / interactive explanation of X."

## Not for
- Reference docs, API pages, setup guides: write those plainly.

## The bar
- "Someone new should get it in five minutes." (2026-10-20)
- "Let me drag a job and see what happens first, explain after." (2026-10-20)
- "One thing at a time." (2026-10-20)

## Steps
1. Open with one interactive thing the reader can change within the first screen, and no more than two sentences above it: the owner rejected a 600-word preamble.
2. One mechanic per section, each with its own small sandbox; combine them only in a final section: three controls at once hid which one caused what.
3. Let the reader see the effect, then explain it in at most three short paragraphs: an answer lands only after the question exists.
4. Close each section with one question the reader answers by using the sandbox.
5. Cut any background the reader does not need to use the next sandbox.

## Light version
For a quick "explain X": one sandbox, one paragraph after it, one check. Skip sections.

## Pitfalls
- Leading with background → nobody reads it → put it after the first interaction or cut it.
- A sandbox with every control → effects blur → one control per mechanic.

## Examples
- `examples/scheduler.md`: the accepted scheduler page, its craft extract and contrasts.

## Provenance
- ~/Projects/scheduler/docs/explainer/index.html, accepted 2026-10-20.
```

52 lines. Every rule traces to a quote, a correction or the failure; nothing in it is generic advice the model would follow anyway.

## 4. The exemplar beside it: `examples/scheduler.md`

```markdown
# Exemplar: the scheduler explainer

- Request: "Make a page that teaches how the scheduler decides what runs next." (2026-10-20)
- Artifact: ~/Projects/scheduler/docs/explainer/index.html; screenshots assets/scheduler-top.png, assets/scheduler-check.png
- Owner's verdict: "Yes, that's it. This is how explainers should feel."

## Craft extract
1. First screen = one draggable queue + one sentence. Why: interaction creates the question the text answers. Applies to any system with visible state; not to concepts with no state to show (write a diagram instead).
2. Sections ordered simplest mechanic first (priority → deadlines → preemption). Why: each builds on the last. Applies when mechanics stack; not when they are independent (order by how often the reader meets them).
3. Each sandbox resets to a state that shows its mechanic in one move. Why: the reader should not have to set up the experiment. Applies everywhere.
4. Text after each sandbox names what the reader just saw, in their terms ("the job you dragged jumped ahead because…"). Why: ties the words to the experience.
5. Check questions are answered by doing, not by picking a sentence. Why: tests the intuition, not reading. Not for pure-fact sections.

## Contrast pairs
- Generic: "Background" section with history of schedulers, then a diagram. This one: a queue to drag, background cut entirely.
- Generic: one sandbox with priority, deadline and preemption toggles. This one: three sandboxes, one control each, then a combined one at the end.

## Do not copy
- The scheduler content, job names, the queue widget's code and its colours: they are this project's.
- The three-section count: the system had three mechanics; yours has its own number.
```

## 5. The save

`skill_save` with `name: "explainer"`, `kind: "skill"`, `source`, the body above, and `files: [{ path: "examples/scheduler.md", content: … }, { path: "assets/scheduler-top.png", from: "/Users/…/top.png" }]`. Then `skill_get {"name":"explainer"}` to read it back, and one line to the owner: "Saved skill explainer (commit abc1234): poke first, one mechanic per section, explain after, check each section."

## Sources for the explainer craft
- Bret Victor, Explorable Explanations: https://worrydream.com/ExplorableExplanations/
- Nicky Case, Explorable Explanations (hook first, one mechanic in isolation, interactivity only where it beats text): https://blog.ncase.me/explorable-explanations/
- Distill, Communicating with Interactive Articles: https://distill.pub/2020/communicating-with-interactive-articles
