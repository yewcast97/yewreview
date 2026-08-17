/**
 * Timestamps, as a person reads them.
 *
 * Everything YewReview stores is epoch milliseconds UTC (see `src/db/models.ts`), and everything here
 * renders one in the reader's own zone — which is why nothing in this module formats a date on the
 * server's terms or writes one back. A rendered date is for looking at; the number is the fact.
 */

import { useEffect, useState } from "react";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Rounded because a daylight-saving boundary makes two local midnights 23 or 25 hours apart. */
function calendarDaysBetween(earlier: Date, later: Date): number {
  const midnight = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((midnight(later) - midnight(earlier)) / DAY);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * How long ago an instant was: "just now", "4m", "3h", "yesterday", "Mar 14", and a full
 * "2026-03-14" once the year is not this one.
 *
 * A missing or nonsensical timestamp renders as an empty string. Nothing is invented from one: a row
 * with no readable time says nothing about its time rather than claiming 1 January 1970.
 */
export function formatRelative(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
  const delta = now - epochMs;
  // A small negative delta is clock skew between the browser and whatever wrote the timestamp, not
  // a future event worth its own phrasing.
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;

  const then = new Date(epochMs);
  const current = new Date(now);
  if (calendarDaysBetween(then, current) === 1) return "yesterday";
  // Inside this calendar year a month and day are unambiguous; across a year boundary they are not,
  // so the full date is written. A late-December row then reads as a date in early January, which is
  // wordier and never wrong.
  if (then.getFullYear() === current.getFullYear()) {
    const month = MONTHS[then.getMonth()];
    if (month !== undefined) return `${month} ${then.getDate()}`;
  }
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
}

/**
 * The whole instant, to the minute, in local time: "2026-03-14 09:42".
 *
 * What a `title` on a relative timestamp says. "3h" is what you want to read while scanning and
 * exactly what you do not want when you are auditing when something was written.
 */
export function formatAbsolute(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
  const at = new Date(epochMs);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * A counter that increments on an interval, so relative timestamps go stale in ONE place instead of
 * every component that shows one owning a timer. Read it and ignore the value — depending on it is
 * what schedules the re-render.
 */
export function useTicker(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const id = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return tick;
}
