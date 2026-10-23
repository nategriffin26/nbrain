// Workers AI on Cloudflare runs Clef, the judge that says which of a search's hits answer its query; each search's query
// and first hits go to Cloudflare in that call. CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN from the env file or
// (KEYCHAIN_PREFIX) the login Keychain.
import type * as z from "zod";

export const workersAiSet = (): boolean => !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_API_TOKEN;

/** One model call's `result`, read through `shape`; a failure names the model, Cloudflare's status and its message.
 *  `signal` ends it: a deadline, or a caller that no longer needs the answer. */
export async function runModel<T>(model: string, body: unknown, signal: AbortSignal, shape: z.ZodType<T>): Promise<T> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Workers AI is not set up: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${model} ${response.status} ${text.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(text);
  return shape.parse(parsed !== null && typeof parsed === "object" && "result" in parsed ? parsed.result : undefined);
}
