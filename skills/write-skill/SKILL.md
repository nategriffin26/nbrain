---
name: write-skill
description: How to turn work you just finished into a skill in the owner's brain, or improve one that is there. Use it whenever the owner says "add what you learned to the brain", "save this as a skill", "make this repeatable", "remember how we did this", "update the explainer skill", or asks you to capture a process, workflow or way of working from this session. Read it before calling skill_save with kind skill. For a look or visual style, use write-style instead.
metadata:
  kind: skill
  source: nbrain built-in
---

# Write a skill from finished work

A skill tells a future agent how the owner wants one kind of work done. It is worth saving only when it carries what that agent would not get right on its own: the owner's bar, the corrections the owner had to make, the steps that worked, the traps that cost time. Generic know-how is noise: it costs context and changes nothing.

Example requests that mean "use this":
- "Add what you learned building this explainer to the brain."
- "Save how we did the release as a skill so the next agent does it the same way."
- "That review format was right. Make it the way reviews are done."
- "Update the research-brief skill with what went wrong today."
- "Remember how I like PR descriptions written."

## When not to

- **Before the work, or from general knowledge.** Skills a model writes before doing the task score below no skill at all (SkillsBench: −8 to −12 points); a draft written from what the model already knows scores the same as none (Trace2Skill). Write from this session's trace or do not write.
- **The work is not finished or the owner has not accepted it.** Save what was signed off, not what was attempted.
- **It is a one-off.** If the same kind of request is unlikely to come again, a `remember` note is enough.
- **It is a look.** Colours, type, spacing and visual taste go in a style: load `write-style`.
- **A skill already covers it.** Update that one (below) rather than add a near-duplicate; two half-skills for one job split the guidance and both get retrieved worse.

## The bar for a saved skill

1. **Distilled from the real trace.** Every rule traces to something in this session: a request, a correction, a failure, a result. Why: trajectory-grounded skills gain +17 to +23 points; parametric drafts gain nothing.
2. **The owner's words, quoted.** What they asked for and every correction, verbatim with the date, in a "The bar" section. Why: their phrasing carries the taste; your paraphrase drops it.
3. **Rule + why + exact value.** "Keep each step under 300 ms because the owner called slower ones sluggish (2026-10-20)", not "keep it snappy". Why: a rule without its reason gets misapplied at the edges; a rule without a value gets averaged back to the default.
4. **Compact core.** SKILL.md body under ~200 lines, never over 500; put long detail in `references/` and say when to read each file. Why: compact and standard skills gained +19 to +21 points, comprehensive ones +0.7.
5. **Boundaries and a light path.** Say when the skill applies, when it does not, and what to do for a small version of the task. Why: SkillsBench's failing skills all pushed one heavyweight "correct" pipeline onto tasks that needed less.
6. **Pushy description.** What it does, when to use it, and the phrases that should trigger it. Why: agents under-trigger skills; the description is all a host sees when it decides.
7. **Exemplars, not templates to paste.** A finished artifact goes in `examples/` with its craft extract, contrast pairs and a do-not-copy list (see below). Why: agents copy concrete values from examples verbatim, including ones that were right only for that project.
8. **Provenance.** `source` names the project path, session or URL it came from; the body's "Provenance" section lists the files of the finished work.

## Steps

1. **Check what exists.** `skill_get` with no name. If a skill covers this work, read it (`skill_get {"name":"<path>"}`) and go to "Updating".
2. **Gather the trace** before you write a line. From this session, collect:
   - every request and correction from the owner, verbatim, with the date;
   - what worked: the steps, commands, values and files of the accepted result;
   - what failed and why, with the cause you verified (not a guess): failures teach most of the rules;
   - the finished artifact's paths.
3. **Pick the 5-15 rules that would have saved the most time** had a fresh agent known them on turn one. Drop anything a capable agent does unprompted.
4. **Set the freedom per rule.** Judgment calls get prose with the why; preferred patterns get a short template; fragile sequences (exact commands, file formats) get the exact text. Do not script what needs judgment, and do not leave to judgment what broke last time.
5. **Write SKILL.md** following `references/template.md`. Name: lowercase, hyphens, 1-64 characters, the kind of work ("explainer", "release-notes"), not the project.
6. **Add exemplars** when the output is an artifact (a page, a document, a review): one to three in `examples/`, each in the shape of `examples/explainer.md`. Images of the result go in `assets/`.
7. **Save** with `skill_save`: `kind: "skill"`, `source` set, supporting files in `files` (text as `content`, images as `base64`, or `from` a local path if you run on the owner's machine).
8. **Read it back as a stranger.** `skill_get` it and ask: with only this and the request, would a fresh agent produce what the owner accepted, without the corrections they had to make this time? Fix what fails. If you can, run one real request through it.
9. **Tell the owner** the skill's name, what it now says in one line, and the commit, so they can read or revert it.

## Updating

- Read the current skill first and pass its SKILL.md `digest` as `base`. A save without it, or with an old one, is refused.
- Merge, do not rewrite. Keep every rule that still holds, change the ones today's work proved wrong (say what changed and why), add the new ones. A whole rewrite from memory drops rules that took sessions to learn (ACE measured one rewrite collapse 18,282 tokens of context to 122 and accuracy below no context at all).
- A correction from the owner outranks a rule in the skill; record the correction with its date.
- If the body passes ~200 lines, move detail into `references/` rather than cutting rules.

## Exemplars

Each file in `examples/` holds:
- **What it is and where it came from**: the request, the project path, the date, what the owner said about the result.
- **The artifact or a pointer to it** (and screenshots in `assets/` for anything visual).
- **Craft extract**: 5-15 rules it teaches, each with why, where it applies and where it does not.
- **1-3 contrast pairs**: the generic default against what was done, on the same brief.
- **Do not copy**: its content, names, data, copy, brand values, anything true only for that project.

Load one exemplar per task, the closest; more anchor harder without teaching more.

## Do not

- Write rules the model already follows; ~80% of public coding skills change nothing.
- Present one project's values (an API version, a port, a palette) as universal.
- Put secrets, tokens, personal data about other people, or private paths that do not matter into a skill.
- Tell agents to run commands with side effects without saying when not to.
- Stack many skills onto one task: past three, gains drop by half.

## References

- `references/template.md`: the SKILL.md skeleton to fill in. Read it at step 5.
- `references/evidence.md`: the studies behind each rule, with links. Read it when a rule here seems wrong for your case.
- `examples/explainer.md`: a distilled skill with its exemplar, as a worked example of this guide. Read it before your first skill.
