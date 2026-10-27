// iMessage through Executor's Apple Messages app, ported from Context knowledge/sources/messages.ts. Each poll reads the
// chats with a message since the cursor (five minutes of overlap). Once an hour it reads the last 48 h instead, so a
// reaction or an edit made to a message after it arrived reaches the stored event (insertEvent updates it in place).
import type { Pool } from "pg";
import { cursorOk, insertEvent, readCursor, type NewEvent } from "../events/store.js";
import { guarded } from "./common.js";
import { executorProgram } from "./executor.js";

const SOURCE = "imessage";
const SLACK_MS = 5 * 60_000;
const RESCAN_MS = 48 * 3_600_000;
const RESCAN_EVERY_MS = 3_600_000;
const PAGE = 200;
const FIRST_CHATS = 20;
const WIDEN = 4;
const MAX_CHATS = 10_000; // list_chats' own maximum

export interface Chat { id: number; name: string; is_group: boolean; participants: string[]; identifier: string }
export interface Message {
  id: number; guid: string; created_at: string; text?: string; is_from_me: boolean; sender?: string;
  reactions?: unknown[]; attachments?: unknown[];
}
interface Cursor { after: string; rescanned_at: number }

/** A handle as Context kept it: a phone's last ten digits, an address lowercased. */
const handleOf = (raw: unknown): string => {
  const clean = String(raw ?? "").trim().toLowerCase();
  return clean.includes("@") ? clean : clean.replace(/\D/g, "").slice(-10) || clean;
};

/** The event one message makes; undefined for a message with no text, attachment or reaction. */
export function messageEvent(chat: Chat, message: Message): NewEvent | undefined {
  const text = /^\uFFFC+$/.test(message.text ?? "") ? "" : (message.text ?? "");
  const attachments = message.attachments?.length ?? 0;
  if (text === "" && attachments === 0 && !message.reactions?.length) return undefined;
  const participants = chat.participants.map(handleOf);
  const sender = handleOf(message.sender);
  return {
    kind: message.is_from_me ? "text.sent" : "text.received",
    source: SOURCE,
    external_id: String(message.id),
    at: message.created_at,
    title: chat.name || (chat.is_group ? "Group chat" : sender),
    body: text,
    data: {
      chat_id: chat.id, group: chat.is_group, participants, ...(message.is_from_me ? {} : { from: sender }),
      ...(attachments ? { attachments } : {}), ...(message.reactions?.length ? { reactions: message.reactions } : {}),
    },
  };
}

/**
 * The program that lists the chats with a message since `start`. `list_chats` takes only a limit and answers newest
 * activity first, so it asks for a short page and widens it only while the page's oldest chat is still within the window.
 */
export const changedChats = (start: string) => `
const START = ${JSON.stringify(start)};
for (let limit = ${FIRST_CHATS}; ; limit = Math.min(limit * ${WIDEN}, ${MAX_CHATS})) {
  const listed = await call("apple-messages", "list_chats", { limit });
  const oldest = listed.chats.at(-1);
  if (!listed.possibly_more || limit >= ${MAX_CHATS} || !(oldest?.last_message_at >= START)) {
    return listed.chats.filter(c => c.last_message_at >= START).map(c => ({ id: c.id, name: c.name ?? "", is_group: c.is_group === true, participants: c.participants ?? [], identifier: String(c.identifier ?? "") }));
  }
}`;

async function chatMessages(chat: Chat, start: string, end: string): Promise<Message[]> {
  const out: Message[] = [];
  let until = end;
  for (;;) {
    const page = await executorProgram<Message[]>(`return (await call("apple-messages", "get_history", { chat_id: ${chat.id}, limit: ${PAGE}, start: ${JSON.stringify(start)}, end: ${JSON.stringify(until)} })).messages;`);
    out.push(...page);
    if (page.length < PAGE) return out;
    const oldest = Math.min(...page.map(message => Date.parse(message.created_at)));
    if (!(oldest > Date.parse(start))) return out;
    until = new Date(oldest).toISOString();
  }
}

export async function pollMessages(pool: Pool): Promise<void> {
  await guarded(pool, SOURCE, async () => {
    const now = Date.now();
    const raw = await readCursor(pool, SOURCE);
    if (raw === null) {
      await cursorOk(pool, SOURCE, JSON.stringify({ after: new Date(now).toISOString(), rescanned_at: now } satisfies Cursor));
      return;
    }
    const cursor = JSON.parse(raw) as Cursor;
    const rescan = now - cursor.rescanned_at >= RESCAN_EVERY_MS;
    const start = new Date(rescan ? now - RESCAN_MS : Date.parse(cursor.after) - SLACK_MS).toISOString();
    const end = new Date(now).toISOString();
    const chats = await executorProgram<Chat[]>(changedChats(start));
    for (const chat of chats) {
      for (const message of await chatMessages(chat, start, end)) {
        const event = messageEvent(chat, message);
        if (event) await insertEvent(pool, event, "update");
      }
    }
    await cursorOk(pool, SOURCE, JSON.stringify({ after: end, rescanned_at: rescan ? now : cursor.rescanned_at } satisfies Cursor));
  });
}
