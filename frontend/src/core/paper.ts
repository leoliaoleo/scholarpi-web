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
import { isPdfBytes } from "./pdf";

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
  /** 预置好的文章脉络（同 /papers 下的静态 JSON）：示例论文首访就有的看，不用等模型。 */
  outlineFile?: string;
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
  outlineFile?: string;
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
    outlineFile: d.outlineFile,
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

/**
 * Register (or refresh) a library entry from externally resolved metadata — arXiv,
 * Crossref, Semantic Scholar or a backup file. `itemKey` decides identity, so re-importing
 * the same paper updates it instead of piling up duplicates.
 */
export async function registerMeta(meta: Partial<Paper> & { itemKey: string; title: string }): Promise<Paper> {
  const existing = papers.get(meta.itemKey);
  const paper: Paper = {
    itemKey: meta.itemKey,
    libraryID: LIBRARY_ID,
    title: meta.title || existing?.title || "(未命名文献)",
    authors: pick(meta.authors, existing?.authors || ""),
    year: pick(meta.year, existing?.year || ""),
    venue: pick(meta.venue, existing?.venue || ""),
    DOI: pick(meta.DOI, existing?.DOI || ""),
    url: pick(meta.url, existing?.url || ""),
    pdfUrl: pick(meta.pdfUrl, existing?.pdfUrl || ""),
    abstract: pick(meta.abstract, existing?.abstract || ""),
    tags: pick(meta.tags, existing?.tags || "") || "文献库",
    source: meta.source || existing?.source || "url",
    addedAt: existing?.addedAt || meta.addedAt || Date.now(),
    totalPages: meta.totalPages ?? existing?.totalPages,
  };
  if (paper.source !== "demo") await db.put("papers", paper);
  papers.set(paper.itemKey, paper);
  return paper;
}

/** Update one record in place; demo papers stay as shipped (their overrides live in `cards`). */
export async function patchPaper(itemKey: string, patch: Partial<Paper>): Promise<Paper | null> {
  const item = papers.get(itemKey);
  if (!item) return null;
  const next = { ...item, ...patch, itemKey: item.itemKey, libraryID: LIBRARY_ID };
  papers.set(itemKey, next);
  if (next.source !== "demo") await db.put("papers", next);
  return next;
}

/** Duplicate guard for imports: the same DOI, the same url or a near-identical title. */
export function findSimilar(doi: string, url: string, title: string): Paper | null {
  const d = doi.trim().toLowerCase();
  if (d) for (const p of papers.values()) if (p.DOI && p.DOI.toLowerCase() === d) return p;
  const u = normUrl(url);
  if (u) for (const p of papers.values()) if (p.url && normUrl(p.url) === u) return p;
  const t = titleKey(title);
  if (t.length > 12) {
    for (const p of papers.values()) if (titleKey(p.title) === t) return p;
  }
  return null;
}

function normUrl(s: string): string {
  return String(s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").replace(/\.pdf$/, "");
}

function titleKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .slice(0, 60);
}

/** Empty and missing count as "no new information", so an old value survives a partial import. */
function pick(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
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
  const cached = await db.get<{ bytes: ArrayBuffer }>("blobs", key);
  if (cached?.bytes) {
    onProgress?.(cached.bytes.byteLength, cached.bytes.byteLength);
    return cached.bytes;
  }
  const bytes = await fetchBytes(target, onProgress);
  // 下载到的不一定是 PDF：登录页、HTML 错误页、跳转链接都会原样返回。先校验魔数，
  // 不是 PDF 就抛错且绝不缓存，避免把「下载失败」当成「已下载」存进 IndexedDB。
  if (!isPdfBytes(bytes)) {
    throw new Error("下载到的内容不是 PDF（可能是登录页、HTML 错误页或跳转链接），未缓存。");
  }
  // 链接类论文的字节也存进 IndexedDB：第二次点开秒开，后台预取的成果不会随刷新丢掉
  if (bytes && bytes.byteLength <= BYTE_CACHE_MAX) await db.put("blobs", { id: key, bytes }).catch(() => undefined);
  return bytes;
}

/** 超过这个体积就不值得占用访问者的磁盘。 */
const BYTE_CACHE_MAX = 48 * 1024 * 1024;

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
