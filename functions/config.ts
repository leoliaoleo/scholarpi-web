/**
 * Runtime configuration for the ScholarPi Web Sites Function.
 *
 * Only names are read here; Secret values stay inside the platform. A missing
 * DEEPSEEK_API_KEY is not an error: BYOK visitors keep working, and demo
 * visitors get a precise `missing_demo_key` answer (see llm.ts).
 */
declare const Deno: { env: { get(name: string): string | undefined } };

function num(name: string, fallback: number): number {
  const raw = (Deno.env.get(name) || "").trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v > 0 ? v : fallback;
}

function str(name: string, fallback: string): string {
  return (Deno.env.get(name) || "").trim() || fallback;
}

/** Sentinel the browser sends when the visitor brought no key of their own. */
export const DEMO_SENTINELS = new Set(["scholarpi-demo", "demo", "placeholder", "none"]);

export const UPSTREAM = str("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replace(/\/+$/, "");
export const DEFAULT_MODEL = str("SCHOLARPI_MODEL", "deepseek-flash");
export const LIMIT_PER_MIN = num("DEMO_LIMIT_PER_MIN", 6);
export const LIMIT_PER_HOUR = num("DEMO_LIMIT_PER_HOUR", 120);
export const LIMIT_PER_DAY = num("DEMO_LIMIT_PER_DAY", 600);
/** Hard cap on one demo chat request body (roughly 300k chars of prompt). */
export const MAX_BODY_BYTES = num("DEMO_MAX_BODY_BYTES", 1_800_000);
export const RELAY_MAX_BYTES = num("RELAY_MAX_BYTES", 8 * 1024 * 1024);
export const RELAY_TIMEOUT_MS = num("RELAY_TIMEOUT_MS", 40_000);

export function demoKey(): string {
  return (Deno.env.get("DEEPSEEK_API_KEY") || "").trim();
}

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ScholarPiWeb/0.1";
