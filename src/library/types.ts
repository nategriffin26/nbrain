// The library's shape as its readers see it (the library tool, fetch card:…, the brief, the weekly digest). Cards live in
// memory.cards (schema.sql); library/cards.ts writes and finds them.
import type { CARD_KINDS, CARD_STATUSES } from "../mcp/contract.js";

export type CardKind = (typeof CARD_KINDS)[number];
export type CardStatus = (typeof CARD_STATUSES)[number];

export interface Card {
  id: string;
  item_id: string;
  kind: CardKind;
  /** The item's title: the post, page or note it was read from. */
  title: string;
  source: string;
  what: string;
  why: string;
  craft?: string;
  projects: string[];
  /** The thing itself (a tool's site, the page a post points at), else the item's own url. */
  url?: string;
  status: CardStatus;
  status_note?: string;
  /** Paths under $BRAIN_HOME. */
  screenshot?: string;
  recording?: string;
  at: string;
  strength: "strong" | "weak";
}

/** `sources`: the caller's scope (undefined: every source). Private items never come back. `to`: only items dated before
 *  it (the brief's A/B cuts the record at a past task's start); not a tool input. */
export interface FindCards { query: string; kind?: CardKind; status?: CardStatus; project?: string; limit?: number; sources?: string[]; to?: string }
export interface FoundCards { cards: Card[]; nothing_strong?: true }
