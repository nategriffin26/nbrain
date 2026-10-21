import type { Pool } from "pg";
import { cursorFailed } from "../events/store.js";

/** One connector read. A failed read is recorded on the connector's cursor row and read again at the next schedule. */
export async function guarded(pool: Pool, source: string, read: () => Promise<unknown>): Promise<void> {
  try {
    await read();
  } catch (error) {
    console.error(`connector ${source}:`, error);
    await cursorFailed(pool, source, error);
  }
}

/** Every address in a header ("Sam <sam@x.com>, b@y.com"), lowercased. */
export function addresses(header: string): string[] {
  return [...header.matchAll(/(?:"?[^"<,]*?"?\s*)?<([^<>@\s]+@[^<>\s]+)>|([^\s,<>"']+@[^\s,<>"']+)/g)].map(match => (match[1] ?? match[2] ?? "").toLowerCase()).filter(Boolean);
}

export function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

/** Mail's preheader padding (zero-width and soft-hyphen characters), repeated blanks and runs of empty lines, collapsed. */
export function tidy(text: string): string {
  return text
    .replace(/[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n(?: ?\n)+/g, "\n\n")
    .trim();
}
