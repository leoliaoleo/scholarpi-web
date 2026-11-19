/**
 * Demo quota: sliding-window counter for requests paid by the shared demo key.
 *
 * Edge Functions are stateless, so the window lives per runtime instance: it is
 * a guard rail against one visitor emptying the account, not an exact ledger.
 * The browser sends a stable X-Pi-Client id so several tabs share one budget.
 */
import { LIMIT_PER_DAY, LIMIT_PER_HOUR, LIMIT_PER_MIN } from "./config.ts";

interface Window {
  events: number[];
}

const buckets = new Map<string, Window>();
const banned = new Map<string, number>();
const DAY_MS = 86_400_000;
const MAX_TRACKED = 5_000;

/** "IP | browser id" — the closest thing to a person a stateless edge sees. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("X-Forwarded-For") || "";
  const ip = fwd.split(",")[0].trim() || req.headers.get("X-Real-IP") || "?";
  const cid = (req.headers.get("X-Pi-Client") || "").slice(0, 40);
  return `${ip}|${cid}`;
}

function prune(now: number): void {
  if (buckets.size <= MAX_TRACKED) return;
  for (const [key, w] of buckets) {
    if (!w.events.length || w.events[w.events.length - 1] < now - DAY_MS) buckets.delete(key);
  }
}

export interface Usage {
  usedMinute: number;
  usedHour: number;
  usedDay: number;
  limitMinute: number;
  limitHour: number;
  limitDay: number;
  remainingHour: number;
}

function stats(times: number[], now: number): Usage {
  const usedMinute = times.filter((t) => now - t < 60_000).length;
  const usedHour = times.filter((t) => now - t < 3_600_000).length;
  return {
    usedMinute,
    usedHour,
    usedDay: times.length,
    limitMinute: LIMIT_PER_MIN,
    limitHour: LIMIT_PER_HOUR,
    limitDay: LIMIT_PER_DAY,
    remainingHour: Math.max(0, LIMIT_PER_HOUR - usedHour),
  };
}

function recent(key: string, now: number): number[] {
  const w = buckets.get(key);
  if (!w) return [];
  const cutoff = now - DAY_MS;
  if (w.events.length && w.events[0] < cutoff) w.events = w.events.filter((t) => t >= cutoff);
  return w.events;
}

function verdict(key: string, now: number): { allowed: boolean; retryAfter: number; usage: Usage; note: string } {
  const usage = stats(recent(key, now), now);
  const until = banned.get(key) || 0;
  if (until > now) return { allowed: false, retryAfter: Math.ceil((until - now) / 1000), usage, note: "已临时限制" };
  const windows: Array<[number, number, string]> = [
    [60_000, LIMIT_PER_MIN, `每分钟 ${LIMIT_PER_MIN} 次`],
    [3_600_000, LIMIT_PER_HOUR, `每小时 ${LIMIT_PER_HOUR} 次`],
    [DAY_MS, LIMIT_PER_DAY, `每天 ${LIMIT_PER_DAY} 次`],
  ];
  for (const [windowMs, cap, label] of windows) {
    const inWindow = recent(key, now).filter((t) => now - t < windowMs);
    if (inWindow.length >= cap) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - inWindow[0])) / 1000)), usage, note: label };
    }
  }
  return { allowed: true, retryAfter: 0, usage, note: "" };
}

/** Record an allowed request (mutates the window) or report why it is blocked. */
export function check(key: string): { allowed: boolean; retryAfter: number; usage: Usage; note: string } {
  const now = Date.now();
  if (!buckets.has(key)) {
    buckets.set(key, { events: [] });
    prune(now);
  }
  const v = verdict(key, now);
  if (v.allowed) buckets.get(key)!.events.push(now);
  return v;
}

/** Same report without consuming quota (used by /health). */
export function peek(key: string): { allowed: boolean; retryAfter: number; usage: Usage; note: string } {
  return verdict(key, Date.now());
}

/** Temporary block, e.g. for oversized prompt fishing. */
export function strike(key: string, seconds = 3600): void {
  banned.set(key, Date.now() + seconds * 1000);
}
