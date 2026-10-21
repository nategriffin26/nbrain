// The owner's clock: wall time and day bounds in ZONE, shifting calendar days rather than adding 24 hours across DST.
import { ZONE } from "./config.js";

const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
/** `ms` as ISO wall time in ZONE with its offset: "2026-10-20T23:05:00-05:00". */
export function localTime(ms: number): string {
  const p = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName!.replace("GMT", "") || "+00:00"}`;
}
/** The local day holding `ms`, as its start and the next day's start in UTC ISO. */
export function dayBounds(ms: number): [string, string] {
  const day = localTime(ms).slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return [day, next].map(date => {
    const target = Date.parse(`${date}T00:00:00Z`);
    let midnight = target;
    for (let n = 0; n < 3; n++) midnight += target - Date.parse(`${localTime(midnight).slice(0, 19)}Z`);
    return new Date(midnight).toISOString().replace(".000Z", "Z");
  }) as [string, string];
}

/** A check for local wall-clock slots ("06:45"): true once in each slot's minute, for a loop that ticks every minute. */
export function slots(times: readonly string[]): () => boolean {
  let last = "";
  return () => {
    const now = localTime(Date.now());
    const slot = times.includes(now.slice(11, 16)) ? now.slice(0, 16) : "";
    if (!slot || slot === last) return false;
    last = slot;
    return true;
  };
}
