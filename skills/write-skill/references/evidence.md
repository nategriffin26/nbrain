# Evidence behind write-skill

Each rule in SKILL.md, the finding behind it, and where to read it. Gathered 2026-10-20.

## Write after the work, from its trace

- **Self-generated skills hurt.** Agents that wrote their own skill pack before a task (with Anthropic's skill-creator, from what they already knew) then solved with it landed below no skills at all: −8.1 (Claude Code + Opus 4.7), −11.3 (Codex + GPT-5.5), −11.5 points (Gemini CLI + Gemini 3.1 Pro). Curated skills added +18.2 to +24.8 on the same setups. Audit: packs never found, authoring displacing the work, confidently wrong content. SkillsBench, https://arxiv.org/pdf/2602.12670 and https://www.skillsbench.ai/blogs/skillsbench-1-1
- **Skills distilled from execution traces help.** Trace2Skill: consolidating patterns from a pool of trajectories (successes and verified failures) gained +17.5 to +21.5 points, +22.8 creating from a weak draft; skills transferred across model sizes and out of domain. A draft from parametric knowledge alone scored about the same as no skill (26.17% vs 27.67%). https://arxiv.org/html/2603.25158v3
- **Corroborated across systems**: AWM (+24.6% / +51.1% relative, beating expert-written workflows by 7.9%) https://arxiv.org/pdf/2409.07429; SkillWeaver (+31.8% / +39.8%) https://arxiv.org/pdf/2504.07079; ReasoningBank (+8.3 WebArena, +4.6 SWE-Bench-Verified) https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- **Failures teach most when the cause is verified.** Trace2Skill's error analysts reproduce and causally explain a failure, and a gate drops patches without a verified cause; this beat single-call insight extraction. https://arxiv.org/html/2603.25158v3

## Compact core, detail in references

- **Length**: compact and standard skills gained +19.0 and +21.5 points; detailed +14.5; comprehensive documentation +0.7. SkillsBench, https://arxiv.org/pdf/2602.12670
- **Count per task**: 1 skill +18.0, 2-3 skills +19.0, 4 or more +10.1. Same source.
- **Spec guidance**: SKILL.md body under 500 lines / 5,000 tokens; supporting files load on demand, and the body should say when to read each. https://agentskills.io/specification and https://agentskills.io/skill-creation/best-practices
- **Concision and freedom levels**: every loaded token competes with the conversation; match freedom to fragility (prose for judgment, templates for preferred patterns, exact scripts for fragile sequences). https://docs.anthropic.com/claude/docs/agents-and-tools/agent-skills/best-practices

## Boundaries and a light path

- 13 of 87 SkillsBench tasks got worse with curated skills; the audit's common cause was one "correct" heavyweight pipeline with no applicability boundaries or lightweight fallback. https://arxiv.org/pdf/2602.12670
- Of 125 skill-induced functional failures, 68.8% came from relevant-looking skills prescribing wrong specifics, only 1.6% from obviously irrelevant ones; 62.6% of efficiency regressions were excessive procedure. https://arxiv.org/html/2608.11888v1
- On real repositories ~80% of 49 public coding skills changed nothing (+1.2 points average at +10.5% tokens); the gains came from a few specialized procedures. https://arxiv.org/html/2603.15401v1 (why: write only what the model would not do on its own)

## Descriptions that trigger

- Anthropic's skill-creator: "Claude has a tendency to undertrigger skills… please make the skill descriptions a little bit pushy." https://github.com/anthropics/claude-plugins-official/blob/main/plugins/skill-creator/skills/skill-creator/SKILL.md
- Retrieval needs the body: BM25 over name + description scored 0 Hit@1 on an 80K-skill pool, 34.7% with the body; the cross-encoder put 91.7% of its attention on the body. https://arxiv.org/html/2603.22455v1 (why the brain indexes whole bodies, and why the body must name the work in plain words)

## Update by merging

- ACE: incremental delta updates beat monolithic rewrites (+10.6% agents, +8.6% finance); one rewrite step collapsed a context from 18,282 to 122 tokens and accuracy from 66.7 to 57.1, below the 63.7 no-adaptation baseline. https://proceedings.iclr.cc/paper_files/paper/2026/file/8a94ff6f922d995d7d3f4ebf4143e442-Paper-Conference.pdf
- Trace2Skill: sequential per-trajectory updates overfit and fragment a library; consolidate prevalent patterns into one skill per domain. https://arxiv.org/html/2603.25158v3

## Exemplars anchor

- Agents copied a template's concrete values verbatim (an API version and protocol) instead of adapting them, fabricated fields and bled concepts across domains. https://arxiv.org/html/2603.15401v1
- Exemplar count has an optimum (about 5-20 for classification) and declines past it; relevance-selected examples beat random ones. https://arxiv.org/html/2509.13196v1 (why: one closest exemplar plus its rules)
- Craft transfers as articulated why plus exact value. Emil Kowalski, Agents with Taste: https://emilkowal.ski/ui/agents-with-taste

## Generated context can cost more than it gives

- LLM-generated repository context files lowered agent success ~3% and raised cost 20%+; developer-written ones gained ~4%. Agents follow loaded instructions, so unnecessary requirements cause the harm. https://arxiv.org/html/2602.11988v1 (why: write nothing a capable agent already does)
