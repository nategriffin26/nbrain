// nbrain-brief, an omp extension: on the first prompt of a main session (never a subagent), it asks the brain for a brief
// on that prompt and the session's directory (`nbrain brief`, as the token `nbrain connect omp` gave omp) and adds it to
// the conversation as one message. A brain that does not answer costs one short notice and no message.
// `nbrain connect omp` links this file into ~/.omp/agent/extensions/.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// the checkout this file is linked from
const NBRAIN = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../bin/nbrain");
const TYPE = "nbrain-brief";
const TIMEOUT_MS = 30_000;

function brief(task: string, cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(NBRAIN, ["brief", "--task", task, "--project", cwd], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
    else resolve(stdout.trim());
  });
  return promise;
}

export default function nbrainBrief(pi: ExtensionAPI) {
  // the first prompt and its brief: before_agent_start can run again for the same prompt, and must get the same answer
  let first: { prompt: string; brief: Promise<string | undefined> } | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent?.kind === "sub") return;
    if (!first) {
      // a resumed session already has its brief
      const briefed = ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === TYPE);
      first = {
        prompt: event.prompt,
        brief: briefed ? Promise.resolve(undefined) : brief(event.prompt.slice(0, 2000), ctx.cwd).catch(error => {
          ctx.ui.notify(`No brief from the brain: ${String(error.message).slice(0, 160)}`, "warning");
          return undefined;
        }),
      };
    }
    if (event.prompt !== first.prompt) return;
    const text = await first.brief;
    return text ? { message: { customType: TYPE, content: text, display: false } } : undefined;
  });
}
