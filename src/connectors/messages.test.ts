import { describe, expect, it } from "vitest";
import { changedChats } from "./messages.js";

interface Listed { id: number; last_message_at: string | null }

/** Runs the program as Executor does, against a fake Messages app that answers newest first and honours `limit`. */
async function run(start: string, chats: Listed[]) {
  const asked: number[] = [];
  const call = async (_app: string, tool: string, input: { limit: number }) => {
    expect(tool).toBe("list_chats");
    asked.push(input.limit);
    const sorted = [...chats].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
    return { chats: sorted.slice(0, input.limit), possibly_more: sorted.length > input.limit };
  };
  const found = await new (Object.getPrototypeOf(async () => {}).constructor)("call", changedChats(start))(call) as { id: number }[];
  return { ids: found.map(chat => chat.id).sort((a, b) => a - b), asked };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute)).toISOString();
const START = at(30);
/** `n` chats, chat i last active i minutes after 12:00 — so chats 30 and above are within the window. */
const chatsUpTo = (n: number): Listed[] => Array.from({ length: n }, (_, i) => ({ id: i, last_message_at: at(i) }));

describe("changedChats", () => {
  it("asks for a short page, not the whole chat list, when only a few chats changed", async () => {
    const old = Array.from({ length: 200 }, (_, i) => ({ id: 100 + i, last_message_at: at(i % 29) }));
    const { ids, asked } = await run(START, [...old, { id: 1, last_message_at: at(45) }, { id: 2, last_message_at: at(50) }, { id: 3, last_message_at: at(55) }]);
    expect(ids).toEqual([1, 2, 3]);
    expect(Math.max(...asked)).toBe(20);
  });

  it("widens the page until it reaches a chat older than the window", async () => {
    const { ids } = await run(START, chatsUpTo(1748));
    expect(ids).toEqual(Array.from({ length: 1748 - 30 }, (_, i) => i + 30));
  });

  it("includes a chat active exactly at the start and leaves out one a minute earlier", async () => {
    const { ids } = await run(START, chatsUpTo(100));
    expect(ids[0]).toBe(30);
    expect(ids).not.toContain(29);
  });

  it("returns every chat when the whole list is in the window", async () => {
    const { ids } = await run(at(0), chatsUpTo(25));
    expect(ids).toHaveLength(25);
  });

  it("stops at a chat with no last message", async () => {
    const { ids } = await run(START, [...chatsUpTo(60), { id: 900, last_message_at: null }]);
    expect(ids).not.toContain(900);
    expect(ids).toHaveLength(30);
  });

  it("returns nothing when no chat changed", async () => {
    expect((await run(at(59), chatsUpTo(50).slice(0, 40))).ids).toEqual([]);
  });
});
