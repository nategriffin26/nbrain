// The models for tests, with no network: fetch answers Ollama's embedding calls and Workers AI's Clef calls in the
// envelopes each sends (recorded; values made up), and fails the ways they do.
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { EMBED_MODEL } from "./memory/store.js";

const ok = (result: unknown) => ({ result, success: true, errors: [], messages: [] });
const unauthorized = { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] };
/** Workers AI's 500. */
export const serverError = { errors: [{ message: "AiError: AiError: Internal server error (00000000-0000-0000-0000-000000000000)", code: 3043 }], success: false, result: {}, messages: [] };
/** Ollama without the model pulled. */
export const notPulled: [number, unknown] = [404, { error: `model "${EMBED_MODEL}" not found, try pulling it first` }];
/** Nothing listening: fetch fails, as it does when Ollama is not running. */
export const refused = "refused";

/** A made-up vector for each text (by default one of its own, from its hash), in Ollama's embedding envelope. */
export function embedding(texts: string[], vector = (text: string) => [...createHash("sha256").update(text).digest()].flatMap(byte => Array<number>(32).fill(byte - 127.5))): [number, unknown] {
  return [200, { model: EMBED_MODEL, embeddings: texts.map(vector), total_duration: 90_000_000, load_duration: 1_000_000, prompt_eval_count: texts.length }];
}

/** Clef's answers, `noul` probabilities by question id. */
export const clef = (probabilities: Record<string, number>): [number, unknown] =>
  [200, ok({ model: "clef", answers: Object.fromEntries(Object.entries(probabilities).map(([id, noul]) => [id, { type: "noul", noul }])), usage: { input_tokens: 140, output_tokens: 0 } })];

/** `model`: the Workers AI model, or Ollama's embedding model with its inputs as `text`. `signal`: the request's own,
 *  aborted when its caller gives up on it. */
export interface Call { model: string; body: { text?: string[]; model?: string; state?: { query: string; results: Record<string, string> }; questions?: Record<string, unknown> }; signal?: AbortSignal }
type Answer = [number, unknown] | typeof refused;

/** An answer that never comes: the request ends only when its caller aborts it. */
export const never = (): Promise<Answer> => Promise.withResolvers<Answer>().promise;

/** Replace fetch with the models answering `answer(call)` as [status, JSON], now or later, or `refused`; a Workers AI
 *  token other than the configured one is refused, and an aborted request rejects with its signal's reason, as fetch
 *  does. Undo with `restoreFetch`. */
export function fakeModels(answer: (call: Call) => Answer | Promise<Answer>): void {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    const hosted = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/test-account\/ai\/run\/(.+)$/.exec(String(url))?.[1];
    const call: Call | undefined = hosted ? { model: hosted, body: sent }
      : String(url) === `${process.env.OLLAMA_URL}/api/embed` ? { model: sent.model, body: { text: sent.input } } : undefined;
    if (!call) throw new TypeError(`fetch failed: no fake for ${String(url)}`);
    const signal = init?.signal ?? undefined;
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    const authorized = !hosted || new Headers(init?.headers).get("authorization") === "Bearer test-token";
    const answered = authorized ? answer({ ...call, ...(signal ? { signal } : {}) }) : [401, unauthorized] as Answer;
    const result = await Promise.race([answered, aborted]);
    if (result === refused) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
    const [status, body] = result;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

export function restoreFetch(): void {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
}
