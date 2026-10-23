import { expect, it } from "vitest";
import { parseSince } from "./changes.js";
const now = new Date("2026-11-02T18:00:00Z");
it("uses the owner's midnight, including the DST transition", () => {
  expect(parseSince("yesterday", now).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  expect(parseSince("this morning", now).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  expect(parseSince("2 days ago", now).toISOString()).toBe("2026-10-31T05:00:00.000Z");
  expect(parseSince("2026-11-01", now).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  expect(parseSince("2026-11-01T12:30:00Z", now).toISOString()).toBe("2026-11-01T12:30:00.000Z");
  expect(parseSince(" 2026-11-01T12:30:00Z ", now).toISOString()).toBe("2026-11-01T12:30:00.000Z");
});
it("rejects ambiguous and impossible dates instead of silently rolling them over", () => {
  expect(() => parseSince("last sometime", now)).toThrow();
  expect(() => parseSince("2026-02-30", now)).toThrow();
  expect(() => parseSince("2026-02-30T12:30:00Z", now)).toThrow();
});

it("resolves weekday names to the latest local day, including today and DST", () => {
  expect(parseSince("Monday", now).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  expect(parseSince("Sunday", now).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  expect(parseSince("Tuesday", now).toISOString()).toBe("2026-10-27T05:00:00.000Z");
  expect(parseSince("since Thursday", now).toISOString()).toBe("2026-10-29T05:00:00.000Z");
});
