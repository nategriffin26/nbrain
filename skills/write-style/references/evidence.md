# Evidence behind write-style

Each rule in SKILL.md, the finding behind it, and where to read it. Gathered 2026-10-20.

## Rules with reasons and exact values

- Emil Kowalski encodes taste as testable rules, each with its why and an exact value (an element appearing from nowhere starts at scale(0.95), not scale(0); UI animation under 300 ms; exits ~20% faster than entrances), in tables, with a fixed Before/After/Why review format. https://emilkowal.ski/ui/agents-with-taste and https://raw.githubusercontent.com/emilkowalski/skills/HEAD/skills/emil-design-eng/SKILL.md
- "More principles is not better. Pick two or three to focus on for a given project and execute them precisely." https://aridanemartin.dev/blog/design-skills-for-developers/
- "Vague words like clean or modern just give you the average, anchor it to a real reference or exact fonts and hex up front." https://www.reddit.com/r/claude/comments/1uyhw7o/how_do_you_get_claude_to_stop_producing_the_same/

## Tokens, compact

- Google Stitch's DESIGN.md: a plain-markdown manifest the model reads before each generation: palette with exact hex and semantic roles, typography, spacing on a base grid, component styles; tokens, not brand philosophy; kept in git and stale if not maintained. https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/ and https://www.mindstudio.ai/blog/what-is-google-stitch-design-md-file
- Design-system context (components, variables) handed to the agent lets it reuse real values instead of regenerating lookalikes. https://www.figma.com/blog/design-systems-ai-mcp/ (why: read tokens from the code)

## Anti-patterns and the plan-then-critique loop

- Anthropic's frontend-design skill: draft a compact token system and plan first, critique the plan against generic defaults before coding, keep explicit lists of defaults to avoid, and critique screenshots while building ("a picture is worth 1000 tokens"). https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/frontend-design/SKILL.md
- Impeccable ships a curated anti-pattern library telling the model what not to do, and a product brief file. https://bridgers.agency/en/blog/impeccable-ai-design-skill

## Screenshots: what they catch and miss

- Screenshots catch measurable static drift (colour, padding, type scale, alignment, missing elements); they miss hover/focus/active states, motion, below-the-fold content and edge-case data. Work as a loop against named rules (8 pt grid, 4 px line-height multiples, WCAG 4.5:1), with before/after pairs side by side. https://www.digitalapplied.com/blog/screenshot-driven-ui-development-vision-models-2026

## Exemplars anchor and get copied

- Agents copy a template's concrete values verbatim and bleed concepts across domains. https://arxiv.org/html/2603.15401v1
- Model outputs converge (intra- and inter-model mode collapse, "Artificial Hivemind"), so a style must name what makes it not the average. Survey: https://arxiv.org/html/2604.01504v1
- Few, relevant examples beat many: performance peaks at a handful and declines past it. https://arxiv.org/html/2509.13196v1 (why: 1-3 screenshots, each with what to steal)

## Invoked, not always on

- Practitioners reach for style skills case by case; frontend-design, Taste Skill and Impeccable are invoked per task. https://aridanemartin.dev/blog/design-skills-for-developers/
- Always-on context lowers accuracy even at fixed difficulty; one distractor already hurts. https://www.trychroma.com/research/context-rot (why: one style per piece of work, and `default` only where the owner set it)

## Length

- Compact and standard skills gained +19.0 and +21.5 points; comprehensive documentation +0.7. SkillsBench, https://arxiv.org/pdf/2602.12670 (why: 150-400 lines in SKILL.md, the rest in references/)
- Observed taste skills run 8-27 KB with companion files for detail (frontend-design 9.4 KB; emil-design-eng 27 KB plus RECIPES, STANDARDS, AUDIT). Sources above.
