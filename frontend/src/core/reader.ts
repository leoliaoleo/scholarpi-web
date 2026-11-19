/**
 * pdf.js service: one PDFDocumentProxy per paper, page text and Zotero-shaped
 * character boxes for quote location, plus PNG rendering for the vision tool.
 *
 * Coordinate contract (identical to the desktop version, see core/text.ts):
 *   char.rect / char.inlineRect : [x1, y1, x2, y2] in PDF user space (y-up)
 *   viewBox                     : page.view = [x0, y0, x1, y1]
 */
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { buildCharIndex, findQuote, getRangeRects, type PdfChar } from "./text";
import { setViewerState, viewerState } from "./viewer-state";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

export interface PageData {
  chars: PdfChar[];
  viewBox: number[];
  /** One entry per PDF text run: what to render as an invisible selectable span. */
  spans: PageSpan[];
}

export interface PageSpan {
  text: string;
  /** Bounding box in PDF user space, y-up. */
  rect: number[];
  /** Inclusive char index range into PageData.chars. */
  start: number;
  end: number;
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();
const pageCache = new Map<string, (PageData | undefined)[]>();
const textCache = new Map<string, string[]>();

export async function loadDoc(key: string, data: ArrayBuffer | Uint8Array): Promise<PDFDocumentProxy> {
  releaseDoc(key);
  const task = pdfjsLib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  });
  const doc = await task.promise;
  docs.set(key, Promise.resolve(doc));
  return doc;
}

export function hasDoc(key: string): boolean {
  return docs.has(key);
}

export async function getDoc(key: string): Promise<PDFDocumentProxy | null> {
  const p = docs.get(key);
  if (!p) return null;
  try {
    return await p;
  } catch (e) {
    console.error("[ScholarPi] PDF 解析失败", e);
    docs.delete(key);
    return null;
  }
}

/** Evict the parsed document + derived caches. `loadDoc` uses this to replace a document. */
function releaseDoc(key: string): void {
  const p = docs.get(key);
  docs.delete(key);
  pageCache.delete(key);
  textCache.delete(key);
  p?.then((doc) => doc.destroy()).catch(() => undefined);
}

/** The paper is gone (removed from the library): tear the reader state down too. */
export function dropDoc(key: string): void {
  releaseDoc(key);
  if (viewerState.paperKey === key) setViewerState({ paperKey: null, pageCount: 0 });
}

async function page(key: string, pageIndex: number): Promise<PDFPageProxy> {
  const doc = await getDoc(key);
  if (!doc) throw new Error("这篇文献没有可用的 PDF（尚未加载或解析失败）");
  if (pageIndex < 0 || pageIndex >= doc.numPages) throw new Error(`页码超出范围（共 ${doc.numPages} 页）`);
  return doc.getPage(pageIndex + 1);
}

export async function getPageCount(key: string): Promise<number> {
  const doc = await getDoc(key);
  return doc ? doc.numPages : 0;
}

/** Raw page proxy for the viewer: it owns the canvas, the scale and the viewport math. */
export function getPage(key: string, pageIndex: number): Promise<PDFPageProxy> {
  return page(key, pageIndex);
}

export async function getPageView(key: string, pageIndex: number): Promise<number[]> {
  const p = await page(key, pageIndex);
  return Array.from((p as any).view as number[]) || [0, 0, p.getViewport({ scale: 1 }).width, p.getViewport({ scale: 1 }).height];
}

export async function getPageData(key: string, pageIndex: number): Promise<PageData> {
  let cache = pageCache.get(key);
  if (!cache) pageCache.set(key, (cache = []));
  const hit = cache[pageIndex];
  if (hit) return hit;
  const p = await page(key, pageIndex);
  const data = await extractPage(p);
  cache[pageIndex] = data;
  return data;
}

/** pdf.js text items → char boxes in PDF user space. */
async function extractPage(p: PDFPageProxy): Promise<PageData> {
  const viewport = p.getViewport({ scale: 1 });
  const view = Array.from((p as any).view as number[]);
  const viewBox = view.length === 4 ? view : [0, 0, viewport.width, viewport.height];
  const { items } = await p.getTextContent();
  const chars: PdfChar[] = [];
  const spans: PageSpan[] = [];

  interface Run {
    first: number;
    last: number;
    x0: number;
    x1: number;
    baseline: number;
    fh: number;
    hasEOL: boolean;
  }
  const runs: Run[] = [];

  for (const it of items as any[]) {
    const str: string = String(it.str ?? "");
    const t: number[] = it.transform || [1, 0, 0, 1, 0, 0];
    const cps = Array.from(str);
    if (!cps.length) continue;
    const fh = Math.hypot(t[2], t[3]) || Math.abs(Number(it.height)) || Math.hypot(t[0], t[1]) || 10;
    const total = Math.abs(Number(it.width)) || fh * cps.length * 0.5;
    const cw = total / cps.length;
    const rad = Math.atan2(t[1], t[0]);
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const nx = -uy;
    const ny = ux;
    const ascent = fh * 0.78;
    const descent = fh * 0.22;
    const angle = Math.round((rad * 180) / Math.PI / 90) * 90;
    const first = chars.length;
    let box: number[] | null = null;
    let x = t[4];
    let y = t[5];
    for (const ch of cps) {
      box = mergeBox(box, boxFor(x, y, x + ux * cw, y + uy * cw, nx, ny, ascent, descent));
      chars.push({
        c: ch,
        u: ch,
        rect: roundRect(boxFor(x, y, x + ux * cw, y + uy * cw, nx, ny, ascent, descent)),
        inlineRect: roundRect(boxFor(t[4], t[5], t[4] + ux * total, t[5] + uy * total, nx, ny, ascent, descent)),
        rotation: angle < 0 ? angle + 360 : angle,
        spaceAfter: ch === " " || ch === "\u00a0",
        ignorable: false,
      });
      x += ux * cw;
      y += uy * cw;
    }
    spans.push({ text: str, rect: roundRect(box as number[]), start: first, end: chars.length - 1 });
    runs.push({ first, last: chars.length - 1, x0: t[4], x1: t[4] + ux * total, baseline: t[5], fh, hasEOL: !!it.hasEOL });
  }

  // Spacing / line breaks between runs (pdf.js splits a line into style runs).
  for (let i = 0; i < runs.length - 1; i++) {
    const a = runs[i];
    const b = runs[i + 1];
    const sameLine = Math.abs(a.baseline - b.baseline) < Math.max(1, a.fh * 0.25);
    const last = chars[a.last];
    if (!last) continue;
    if (sameLine) {
      if (b.x0 - a.x1 > a.fh * 0.18) last.spaceAfter = true;
    } else {
      last.lineBreakAfter = true;
      const step = Math.abs(a.baseline - b.baseline);
      if (step > a.fh * 1.45) last.paragraphBreakAfter = true;
    }
    if (a.hasEOL) last.lineBreakAfter = true;
  }
  const tail = runs[runs.length - 1];
  if (tail && chars[tail.last]) {
    chars[tail.last].lineBreakAfter = true;
    chars[tail.last].paragraphBreakAfter = true;
  }

  return { chars, viewBox, spans };
}

function mergeBox(a: number[] | null, b: number[]): number[] {
  if (!a) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function boxFor(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  nx: number,
  ny: number,
  ascent: number,
  descent: number,
): number[] {
  const pts = [
    [sx + nx * ascent, sy + ny * ascent],
    [sx - nx * descent, sy - ny * descent],
    [ex + nx * ascent, ey + ny * ascent],
    [ex - nx * descent, ey - ny * descent],
  ];
  return [
    Math.min(...pts.map((q) => q[0])),
    Math.min(...pts.map((q) => q[1])),
    Math.max(...pts.map((q) => q[0])),
    Math.max(...pts.map((q) => q[1])),
  ];
}

function roundRect(r: number[]): number[] {
  return r.map((v) => Math.round(v * 1000) / 1000);
}

/** Page text with one line per visual line, for papers without a parsed index. */
export async function getPageText(key: string, pageIndex: number): Promise<string> {
  let cached = textCache.get(key);
  if (cached?.[pageIndex] !== undefined) return cached[pageIndex];
  const { chars } = await getPageData(key, pageIndex);
  let out = "";
  for (const ch of chars) {
    if (ch.ignorable) continue;
    out += ch.u ?? ch.c ?? "";
    if (ch.paragraphBreakAfter) out += "\n\n";
    else if (ch.lineBreakAfter) out += "\n";
    else if (ch.spaceAfter) out += " ";
  }
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cached) textCache.set(key, (cached = []));
  cached[pageIndex] = out;
  return out;
}

export async function getPagesText(key: string): Promise<string[]> {
  const doc = await getDoc(key);
  if (!doc) return [];
  const out: string[] = [];
  for (let i = 0; i < doc.numPages; i++) out.push(await getPageText(key, i));
  return out;
}

/** Locate a verbatim quote on a page; returns char range and line rects. */
export function matchQuote(chars: PdfChar[], quote: string): { start: number; end: number; rects: number[][] } | null {
  const m = findQuote(chars, quote, buildCharIndex(chars));
  if (!m) return null;
  return { start: m[0], end: m[1], rects: getRangeRects(chars, m[0], m[1]).map(roundRect) };
}

// ---------------------------------------------------------------------------
// raster rendering (vision tool + 框图提问)

export interface RenderedImage {
  data: string; // base64, no data: prefix
  mimeType: string;
  dataUrl: string;
  width: number;
  height: number;
  pageIndex: number;
  pageLabel: string;
  /** PDF user-space rect [x1, y1, x2, y2] (y-up) */
  rect: number[];
  pageView: number[];
}

function norm(r: number[]): number[] {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export async function renderRegion(key: string, pageIndex: number, rect?: number[] | null, maxSide = 1600): Promise<RenderedImage> {
  const p = await page(key, pageIndex);
  const view = Array.from((p as any).view as number[]) || [0, 0, p.getViewport({ scale: 1 }).width, p.getViewport({ scale: 1 }).height];
  let r = rect ? norm(rect) : view;
  r = [Math.max(r[0], view[0]), Math.max(r[1], view[1]), Math.min(r[2], view[2]), Math.min(r[3], view[3])];
  const wPt = r[2] - r[0];
  const hPt = r[3] - r[1];
  if (wPt < 2 || hPt < 2) throw new Error("区域太小");
  const scale = Math.max(1, Math.min(4, maxSide / Math.max(wPt, hPt)));

  const full = p.getViewport({ scale });
  const vr = norm(full.convertToViewportRectangle(r));
  const width = Math.max(1, Math.round(vr[2] - vr[0]));
  const height = Math.max(1, Math.round(vr[3] - vr[1]));
  const viewport = p.getViewport({ scale, offsetX: -vr[0], offsetY: -vr[1] });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await (p as any).render({ canvas, canvasContext: ctx, viewport }).promise;

  const mimeType = width * height > 1_200_000 ? "image/jpeg" : "image/png";
  const dataUrl: string = canvas.toDataURL(mimeType, 0.9);
  return {
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    mimeType,
    dataUrl,
    width,
    height,
    pageIndex,
    pageLabel: String(pageIndex + 1),
    rect: r.map((v) => Math.round(v * 1000) / 1000),
    pageView: view,
  };
}

/** Convert a top-left-origin fractional region {x,y,w,h} (0–1) to a PDF rect. */
export function fractionToRect(view: number[], f: { x: number; y: number; w: number; h: number }): number[] {
  const W = view[2] - view[0];
  const H = view[3] - view[1];
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number(v) || 0));
  const x = clamp01(f.x);
  const y = clamp01(f.y);
  const w = Math.max(0.02, Math.min(1 - x, clamp01(f.w) || 1));
  const h = Math.max(0.02, Math.min(1 - y, clamp01(f.h) || 1));
  const x1 = view[0] + x * W;
  const y2 = view[3] - y * H;
  return [x1, y2 - h * H, x1 + w * W, y2];
}
