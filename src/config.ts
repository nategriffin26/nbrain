// Whose brain this is and where it lives, from the environment ($BRAIN_HOME/env, loaded by bin/run-*.sh and the CLI).
// Every prompt, tool description and rendered line that names the owner, the assistant or a time zone reads it here, so
// nothing personal lives in the code.
import { homedir } from "node:os";

export const BRAIN_HOME = process.env.BRAIN_HOME ?? `${homedir()}/.brain`;
export const LOGS = process.env.BRAIN_LOGS ?? `${BRAIN_HOME}/logs`;
/** The curated layer: the profile files, now.md, skills/ and styles/ (a git repo). */
export const CONTEXT = process.env.BRAIN_CONTEXT ?? `${BRAIN_HOME}/context`;
/** The owner's wall-clock zone: days, "this morning" and every rendered time are in it. */
export const ZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const [they = "they", them = "them", their = "their"] = (process.env.OWNER_PRONOUNS ?? "they/them/their").split("/").map(word => word.trim());

/** The person the brain is about: `name` in prompts and descriptions ("Alex"), `fullName` where a stranger reads it. */
export const OWNER = {
  name: process.env.OWNER_NAME ?? "the owner",
  fullName: process.env.OWNER_FULL_NAME ?? process.env.OWNER_NAME ?? "the owner",
  they, them, their,
};
/** What the owner calls their assistant ("Juno"): the bots and agents reading the brain. */
export const ASSISTANT = process.env.ASSISTANT_NAME ?? "the assistant";
/** The brain's name where an agent sees it: the MCP server name and the head of its instructions. */
export const BRAND = process.env.BRAIN_NAME ?? "nbrain";

/** The zone's short name now ("CT", "GMT+1"), for "11:05 PM CT". */
export const zoneLabel = (at = new Date()) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" }).formatToParts(at).find(part => part.type === "timeZoneName")?.value ?? ZONE;
  return /^[CEMP][SD]T$/.test(name) ? `${name[0]}T` : name;
};
