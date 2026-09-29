/**
 * IST (Asia/Kolkata) time utilities. NSE sessions are defined in IST.
 * All market-open logic is clock based and cross-checked against the
 * freshness of actual Upstox timestamps.
 */

const IST_TZ = "Asia/Kolkata";

export function istNow(): Date {
  // Anchor the Date to the current UTC instant; IST parts extracted via Intl.
  return new Date();
}

export function istOffsetMinutes(): number {
  return 330; // fixed +05:30, no DST in India
}

export function toIst(date: Date = new Date()): Date {
  return new Date(date.getTime());
}

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0=Sunday
  minutesOfDay: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: false,
  weekday: "short",
});

export function istParts(date: Date = new Date()): IstParts {
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get("minute"), 10);
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute,
    second: parseInt(get("second"), 10),
    dayOfWeek: dowMap[get("weekday")] ?? 0,
    minutesOfDay: hour * 60 + minute,
  };
}

export function istDateString(date: Date = new Date()): string {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function istTimeString(date: Date = new Date()): string {
  const p = istParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}

/** Minutes elapsed since 09:15 IST session open (negative before open). */
export function sessionMinutes(date: Date = new Date()): number {
  return istParts(date).minutesOfDay - (9 * 60 + 15);
}

export const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15
export const SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30

export type MarketPhase =
  | "PRE_OPEN"
  | "OPEN"
  | "CLOSED"
  | "WEEKEND";

export function marketPhase(date: Date = new Date()): MarketPhase {
  const p = istParts(date);
  if (p.dayOfWeek === 0 || p.dayOfWeek === 6) return "WEEKEND";
  const m = p.minutesOfDay;
  if (m >= 540 && m < SESSION_OPEN_MIN) return "PRE_OPEN"; // 09:00-09:15
  if (m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN) return "OPEN";
  return "CLOSED";
}

export type DataStatus = "LIVE" | "RECENT" | "STALE" | "PARTIAL" | "UNAVAILABLE";

/** Classify freshness of an Upstox timestamp (epoch ms) relative to now. */
export function freshnessStatus(tsMs: number | null | undefined, now: number = Date.now()): DataStatus {
  if (!tsMs || tsMs <= 0) return "UNAVAILABLE";
  const ageSec = (now - tsMs) / 1000;
  if (ageSec <= 90) return "LIVE";
  if (ageSec <= 300) return "RECENT";
  if (ageSec <= 24 * 3600) return "STALE";
  return "STALE";
}
