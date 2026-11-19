/**
 * Paper registry for the browser: the built-in demo papers served by the
 * backend plus the user's own uploads / arXiv links. Replaces Zotero items and
 * attachment lookup; everything is keyed by `itemKey` so the tools keep their
 * original {libraryID, itemKey} shape.
 */
import { arxivGet } from "./academic";
import { getHealth, PAPERS_BASE, download, fetchBytes, staticJson, type ProgressFn } from "./host";
import * as db from "./db";
import { dropDoc, getPagesText, hasDoc, loadDoc } from "./reader";
import { detectHeadings, type Heading } from "./text";
import { paperKey } from "./viewer-state";

export interface PaperRef {
  libraryID: number;
  itemKey: string;
}

/** One library in the browser version, so refs stay compatible with the plugin. */
export const LIBRARY_ID = 1;

export interface Paper {
  itemKey: string;
  libraryID: number;
  title: string;
  authors: string;
  year: string;
  venue: string;
  DOI: string;
  url: string;
  pdfUrl: string;
  abstract: string;
  tags: string;
  source: "demo" | "upload" | "url";
  /** demo papers: file names shipped under /papers in the static bundle */
  pdfFile?: string;
  textFile?: string;
  addedAt: number;
  totalPages?: number;
}

export interface PaperText {
  pages: string[];
  headings: Heading[];
  totalPages: number;
  source: "pdf" | "demo" | "none";
}

interface DemoEntry {
  id: string;
  slug: string;
  title: string;
  authors: string[];
  year: string;
  venue: string;
  abstract: string;
  url: string;
  pdfUrl: string;
  pdfFile: string;
  textFile: string;
  totalPages: number;
}

const papers = new Map<string, Paper>();
let demoEntries: DemoEntry[] = [];
let demoKeyFlag = false;
let loaded = false;

export function ref(itemKey: string): PaperRef {
  return { libraryID: LIBRARY_ID, itemKey };
}

export function isDemoAvailable(): boolean {
  return demoEntries.length > 0;
}

export function demoKeyConfigured(): boolean {
  return demoKeyFlag;
}

export function demoPapers(): DemoEntry[] {
  return demoEntries;
}

function demoToPaper(d: DemoEntry): Paper {
  return {
    itemKey: d.id,
    libraryID: LIBRARY_ID,
    title: d.title,
    authors: (d.authors || []).join(", "),
    year: d.year || "",
    venue: d.venue || "arXiv",
    DOI: "",
    url: d.url || `https://arxiv.org/abs/${d.id}`,
    pdfUrl: d.pdfUrl || `https://arxiv.org/pdf/${d.id}`,
    abstract: d.abstract || "",
    tags: "演示论文",
    source: "demo",
    pdfFile: d.pdfFile,
    textFile: d.textFile,
    addedAt: 0,
    totalPages: d.totalPages,
  };
}

/** Load demo papers from the backend and the user's own library from IndexedDB. */
export async function loadRegistry(): Promise<void> {
  const [stored, demo] = await Promise.all([db.getAll<Paper>("papers").catch(() => [] as Paper[]), fetchDemo().catch(() => null)]);
  papers.clear();
  for (const p of stored) papers.set(p.itemKey, { ...p, libraryID: LIBRARY_ID });
  demoEntries = demo?.papers || [];
  demoKeyFlag = !!demo?.demoKey;
  for (const d of demoEntries) papers.set(d.id, demoToPaper(d));
  loaded = true;
}

async function fetchDemo(): Promise<{ papers: DemoEntry[]; demoKey: boolean }> {
  // The catalogue is a static file; only the demo-key report needs the function.
  const [papers, health] = await Promise.all([
    staticJson<DemoEntry[]>(`${PAPERS_BASE}/manifest.json`),
    getHealth().catch(() => null),
  ]);
  return { papers: Array.isArray(papers) ? papers : [], demoKey: !!health?.demoKey };
}

export function getItem(refOrKey: PaperRef | string | null | undefined): Paper | null {
  if (!refOrKey) return null;
  const key = typeof refOrKey === "string" ? refOrKey : refOrKey.itemKey;
  return papers.get(key) || null;
}

export function listPapers(): Paper[] {
  return [...papers.values()].sort((a, b) => b.addedAt - a.addedAt);
}

/** Accept "ABC12345", "1/ABC12345" or "local:xyz". */
export function resolveItemKey(itemKey: string): Paper | null {
  const key = String(itemKey || "").trim().replace(/^.*\//, "");
  return papers.get(key) || null;
}

export function paperTitle(item: Paper | null): string {
  return item?.title || "(未命名文献)";
}

export function creatorsString(item: Paper | null, max = 6): string {
  const names = (item?.authors || "").split(/,|;|\&/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return "";
  return names.length > max ? [...names.slice(0, max), "et al."].join(", ") : names.join(", ");
}

export function paperMetadata(item: Paper | null): Record<string, string> {
  if (!item) return {};
  const meta: Record<string, string> = {
    itemKey: item.itemKey,
    title: item.title,
    authors: creatorsString(item),
    year: item.year,
    venue: item.venue,
    DOI: item.DOI,
    url: item.url,
    abstract: item.abstract,
    tags: item.tags,
    source: item.source,
  };
  for (const k of Object.keys(meta)) if (!meta[k]) delete meta[k];
  return meta;
}

// ---------------------------------------------------------------------------
// registration

export async function registerFile(file: File): Promise<Paper> {
  const bytes = await file.arrayBuffer();
  const itemKey = `local:${hashKey(file.name + ":" + file.size + ":" + file.lastModified)}`;
  const paper: Paper = {
    itemKey,
    libraryID: LIBRARY_ID,
    title: file.name.replace(/\.pdf$/i, ""),
    authors: "",
    year: "",
    venue: "",
    DOI: "",
    url: "",
    pdfUrl: "",
    abstract: "",
    tags: "本地上传",
    source: "upload",
    addedAt: Date.now(),
  };
  await db.put("blobs", { id: paperKey({ libraryID: LIBRARY_ID, itemKey }), bytes });
  await db.put("papers", paper);
  papers.set(itemKey, paper);
  await loadPdfBytes(paper, bytes);
  return paper;
}

export async function registerUrl(url: string, titleHint?: string): Promise<Paper> {
  const clean = url.trim();
  const arxiv = clean.match(/arxiv\.org\/(?:abs|pdf)\/([0-9.]+)(?:v\d+)?(?:\.pdf)?/i) || /^(\d{4}\.\d{4,5})$/i.exec(clean);
  const id = arxiv ? arxiv[1] : "";
  const itemKey = id ? id : `url:${hashKey(clean)}`;
  const existing = papers.get(itemKey);
  if (existing) return existing;

  const paper: Paper = {
    itemKey,
    libraryID: LIBRARY_ID,
    title: titleHint || (id ? `arXiv:${id}` : clean.replace(/^https?:\/\//, "").slice(0, 80)),
    authors: "",
    year: "",
    venue: id ? "arXiv" : "",
    DOI: "",
    url: id ? `https://arxiv.org/abs/${id}` : clean,
    pdfUrl: id ? `https://arxiv.org/pdf/${id}` : clean,
    abstract: "",
    tags: "链接添加",
    source: "url",
    addedAt: Date.now(),
  };
  if (id) {
    try {
      const meta = await arxivGet(id);
      if (meta) {
        paper.title = meta.title || paper.title;
        paper.authors = (meta.authors || []).join(", ");
        paper.year = (meta.published || "").slice(0, 4);
        paper.abstract = meta.summary || "";
        paper.venue = "arXiv";
      }
    } catch (e) {
      console.warn("[ScholarPi] arXiv 元数据获取失败", e);
    }
  }
  await db.put("papers", paper);
  papers.set(itemKey, paper);
  return paper;
}

export async function removePaper(itemKey: string): Promise<void> {
  const item = papers.get(itemKey);
  if (item?.source !== "demo") await db.del("papers", itemKey);
  const stored = await db.get<{ id: string; bytes: ArrayBuffer }>("blobs", paperKey(ref(itemKey)));
  if (stored) await db.del("blobs", stored.id);
  papers.delete(itemKey);
  if (hasDoc(paperKey(ref(itemKey)))) {
    dropDoc(paperKey(ref(itemKey)));
  }
}

function hashKey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// PDF bytes → pdf.js document

function refKey(item: Paper): string {
  return paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
}

/**
 * One download + parse per paper, whoever asks first: the rail starts it on click so the
 * bytes are already moving while the chat panel finishes rendering, and the reader joins
 * the same task instead of issuing a second request.
 */
const pdfTasks = new Map<string, Promise<boolean>>();
const pdfProgress = new Map<string, Set<ProgressFn>>();
const pdfLastChunk = new Map<string, { received: number; total: number }>();

function emitProgress(key: string): ProgressFn {
  return (received, total) => {
    pdfLastChunk.set(key, { received, total });
    for (const fn of pdfProgress.get(key) || []) fn(received, total);
  };
}

function pdfTask(item: Paper): Promise<boolean> {
  const key = refKey(item);
  const running = pdfTasks.get(key);
  if (running) return running;
  pdfProgress.set(key, new Set());
  const task = (async () => {
    const bytes = await pdfBytes(item, emitProgress(key));
    if (!bytes) return false;
    await loadPdfBytes(item, bytes);
    return true;
  })().finally(() => {
    pdfTasks.delete(key);
    pdfProgress.delete(key);
    pdfLastChunk.delete(key);
  });
  pdfTasks.set(key, task);
  return task;
}

/** Warm the reader in the background; a failure is reported to whoever awaits the task. */
export function prefetchPdf(item: Paper | null): void {
  if (!item || hasPdfLoaded(item)) return;
  void pdfTask(item).catch(() => undefined);
}

/** Make sure reader.ts has a parsed document; false only when the paper has no PDF at all. */
export async function ensurePdf(item: Paper, onProgress?: ProgressFn): Promise<boolean> {
  if (!item) return false;
  const key = refKey(item);
  if (hasDoc(key)) {
    onProgress?.(1, 1);
    return true;
  }
  const task = pdfTask(item);
  const subs = onProgress ? pdfProgress.get(key) : undefined;
  if (subs && onProgress) {
    subs.add(onProgress);
    const seen = pdfLastChunk.get(key);
    if (seen) onProgress(seen.received, seen.total);
  }
  try {
    return await task;
  } finally {
    if (subs && onProgress) subs.delete(onProgress);
  }
}

/**
 * A transport failure throws (the reader shows it and offers a retry); null means this
 * paper simply has no file behind it.
 */
async function pdfBytes(item: Paper, onProgress?: ProgressFn): Promise<ArrayBuffer | null> {
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  if (item.source === "demo") {
    if (!item.pdfFile) return null;
    return download(`${PAPERS_BASE}/${encodeURIComponent(item.pdfFile)}`, onProgress);
  }
  if (item.source === "upload") {
    const row = await db.get<{ bytes: ArrayBuffer }>("blobs", key);
    if (!row?.bytes) return null;
    onProgress?.(row.bytes.byteLength, row.bytes.byteLength);
    return row.bytes;
  }
  const target = item.pdfUrl || item.url;
  if (!target) return null;
  return fetchBytes(target, onProgress);
}

async function loadPdfBytes(item: Paper, bytes: ArrayBuffer): Promise<void> {
  const key = paperKey({ libraryID: item.libraryID, itemKey: item.itemKey });
  try {
    await loadDoc(key, bytes);
  } catch (e: any) {
    throw new Error(`PDF 解析失败：${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// full text

const textCache = new Map<string, { at: number; text: PaperText }>();
const CACHE_MAX = 12;

export async function getPaperText(item: Paper): Promise<PaperText> {
  if (!item) return { pages: [], headings: [], totalPages: 0, source: "none" };
  const cached = textCache.get(item.itemKey);
  if (cached) {
    cached.at = Date.now();
    return cached.text;
  }
  let result: PaperText;
  if (item.source === "demo") {
    try {
      const doc = await staticJson<{ pages: string[] }>(`${PAPERS_BASE}/${encodeURIComponent(item.textFile || "")}`);
      const pages = (doc.pages || []).map((p) => p.replace(/\n{3,}/g, "\n\n").trim());
      result = { pages, headings: detectHeadings(pages), totalPages: pages.length, source: "demo" };
    } catch {
      result = await fromPdf(item);
    }
  } else {
    result = await fromPdf(item);
  }
  textCache.set(item.itemKey, { at: Date.now(), text: result });
  if (textCache.size > CACHE_MAX) {
    const oldest = [...textCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    textCache.delete(oldest[0]);
  }
  return result;
}

async function fromPdf(item: Paper): Promise<PaperText> {
  // Text extraction keeps its old "no text" answer when the download itself fails;
  // the reader is the place that reports transport errors to the visitor.
  const ok = await ensurePdf(item).catch(() => false);
  if (!ok) return { pages: [], headings: [], totalPages: 0, source: "none" };
  const pages = (await getPagesText(paperKey({ libraryID: item.libraryID, itemKey: item.itemKey }))).map((p) =>
    p.replace(/\n{3,}/g, "\n\n").trim(),
  );
  return { pages, headings: detectHeadings(pages), totalPages: pages.length, source: "pdf" };
}

export function hasPdfLoaded(item: Paper): boolean {
  return hasDoc(paperKey({ libraryID: item.libraryID, itemKey: item.itemKey }));
}

export { paperKey };
