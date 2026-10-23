// What every memory-mcp tool is built from: the calling agent and its scopes, the pools it may use, and the tool shape.
// Feature modules (skills, capture) export Tools of this shape; src/mcp/server.ts registers them per connection.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import type * as z from "zod";

export const SCOPES = ["work", "life", "archive", "write"] as const;
export type Scope = (typeof SCOPES)[number];
/** A token's agent: its name in logs, its scopes, and the name its writes are signed with. */
export interface Agent { name: string; scopes: Scope[]; signer: string }
/** A refusal the caller should read (out of scope), not an internal failure. */
export class ScopeError extends Error {}

/** One tool call: who is calling, the read-only pool, the writer pool when writes are on, and whether the caller is on
 *  this machine (TCP loopback, with no forwarding or Tailscale headers): only a local caller may hand the server a path to read. */
export interface Call { agent: Agent; reader: pg.Pool; writer?: pg.Pool; local: boolean }

/** A tool's answer is JSON-encoded text unless it is already MCP content (an image, several parts). */
export interface Tool {
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  scopes: Scope[];
  write?: true;
  run: (call: Call, args: Record<string, unknown>) => Promise<unknown>;
}
export const isContent = (value: unknown): value is CallToolResult => typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content);

export const has = (agent: Agent, scope: Scope) => agent.scopes.includes(scope);

/** What a work-scope caller may search and open: X bookmarks and their articles, the research wiki and research notes,
 *  what agents saved, skills and styles, and the owner's own omp work sessions. Never texts, mail, records, calendar,
 *  bot chats or notes. */
export const WORK_SOURCES = ["x", "wiki", "saved", "research", "skill", "omp"];
/** Sources this agent may search or open; undefined means every source. */
export const sourcesFor = (agent: Agent) => has(agent, "life") || has(agent, "archive") ? undefined : has(agent, "work") ? WORK_SOURCES : [];
