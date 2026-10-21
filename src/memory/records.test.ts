import { expect, it } from "vitest";
import { messageText, parseExtracted } from "./records.js";

it("reads the model's JSON, with or without a fence, into a record", () => {
  const json = '{"kind":"due","org":"Ascent","amount":176.77,"due_date":"2026-06-05","paid_date":null,"starts_at":null,"ref":null}';
  const expected = { kind: "due", org: "Ascent", amount: 176.77, due_date: "2026-06-05", paid_date: null, starts_at: null, ref: null };
  expect(parseExtracted(json)).toEqual(expected);
  expect(parseExtracted(`\`\`\`json\n${json}\n\`\`\``)).toEqual(expected);
});

it("keeps only what is shaped like a value", () => {
  expect(parseExtracted('{"kind":"paid","org":" ","amount":"$1,456.00","due_date":"soon","paid_date":"2026-02-03","starts_at":"2026-02-05T12:00:00","ref":""}'))
    .toEqual({ kind: "paid", org: null, amount: 1456, due_date: null, paid_date: "2026-02-03", starts_at: "2026-02-05T12:00", ref: null });
});

it("reads none, a refusal and prose as no record", () => {
  expect(parseExtracted('{"kind":"none","org":null,"amount":null,"due_date":null,"paid_date":null,"starts_at":null,"ref":null}')).toBeUndefined();
  expect(parseExtracted("I can't help with that.")).toBeUndefined();
  expect(parseExtracted("{not json}")).toBeUndefined();
});

it("shows the model a mail or text with its local receipt time, sender and capped body", () => {
  const text = messageText({ source: "gmail", at: new Date("2026-02-03T17:17:00Z"), sender: "a@b.com", sender_name: "Acme Bank", title: "Due soon", body: "x".repeat(9000) });
  expect(text.startsWith("Email received 2026-02-03 11:17 (America/Chicago) from Acme Bank.\nSubject: Due soon\n\n")).toBe(true);
  expect(text.length).toBe("Email received 2026-02-03 11:17 (America/Chicago) from Acme Bank.\nSubject: Due soon\n\n".length + 8000);
  expect(messageText({ source: "imessage", at: new Date("2025-11-03T14:45:00Z"), sender: "+15555550123", title: "", body: "hi" }))
    .toBe("Text message received 2025-11-03 08:45 (America/Chicago) from +15555550123.\nSubject: \n\nhi");
});
