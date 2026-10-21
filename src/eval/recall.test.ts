import { expect, it } from "vitest";
import { evalDue } from "./recall.js";

// the test zone is America/Chicago (vitest.config.ts); Oct 25, 2026 is a Sunday, Nov 1 the Sunday DST ends
const at = (local: string) => Date.parse(`${local}-05:00`);

it("runs once on Sunday after 04:00, not again that day and not on weekdays within the week", () => {
  const lastSunday = at("2026-10-18T04:05:00");
  expect(evalDue(lastSunday, at("2026-10-25T03:50:00"))).toBe(false);
  expect(evalDue(lastSunday, at("2026-10-25T04:00:00"))).toBe(true);
  expect(evalDue(at("2026-10-25T04:00:30"), at("2026-10-25T09:00:00"))).toBe(false);
  expect(evalDue(at("2026-10-25T04:00:30"), at("2026-10-29T10:00:00"))).toBe(false);
});

it("catches up the first morning after a missed Sunday, and runs a first time on any morning", () => {
  expect(evalDue(at("2026-10-18T04:05:00"), at("2026-10-27T05:00:00"))).toBe(true);
  expect(evalDue(at("2026-10-18T04:05:00"), at("2026-10-27T02:00:00"))).toBe(false);
  expect(evalDue(undefined, at("2026-10-21T08:00:00"))).toBe(true);
});

it("keeps the Sunday slot across the end of daylight saving time", () => {
  expect(evalDue(at("2026-10-25T04:01:00"), Date.parse("2026-11-01T04:30:00-06:00"))).toBe(true);
  expect(evalDue(Date.parse("2026-11-01T04:31:00-06:00"), Date.parse("2026-11-01T23:30:00-06:00"))).toBe(false);
});
