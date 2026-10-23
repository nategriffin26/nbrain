import { afterEach, expect, it } from "vitest";
import { type Call, embedding, fakeModels, never, notPulled, refused, restoreFetch } from "../testai.js";
import { embed } from "./store.js";

afterEach(restoreFetch);

/** A vector along dimension `at`, scaled to length 3: unit length only if embed() normalizes it. */
const along = (at: number) => Array.from({ length: 1024 }, (_, dim) => dim === at ? 3 : 0);

it("vectors come back unit length, in input order across batches, each chunk sent once", async () => {
  let sent = 0;
  fakeModels(({ body }) => { sent += body.text!.length; return embedding(body.text!, text => along(Number(text.slice(0, 4)))); });
  const texts = Array.from({ length: 40 }, (_, at) => `${String(at).padStart(4, "0")} chunk`);
  const vectors = await embed(texts);
  expect(vectors).toHaveLength(40);
  for (const [at, vector] of vectors.entries()) expect(vector[at]).toBeCloseTo(1, 6);
  expect(sent).toBe(40);
});

it("bug: a query embedding that never answered held its search; it gives up at its deadline", async () => {
  fakeModels(never);
  const started = Date.now();
  await expect(embed(["when is the dentist"], { query: true })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(Date.now() - started).toBeLessThan(8000);
}, 20_000);

it("a query carries the retrieval instruction it was indexed against; a chunk goes verbatim", async () => {
  const sent: string[] = [];
  fakeModels(({ body }: Call) => { sent.push(...body.text!); return embedding(body.text!, () => along(0)); });
  await embed(["when is the dentist"], { query: true });
  await embed(["Dentist on Tuesday"]);
  expect(sent).toEqual([expect.stringMatching(/^Instruct: Given a question .* find the ones that answer it\nQuery: when is the dentist$/), "Dentist on Tuesday"]);
});

it("bug: after one batch failed, the other worker kept its request and kept sending batches; the first failure stops the rest, aborts what is in flight and settles before rejecting", async () => {
  const signals: AbortSignal[] = [];
  const rejected = Promise.withResolvers<void>();
  fakeModels(async ({ body, signal }) => {
    signals.push(signal!);
    if (signals.length === 1) return notPulled;
    // the other would answer, but only once embed has given up
    await rejected.promise;
    return embedding(body.text!);
  });
  // 400 chunks: 25 batches
  const texts = Array.from({ length: 400 }, (_, at) => `${at} chunk`);
  const result = embed(texts);
  result.catch(() => rejected.resolve());
  await expect(result).rejects.toThrow(/404/);
  expect(signals).toHaveLength(2);
  expect(signals[1]!.aborted).toBe(true);
  // the other answering at once: it keeps what it got, and takes no new batch
  signals.length = 0;
  fakeModels(({ body, signal }) => { signals.push(signal!); return signals.length === 1 ? notPulled : embedding(body.text!); });
  await expect(embed(texts)).rejects.toThrow(/404/);
  expect(signals).toHaveLength(2);
});

it("Ollama down or without the model rejects saying which", async () => {
  fakeModels(() => refused);
  await expect(embed(["x"])).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
  fakeModels(() => notPulled);
  await expect(embed(["x"])).rejects.toThrow(/Ollama embed: 404 .*try pulling it first/);
});
