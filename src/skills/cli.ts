// `brain skills list | show <name> | check <dir>`: the skill library from a terminal.
import { resolve } from "node:path";
import { catalog, checkDir, getSkill } from "./library.js";

export async function skillsCommand(args: string[]): Promise<void> {
  const [verb, target] = args;
  if (verb === "list") {
    const { skills, problems } = await catalog();
    for (const entry of skills) console.log(`${entry.path.padEnd(28)} ${entry.kind.padEnd(5)} ${entry.default ? "default " : ""}${entry.files} file${entry.files === 1 ? "" : "s"}${entry.updated ? ` · ${entry.updated}` : ""}${entry.author ? ` · ${entry.author}` : ""}\n  ${entry.description}`);
    for (const { path, problem } of problems) console.log(`${path.padEnd(28)} INVALID: ${problem}`);
    if (!skills.length && !problems.length) console.log("No skills or styles yet.");
  } else if (verb === "show" && target) {
    const { entry, body, files } = await getSkill(target);
    console.log(`${entry.uri}\n${entry.dir}\n\n${JSON.stringify(entry.frontmatter, null, 2)}\n\n${body.trimEnd()}\n`);
    for (const file of files) console.log(`${file.digest}  ${String(file.size).padStart(9)}  ${file.path}`);
  } else if (verb === "check" && target) {
    const dir = resolve(target);
    const result = await checkDir(dir);
    for (const problem of result.problems) console.log(`problem: ${problem}`);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
    console.log(result.problems.length ? `${dir}: not a valid skill` : `${dir}: ok (${result.frontmatter!.name}, ${result.files} files, ${result.bytes} bytes)`);
    if (result.problems.length) process.exitCode = 1;
  } else {
    console.error("usage: skills list | show <name|path|skill://uri> | check <dir>");
    process.exitCode = 2;
  }
}
