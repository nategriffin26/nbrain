// Gmail through Executor's Gmail app. Instead of a time-window
// query the cursor is Gmail's own history id: each poll lists the messages added since it, reads each (headers and the
// text body) and moves the cursor. The first poll only records where the mailbox is now (start from now).
import type { Pool } from "pg";
import { insertEvent, readCursor, cursorOk, type NewEvent } from "../events/store.js";
import { addresses, guarded, htmlText, tidy } from "./common.js";
import { executorProgram } from "./executor.js";

const SOURCE = "gmail";
// Executor cuts a returned value past 64 KB, so a read program stops adding messages near this size and says where it got to.
const LIMIT = 30_000;
const MAX_TEXT = 20_000;

export interface Listed { historyId: string; ids: string[]; expired?: boolean }
export interface Mail {
  id: string; threadId: string; labels: string[]; internalDate: string; snippet: string;
  headers: Record<string, string>; plain?: string; html?: string;
}

const LIST = (start: string) => `
const out = new Set();
let token, historyId = ${JSON.stringify(start)};
try {
  do {
    const page = await call("gmail", "users.history.list", { path: { userId: "me" }, query: { startHistoryId: ${JSON.stringify(start)}, historyTypes: ["messageAdded"], maxResults: 500, ...(token ? { pageToken: token } : {}) } });
    for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) { const l = a.message.labelIds ?? []; if (!l.includes("DRAFT") && !l.includes("SPAM")) out.add(a.message.id); }
    historyId = page.historyId ?? historyId;
    token = page.nextPageToken;
  } while (token);
} catch (error) {
  if (/\\b404\\b|notFound/i.test(String(error?.message ?? error))) return { historyId: String((await call("gmail", "users.getProfile", { path: { userId: "me" } })).historyId), ids: [], expired: true };
  throw error;
}
return { historyId: String(historyId), ids: [...out] };`;

const READ = (ids: string[]) => `
const mime = (part, type) => { if (!part) return undefined; if (part.mimeType === type && part.body?.data) return part.body.data; for (const c of part.parts ?? []) { const f = mime(c, type); if (f) return f; } };
const ids = ${JSON.stringify(ids)};
const out = [];
let done = 0;
for (const id of ids) {
  done++;
  let m;
  try { m = await call("gmail", "users.messages.get", { path: { userId: "me", id }, query: { format: "full" } }); }
  catch (error) { if (/\\b404\\b|notFound/i.test(String(error?.message ?? error))) continue; throw error; }
  const headers = {};
  for (const h of m.payload?.headers ?? []) { const n = h.name.toLowerCase(); if (["from", "to", "cc", "subject", "date", "list-unsubscribe"].includes(n)) headers[n] = String(h.value ?? "").slice(0, 1000); }
  const plain = mime(m.payload, "text/plain");
  const html = plain ? undefined : mime(m.payload, "text/html");
  out.push({ id: m.id, threadId: m.threadId, labels: m.labelIds ?? [], internalDate: m.internalDate, snippet: m.snippet ?? "", headers, plain: plain?.slice(0, 14000), html: html?.slice(0, 28000) });
  if (JSON.stringify(out).length > ${LIMIT}) break;
}
return { mails: out, done };`;

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The event one mail makes. */
export function mailEvent(mail: Mail): NewEvent {
  const text = mail.plain != null ? decode(mail.plain) : mail.html != null ? htmlText(decode(mail.html)) : mail.snippet;
  const from = mail.headers.from ?? "";
  const sent = mail.labels.includes("SENT");
  const header = `From: ${from}\nTo: ${mail.headers.to ?? ""}${mail.headers.cc ? `\nCc: ${mail.headers.cc}` : ""}`;
  return {
    kind: sent ? "mail.sent" : "mail.received",
    source: SOURCE,
    external_id: mail.id,
    at: Number(mail.internalDate),
    title: (mail.headers.subject || "(no subject)").slice(0, 400),
    body: `${header}\n\n${tidy(text).replace(/https?:\/\/[^\s<>]{80,}/g, "<link>").slice(0, MAX_TEXT)}`,
    url: `https://mail.google.com/mail/u/0/#all/${mail.id}`,
    data: {
      from: addresses(from)[0] ?? from, to: addresses(mail.headers.to ?? ""), cc: addresses(mail.headers.cc ?? ""), threadId: mail.threadId,
      labels: mail.labels, ...(mail.headers["list-unsubscribe"] ? { list_unsubscribe: true } : {}), snippet: mail.snippet,
    },
  };
}

export async function pollGmail(pool: Pool): Promise<void> {
  await guarded(pool, SOURCE, async () => {
    const cursor = await readCursor(pool, SOURCE);
    if (cursor === null) {
      const { historyId } = await executorProgram<{ historyId: string }>(`return { historyId: String((await call("gmail", "users.getProfile", { path: { userId: "me" } })).historyId) };`);
      await cursorOk(pool, SOURCE, historyId);
      return;
    }
    const listed = await executorProgram<Listed>(LIST(cursor));
    if (listed.expired) console.warn("gmail: history cursor expired; restarting from the mailbox's current position");
    for (let at = 0; at < listed.ids.length;) {
      const { mails, done } = await executorProgram<{ mails: Mail[]; done: number }>(READ(listed.ids.slice(at)));
      if (!Array.isArray(mails) || !(done > 0)) throw new Error("Gmail read returned no messages");
      for (const mail of mails) await insertEvent(pool, mailEvent(mail));
      at += done;
    }
    await cursorOk(pool, SOURCE, listed.historyId);
  });
}
