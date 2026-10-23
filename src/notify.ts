// Messages for the owner leave the brain through one command, BRAIN_NOTIFY (env, split into words as a shell would, never
// run through one), with the text on its stdin: the assistant's channel, a push service's CLI or a mail command.
import { spawn } from "node:child_process";

/** Words of a command line: quotes and backslashes as in a shell, nothing expanded. */
function words(command: string): string[] {
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && at + 1 < command.length) word += command[++at];
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\" && at + 1 < command.length) { word += command[++at]; started = true; }
    else if (/\s/.test(char)) { if (started) out.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (quote) throw new Error(`BRAIN_NOTIFY has an unclosed ${quote}`);
  if (started) out.push(word);
  return out;
}

/** Send `text` to the owner: BRAIN_NOTIFY with the text on stdin. Throws with the command's stderr when it fails. */
export async function notify(text: string): Promise<void> {
  const [file, ...args] = words(process.env.BRAIN_NOTIFY ?? "");
  if (!file) throw new Error("BRAIN_NOTIFY is not set: name the command that sends a message to the owner (it reads the text on stdin)");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", code => (code === 0 ? resolve() : reject(new Error(`${file} exited ${code}: ${stderr.trim() || "no error output"}`))));
  child.stdin.on("error", () => undefined); // a command that exits without reading: its exit code says what happened
  child.stdin.end(text);
  await promise;
}
