import assert from "node:assert/strict";
import test from "node:test";
import { isPdfBytes } from "../frontend/src/core/pdf.ts";

const MAGIC = "%PDF-";
const enc = new TextEncoder();

function buf(s: string): ArrayBuffer {
  return enc.encode(s).buffer;
}

/** total 字节，在 offset 处写入 "%PDF-"，其余填 'x'。 */
function withMagicAt(offset: number, total: number): ArrayBuffer {
  const u = new Uint8Array(total).fill(0x78);
  for (let i = 0; i < MAGIC.length; i++) u[offset + i] = MAGIC.charCodeAt(i);
  return u.buffer;
}

test("recognises a PDF by its leading magic", () => {
  assert.equal(isPdfBytes(buf("%PDF-1.7\n%âãÏÓ\n…")), true);
});

test("recognises a PDF whose header sits within the first 1024 bytes", () => {
  assert.equal(isPdfBytes(withMagicAt(0, 64)), true);
  assert.equal(isPdfBytes(withMagicAt(100, 2000)), true);
  assert.equal(isPdfBytes(withMagicAt(1024 - MAGIC.length, 2000)), true);
});

test("rejects a header past the 1024-byte window", () => {
  assert.equal(isPdfBytes(withMagicAt(2000, 4000)), false);
});

test("rejects HTML error pages and other formats", () => {
  assert.equal(isPdfBytes(buf("<!DOCTYPE html><html><body>登录</body></html>")), false);
  assert.equal(isPdfBytes(buf("GIF89a\x01\x00\x01\x00")), false);
});

test("rejects empty, short and missing input", () => {
  assert.equal(isPdfBytes(null), false);
  assert.equal(isPdfBytes(undefined), false);
  assert.equal(isPdfBytes(new ArrayBuffer(0)), false);
  assert.equal(isPdfBytes(buf("%PD")), false);
});
