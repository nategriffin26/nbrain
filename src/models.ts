// The brain's model calls (records extraction, the curator, now.md, capture enrichment, image descriptions) go to an
// OpenAI-compatible chat endpoint: LLM_URLS, tried in order (the next when one can't be reached), with the key in
// LLM_API_KEY or the file LLM_API_KEY_FILE. Each call names its role; the role's model and thinking come from
// brain.model_roles when a row exists, else MODEL_<ROLE> ("model" or "model@thinking"), else the seed.
import { readFileSync } from "node:fs";
import pg from "pg";
import { BRAND } from "./config.js";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const ROLE_SEEDS = {
  reading: { model: "anthropic/claude-haiku-5-5", thinking: "off" },
  // library cards and saved-page enrichment: Haiku skipped 901 of 2,590 bookmarks, so new cards are written on the curator's model
  cards: { model: "anthropic/claude-sonnet-5-5", thinking: "off" },
  extraction: { model: "anthropic/claude-haiku-5-5", thinking: "off" },
  // the curator and now.md judge what the owner's words change in the profile and what is in flight: the notes pass
  // before them got its fixtures right 0 of 3 runs with thinking off, 3 of 3 with low
  curator: { model: "anthropic/claude-sonnet-5-5", thinking: "low" },
} satisfies Record<string, { model: string; thinking: Thinking }>;
export type Role = keyof typeof ROLE_SEEDS;
type Choice = { model: string; thinking: Thinking };

let pool: pg.Pool | undefined;

/** A role's current model and thinking. */
export async function roleChoice(role: Role): Promise<Choice> {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const row = (await pool.query<Choice>("SELECT model, thinking FROM brain.model_roles WHERE role=$1", [role])).rows[0];
  if (row) return row;
  const [model, thinking] = (process.env[`MODEL_${role.toUpperCase()}`] ?? "").split("@");
  return model ? { model, thinking: (thinking as Thinking | undefined) ?? "off" } : ROLE_SEEDS[role];
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Text, or text and images (an `image_url` is an https link or a base64 `data:` URL; the model must take images). */
  content: string | ContentPart[];
}

const gateways = (process.env.LLM_URLS ?? "http://127.0.0.1:4000").split(",").map(url => url.trim()).filter(Boolean);
const apiKey = () => process.env.LLM_API_KEY ?? (process.env.LLM_API_KEY_FILE ? readFileSync(process.env.LLM_API_KEY_FILE, "utf8").trim() : "");

/** One completion on a role's current model; returns the assistant text. `session` keeps one conversation's cache warm on one account. */
export async function complete(input: { role: Role; messages: ChatMessage[]; session?: string; maxTokens?: number }): Promise<string> {
  const { model, thinking } = await roleChoice(input.role);
  const body = JSON.stringify({
    model,
    messages: input.messages,
    max_tokens: input.maxTokens ?? 4096,
    ...(thinking === "off" ? {} : { reasoning_effort: thinking }),
    ...(input.session ? { user: input.session } : {}),
  });
  let lastError: unknown;
  for (const gateway of gateways) {
    let response: Response;
    try {
      response = await fetch(`${gateway}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey()}`,
          "x-omp-app": BRAND,
          ...(input.session ? { "x-session-id": input.session } : {}),
        },
        body,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) throw new Error(`model endpoint ${gateway}: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? "";
  }
  throw lastError;
}

/** The JSON object a model was asked to answer with: the text from the first `{` to the last `}`, or, when the model
 *  wrote more after it (a second object, a remark with braces), the first balanced object. Throws when there is none. */
export function replyJson(reply: string): unknown {
  const start = reply.indexOf("{");
  if (start < 0) throw new Error(`no JSON in the reply: ${reply.slice(0, 120)}`);
  try { return JSON.parse(reply.slice(start, reply.lastIndexOf("}") + 1)); } catch { /* more after the object: take the first */ }
  let depth = 0, quoted = false, escaped = false;
  for (let at = start; at < reply.length; at++) {
    const char = reply[at];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(reply.slice(start, at + 1));
  }
  throw new Error(`unfinished JSON in the reply: ${reply.slice(start, start + 120)}`);
}
