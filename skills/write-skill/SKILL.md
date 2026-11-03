---
name: write-skill
description: Save a skill to the owner's brain, or update one there, from work just finished. Use it whenever the owner says "add what you learned to the brain", "save this as a skill", "make this repeatable", "remember how we did this" or "update the explainer skill", before calling skill_save with kind skill. For a look or visual style, use write-style instead.
metadata:
  kind: skill
  source: nbrain built-in
---

# Save a skill to the brain

The rules for writing any skill (when one is worth writing, the description, the neighbour check, the routing check, the body's bar) live in nstack's `nstack-skills` guide: `skill://nstack-skills` in omp, `~/Projects/nstack/skills/nstack-skills/SKILL.md` on the owner's Mac, or https://github.com/nategriffin26/nstack/blob/master/skills/nstack-skills/SKILL.md. Read it first and follow it. This guide adds what is particular to the brain.

## Steps

1. **Check what exists.** `skill_get` with no name lists the brain's skills and styles. If one covers this work, read it (`skill_get {"name":"<path>"}`) and go to Updating.
2. **Gather the trace** before writing a line: the owner's requests and corrections, verbatim with dates; what worked (steps, commands, values, files of the accepted result); what failed and its verified cause; the finished artifact's paths.
3. **Write SKILL.md** from nstack-skills' template. The brain lists only the description's first sentence, cut at 200 characters, so that sentence names the job on its own.
4. **Add exemplars** when the output is an artifact (a page, a document, a review): one to three in `examples/`, in the shape of `examples/explainer.md`. Images of the result go in `assets/`.
5. **Save** with `skill_save`: `kind: "skill"`, `source` set to the project path, session or URL it came from, supporting files in `files` (text as `content`, images as `base64`, or `from` a local path when you run on the owner's machine). Every save is a signed commit in the context repo, so earlier versions stay in its git history.
6. **Read it back as a stranger.** `skill_get` it and ask: with only this and the request, would a fresh agent produce what the owner accepted, without the corrections they had to make this time? Fix what fails.
7. **Tell the owner** the skill's name, what it now says in one line, and the commit, so they can read or revert it.

## Updating

- Read the current skill first and pass its SKILL.md `digest` as `base`. A save without it, or with an old one, is refused.
- Merge into the body you read: keep every rule that still holds, change the ones today's work proved wrong (say what changed and why), add the new ones.
- A correction from the owner outranks a rule in the skill; record it with its date.

## References

- `examples/explainer.md`: a distilled skill with its exemplar, as a worked example. Read it before your first brain skill.
