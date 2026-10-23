import { expect, it } from "vitest";
import { itemOfEvent } from "./events.js";
import { cleanText, quoteOf } from "./text.js";

it("keeps research captures out of saved pages without changing ordinary save ids", () => {
  const event = { kind: "capture" as const, external_id: "capture-1", at: "2026-01-02T12:00:00Z", title: "Methods", body: "A comparison of methods.", data: { form: "text", as: "research" } };
  expect(itemOfEvent(event)).toMatchObject({ id: "research:0b9dca0066269c42", source: "research", kind: "note" });
  expect(itemOfEvent({ ...event, data: { form: "text" } })).toMatchObject({ id: "saved:0b9dca0066269c42", source: "saved", kind: "page" });
});
it("removes invisible mail padding before indexing and quoting without destroying real joiners", () => {
  const body = "Receipt\u034f \u200c \u200bco\u00adffee\ufeff";
  expect(cleanText(body)).toBe("Receipt  coffee");
  expect(quoteOf(body, ["coffee"], 100)).toBe("Receipt coffee");
  expect(cleanText("👩‍💻 فارسی‌زبان")).toBe("👩‍💻 فارسی‌زبان");
  expect(itemOfEvent({ kind: "mail.received", external_id: "one", at: "2026-01-02T12:00:00Z", body, title: "Receipt", data: {} })?.body).toBe("Receipt  coffee");
});
