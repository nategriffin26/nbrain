// How a capture is named: its event's external_id, and the memory item that event becomes.
import { chunkBody, sha256 } from "../memory/text.js";

/** The item a capture event becomes. */
export const savedId = (externalId: string) => `saved:${sha256(externalId).slice(0, 16)}`;
/** External id of pasted text or a local file: its content, so saving the same thing twice is one capture. */
export const contentId = (form: "text" | "file", bytes: string | Uint8Array) => `${form}:${sha256(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1")).slice(0, 16)}`;

/** The context line `Saved because: …` for every chunk of `body` (the key writeItems reads), or none without a reason. */
export const whyContexts = (body: string, why: string | null) => why === null ? undefined : new Map(chunkBody(body).map(chunk => [`${chunk.part}:${sha256(chunk.text)}`, `Saved because: ${why}`]));
