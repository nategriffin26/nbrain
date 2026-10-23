// The library's tools: library finds cards for a plain description within the caller's sources; library_mark records
// what came of using one (memory_writer may set only a card's status columns).
import type * as z from "zod";
import { MCP_TOOLS } from "../mcp/contract.js";
import { type Call, sourcesFor, type Tool } from "../mcp/types.js";
import { findCards } from "./cards.js";
import type { CardKind, CardStatus } from "./types.js";

export const LIBRARY_TOOLS: Record<string, Tool> = {
  library: {
    description: MCP_TOOLS.library.description,
    input: MCP_TOOLS.library.input as z.ZodObject<z.ZodRawShape>,
    scopes: ["work", "life"],
    run: (call: Call, args) => {
      const { query, kind, project, status, limit } = args as { query: string; kind?: CardKind; project?: string; status?: CardStatus; limit?: number };
      const sources = sourcesFor(call.agent);
      return findCards(call.reader, { query, ...(kind ? { kind } : {}), ...(project ? { project } : {}), ...(status ? { status } : {}), ...(limit ? { limit } : {}), ...(sources ? { sources } : {}) });
    },
  },
  library_mark: {
    description: MCP_TOOLS.library_mark.description,
    input: MCP_TOOLS.library_mark.input as z.ZodObject<z.ZodRawShape>,
    scopes: ["write"], write: true,
    run: async (call: Call, args) => {
      const { id, status, note } = args as { id: string; status: CardStatus; note: string };
      const { rowCount } = await call.writer!.query("UPDATE memory.cards SET status = $2, status_note = $3, status_by = $4, status_at = now(), updated_at = now() WHERE id = $1", [id, status, note.replace(/\s+/g, " ").trim(), call.agent.signer]);
      if (rowCount === 0) throw new Error(`No card ${id}. Card ids (card:…) come from library.`);
      return { id, status, note };
    },
  },
};
