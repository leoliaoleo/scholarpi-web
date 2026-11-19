/** Small response helpers shared by the function routes. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Application errors never leak raw upstream exceptions or env contents. */
export function apiError(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status);
}

/** Read a body with a hard cap, so a hostile upstream cannot exhaust memory. */
export async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array | null; overflow: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), overflow: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: null, overflow: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, overflow: false };
}

export function bearer(req: Request): string {
  const auth = req.headers.get("Authorization")?.trim() || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}
