/**
 * Create / update annotations in the browser reader. They live in IndexedDB and
 * are drawn by the pdf.js overlay, so the agent's highlights show up in the PDF
 * exactly like in the desktop plugin (and can be re-opened later).
 */
import { getSettings } from "./config";
import * as db from "./db";
import { globalEvents } from "./events";
import { ensurePdf, getItem, paperKey, type Paper } from "./paper";
import { getDoc, getPageData, matchQuote } from "./reader";
import { viewerState } from "./viewer-state";

const COLORS: Record<string, string> = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  gray: "#aaaaaa",
};

export type AnnotationType = "highlight" | "underline" | "note" | "image";

export interface Annotation {
  key: string;
  libraryID: number;
  itemKey: string;
  type: AnnotationType;
  text: string;
  comment: string;
  color: string;
  pageLabel: string;
  pageIndex: number;
  rects: number[][];
  viewBox: number[];
  sortIndex: string;
  tags: string[];
  dateModified: string;
  /** image annotations keep the rendered crop */
  imageData?: string;
}

export interface AnnotationInfo {
  key: string;
  type: string;
  text: string;
  comment: string;
  color: string;
  page: string;
  pageIndex: number | null;
  tags: string[];
  dateModified: string;
}

export function resolveColor(color?: string): string {
  if (!color) return getSettings().annotationColor || "#a28ae5";
  const c = color.trim().toLowerCase();
  if (COLORS[c]) return COLORS[c];
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  return getSettings().annotationColor || "#a28ae5";
}

function sortIndex(pageIndex: number, charOffset: number, top: number): string {
  return [
    String(pageIndex).slice(0, 5).padStart(5, "0"),
    String(charOffset).slice(0, 6).padStart(6, "0"),
    String(Math.max(0, Math.floor(top))).slice(0, 5).padStart(5, "0"),
  ].join("|");
}

function aiTags(): string[] {
  const tag = getSettings().annotationTag.trim();
  return tag ? [tag] : [];
}

const LOCAL_KEY = /[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}/;

function generateKey(): string {
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// storage

export async function listAnnotations(item: Paper): Promise<Annotation[]> {
  if (!item) return [];
  const rows = await db.getAllByIndex<Annotation>("annotations", "byPaper", db.boundRange([item.libraryID, item.itemKey]));
  return rows.sort((a, b) => String(a.sortIndex).localeCompare(String(b.sortIndex)));
}

export async function getAnnotations(item: Paper): Promise<AnnotationInfo[]> {
  const rows = await listAnnotations(item);
  return rows.map((a) => ({
    key: a.key,
    type: a.type,
    text: a.text,
    comment: a.comment,
    color: a.color,
    page: a.pageLabel,
    pageIndex: a.pageIndex,
    tags: a.tags || [],
    dateModified: a.dateModified,
  }));
}

export async function getAnnotation(key: string): Promise<Annotation | null> {
  const row = await db.get<Annotation>("annotations", key);
  if (!row || !LOCAL_KEY.test(row.key)) return null;
  return row;
}

export async function searchAllAnnotations(query: string, limit: number): Promise<{ ann: Annotation; paper: Paper | null }[]> {
  const q = query.toLowerCase();
  const rows = await db.getAll<Annotation>("annotations");
  const hits = rows
    .filter((a) => !q || `${a.text} ${a.comment}`.toLowerCase().includes(q))
    .slice(0, limit)
    .map((a) => ({ ann: a, paper: getItem({ libraryID: a.libraryID, itemKey: a.itemKey }) }));
  return hits;
}

type NewAnnotation = Omit<Annotation, "libraryID" | "itemKey" | "dateModified"> & {
  itemKey: string;
  libraryID?: number;
};

function toRecord(partial: NewAnnotation): Annotation {
  return {
    libraryID: partial.libraryID || 1,
    itemKey: partial.itemKey,
    key: partial.key,
    type: partial.type,
    text: partial.text || "",
    comment: partial.comment || "",
    color: partial.color,
    pageLabel: partial.pageLabel,
    pageIndex: partial.pageIndex,
    rects: partial.rects,
    viewBox: partial.viewBox,
    sortIndex: partial.sortIndex,
    tags: partial.tags || [],
    dateModified: new Date().toISOString(),
    imageData: partial.imageData,
  };
}

async function save(ann: Annotation): Promise<void> {
  await db.put("annotations", ann);
  globalEvents.emit({
    type: "annotation-created",
    key: ann.key,
    libraryID: ann.libraryID,
    itemKey: ann.itemKey,
    page: ann.pageLabel,
    annotationType: ann.type,
  });
}

// ---------------------------------------------------------------------------
// locating quotes

interface Located {
  item: Paper;
  pageIndex: number;
  start: number;
  end: number;
  rects: number[][];
  viewBox: number[];
  charCount: number;
}

function pageOrder(count: number, hint: number | null): number[] {
  const order: number[] = [];
  if (hint !== null && hint >= 0 && hint < count) {
    order.push(hint);
    for (let d = 1; d < count; d++) {
      if (hint - d >= 0) order.push(hint - d);
      if (hint + d < count) order.push(hint + d);
    }
  } else {
    for (let i = 0; i < count; i++) order.push(i);
  }
  return order;
}

/** Search the PDF's character boxes for a verbatim quote. */
export async function locate(item: Paper, quote: string, page?: number, pageCountHint = 200): Promise<Located> {
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  if (!(await ensurePdf(item))) throw new Error("这篇文献没有可定位原文的 PDF（只有摘要或元数据），高亮与批注需要本地 PDF 文件。");
  const doc = await getDoc(key);
  const count = Math.min(doc?.numPages || 0, pageCountHint);
  const samePaper = viewerState.paperKey === key;
  const hint = typeof page === "number" ? page - 1 : samePaper ? viewerState.currentPage - 1 : null;
  let pagesWithText = 0;
  for (const pageIndex of pageOrder(count, hint)) {
    const data = await getPageData(key, pageIndex);
    if (!data.chars.length) continue;
    pagesWithText++;
    const m = matchQuote(data.chars, quote);
    if (m) {
      return {
        item,
        pageIndex,
        start: m.start,
        end: m.end,
        rects: m.rects,
        viewBox: data.viewBox,
        charCount: data.chars.length,
      };
    }
  }
  if (!pagesWithText) {
    const e = new Error("这篇 PDF 没有文字层（很可能是扫描件或图片版）：无法逐字定位原文，也就无法高亮。请先做 OCR，或改用 arXiv 上的文字版 PDF。") as Error & { noTextLayer?: boolean };
    e.noTextLayer = true;
    throw e;
  }
  throw new Error(
    "在 PDF 中没有找到这段原文。请使用 paper_read / paper_search 返回的原文逐字复制（单页内的一句或几句话），不要改写或翻译。",
  );
}

export interface CreatedAnnotation {
  key: string;
  pageLabel: string;
  pageIndex: number;
  text: string;
  itemKey: string;
}

export async function createHighlight(
  item: Paper,
  opts: { quote: string; page?: number; comment?: string; color?: string; type?: "highlight" | "underline" },
): Promise<CreatedAnnotation> {
  const loc = await locate(item, opts.quote, opts.page);
  const top = loc.rects.reduce((m, r) => Math.max(m, r[3]), -Infinity);
  const pageHeight = loc.viewBox[3] - loc.viewBox[1];
  const text = opts.quote.trim();
  const ann = toRecord({
    key: generateKey(),
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    type: opts.type === "underline" ? "underline" : "highlight",
    text,
    comment: opts.comment || "",
    color: resolveColor(opts.color),
    pageLabel: String(loc.pageIndex + 1),
    pageIndex: loc.pageIndex,
    rects: loc.rects,
    viewBox: loc.viewBox,
    sortIndex: sortIndex(loc.pageIndex, loc.start, pageHeight - top),
    tags: aiTags(),
  });
  await save(ann);
  return { key: ann.key, pageLabel: ann.pageLabel, pageIndex: loc.pageIndex, text, itemKey: item.itemKey };
}

export async function createNoteAnnotation(
  item: Paper,
  opts: { comment: string; page?: number; nearText?: string; color?: string },
): Promise<CreatedAnnotation> {
  let pageIndex: number;
  let rects: number[][];
  let viewBox: number[];
  let offset = 0;
  if (opts.nearText) {
    const loc = await locate(item, opts.nearText, opts.page);
    pageIndex = loc.pageIndex;
    viewBox = loc.viewBox;
    offset = loc.start;
    const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
    const { chars } = await getPageData(key, pageIndex);
    const r = loc.rects[0];
    const size = 22;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const ch of chars) {
      minX = Math.min(minX, ch.rect[0], ch.rect[2]);
      maxX = Math.max(maxX, ch.rect[0], ch.rect[2]);
    }
    const mid = (viewBox[0] + viewBox[2]) / 2;
    const x = r[0] < mid ? Math.max(viewBox[0] + 2, minX - size - 4) : Math.min(viewBox[2] - size - 2, maxX + 4);
    rects = [[x, r[3] - size, x + size, r[3]]];
  } else {
    const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
    if (!(await ensurePdf(item))) throw new Error("这篇文献没有可用的 PDF");
    const doc = await getDoc(key);
    const count = doc?.numPages || 1;
    pageIndex = Math.min(Math.max((opts.page ?? 1) - 1, 0), count - 1);
    viewBox = (await getPageData(key, pageIndex)).viewBox;
    rects = [[viewBox[0] + 12, viewBox[3] - 34, viewBox[0] + 34, viewBox[3] - 12]];
  }
  const size = viewBox[3] - viewBox[1];
  const ann = toRecord({
    key: generateKey(),
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    type: "note",
    text: "",
    comment: opts.comment,
    color: resolveColor(opts.color),
    pageLabel: String(pageIndex + 1),
    pageIndex,
    rects: rects.map((r) => r.map((v) => Math.round(v * 1000) / 1000)),
    viewBox,
    sortIndex: sortIndex(pageIndex, offset, size - rects[0][3]),
    tags: aiTags(),
  });
  await save(ann);
  return { key: ann.key, pageLabel: ann.pageLabel, pageIndex, text: "", itemKey: item.itemKey };
}

export async function createImageAnnotation(
  item: Paper,
  img: { pageIndex: number; pageLabel: string; rect: number[]; dataUrl: string },
  comment: string,
): Promise<CreatedAnnotation> {
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  let viewBox = [0, 0, 612, 792];
  try {
    viewBox = (await getPageData(key, img.pageIndex)).viewBox;
  } catch {
    // keep the fallback box when the page is not parsed
  }
  const top = Math.max(0, Math.floor(viewBox[3] - img.rect[3]));
  const ann = toRecord({
    key: generateKey(),
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    type: "image",
    text: "",
    comment,
    color: resolveColor(),
    pageLabel: img.pageLabel || String(img.pageIndex + 1),
    pageIndex: img.pageIndex,
    rects: [img.rect],
    viewBox,
    sortIndex: sortIndex(img.pageIndex, 0, top),
    tags: aiTags(),
    imageData: img.dataUrl,
  });
  await save(ann);
  return { key: ann.key, pageLabel: ann.pageLabel, pageIndex: img.pageIndex, text: "", itemKey: item.itemKey };
}

/** Save the reader's current text selection as a highlight. */
export async function saveSelectionAsHighlight(
  item: Paper,
  selection: { text: string; pageIndex: number; rects: number[][]; viewBox?: number[]; pageLabel?: string; sortIndex?: string },
  comment: string,
  color?: string,
): Promise<string> {
  const viewBox = selection.viewBox || [0, 0, 612, 792];
  const ann = toRecord({
    key: generateKey(),
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    type: "highlight",
    text: selection.text,
    comment,
    color: resolveColor(color),
    pageLabel: selection.pageLabel || String(selection.pageIndex + 1),
    pageIndex: selection.pageIndex,
    rects: selection.rects,
    viewBox,
    sortIndex: selection.sortIndex || sortIndex(selection.pageIndex, 0, viewBox[3] - (selection.rects[0]?.[3] || 0)),
    tags: aiTags(),
  });
  await save(ann);
  return ann.key;
}

export async function updateAnnotationComment(
  libraryID: number,
  key: string,
  comment: string,
  mode: "replace" | "append",
): Promise<void> {
  const ann = await getAnnotation(key);
  if (!ann) throw new Error(`找不到批注 ${key}`);
  ann.comment = mode === "append" && ann.comment ? `${ann.comment}\n\n${comment}` : comment;
  ann.dateModified = new Date().toISOString();
  await db.put("annotations", ann);
  globalEvents.emit({ type: "annotation-updated", key, libraryID: ann.libraryID, itemKey: ann.itemKey, page: ann.pageLabel });
}

export async function deleteAnnotation(key: string): Promise<void> {
  const ann = await getAnnotation(key);
  await db.del("annotations", key);
  if (ann) {
    globalEvents.emit({ type: "annotation-deleted", key, libraryID: ann.libraryID, itemKey: ann.itemKey, page: ann.pageLabel });
  }
}

/**
 * A note the agent (or the user) writes for the paper as a whole: no anchored
 * text, parked in the right margin of the page being read.
 */
export async function createStandaloneNote(
  item: Paper,
  markdown: string,
  title = "",
): Promise<CreatedAnnotation> {
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  let pageIndex = 0;
  let viewBox = [0, 0, 612, 792];
  try {
    if (await ensurePdf(item)) {
      const doc = await getDoc(key);
      const count = doc?.numPages || 1;
      pageIndex = viewerState.paperKey === key ? Math.min(Math.max(viewerState.currentPage - 1, 0), count - 1) : 0;
      const data = await getPageData(key, pageIndex);
      if (data.viewBox[2] > 0) viewBox = data.viewBox;
    }
  } catch {
    // no readable PDF: the note still saves, just against the default page box
  }
  const size = viewBox[3] - viewBox[1];
  const x = viewBox[2] - 34;
  const ann = toRecord({
    key: generateKey(),
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    type: "note",
    text: title,
    comment: markdown,
    color: resolveColor(),
    pageLabel: String(pageIndex + 1),
    pageIndex,
    rects: [[x, viewBox[3] - 56, x + 22, viewBox[3] - 34]],
    viewBox,
    sortIndex: sortIndex(pageIndex, 0, size - (viewBox[3] - 34)),
    tags: aiTags(),
  });
  await save(ann);
  return { key: ann.key, pageLabel: ann.pageLabel, pageIndex, text: title, itemKey: item.itemKey };
}

