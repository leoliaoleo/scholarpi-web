/**
 * 个人科研知识库：专题（collections）、标签（tags）、结构化元数据卡片（cards）、跨文献检索与
 * JSON / BibTeX 备份，全部落在浏览器 IndexedDB 的 v2 新增 store 上。
 *
 * 内置演示论文只读：给它们加的标签和卡片写在 `cards` 里，不改写 `/papers/manifest.json`
 * 带过来的条目，所以刷新页面、重新部署都不会影响 3 篇预置论文的阅读体验。
 */
import { arxivRecords, resolveExternal, semanticPaper, type ExternalRecord } from "./academic";
import { getSettings } from "./config";
import * as db from "./db";
import { globalEvents } from "./events";
import { completeText } from "./llm";
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  KB_WEIGHTS,
  arxivStableId,
  bm25,
  buildKbDocs,
  dedupeStrings,
  inspectBackup,
  joinTags,
  matchedFields,
  parseIdentifiers,
  planImports,
  safeUrl,
  sampleForCard,
  snippetFor,
  splitTags,
  stripPaperForBackup,
  toBibtexLibrary,
  type BibEntry,
  type ImportJob,
} from "./library-util";
import {
  ensurePdf,
  findSimilar,
  getItem,
  getPaperText,
  hasPdfLoaded,
  listPapers,
  loadRegistry,
  paperMetadata,
  registerFile,
  registerMeta,
  removePaper,
  type Paper,
} from "./paper";
import { DEMO_CARDS, DEMO_COLLECTIONS, KB_SEED_VERSION } from "./kb-presets";

export interface Collection {
  id: string;
  name: string;
  description: string;
  color: string;
  itemKeys: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PaperCard {
  itemKey: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  DOI: string;
  url: string;
  pdfUrl: string;
  abstract: string;
  method: string;
  datasets: string;
  metrics: string;
  summary: string;
  keywords: string;
  tags: string;
  /** 卡片来源：metadata（抓取）/ fulltext（模型读全文）/ manual（用户编辑） */
  basis: string;
  citations: number;
  updatedAt: number;
}

const SEED_FLAG = `kbSeedV${KB_SEED_VERSION}`;
const COLORS = ["#4a7cc0", "#3a9d78", "#b06fc4", "#c4763a", "#5a6b8c", "#8c5a5a"];

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function changed(type = "library-changed"): void {
  globalEvents.emit({ type });
}

// ---------------------------------------------------------------------------
// collections（自定义研究方向 / 专题）

export async function listCollections(): Promise<Collection[]> {
  const rows = await db.getAll<Collection>("collections");
  return rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function createCollection(name: string, description = "", color = ""): Promise<Collection> {
  const now = Date.now();
  const row: Collection = {
    id: uid("col"),
    name: String(name || "").trim().slice(0, 60) || "未命名专题",
    description: String(description || "").trim().slice(0, 400),
    color: color || COLORS[(await db.getAll("collections").catch(() => [] as any[])).length % COLORS.length],
    itemKeys: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.put("collections", row);
  changed();
  return row;
}

export async function updateCollection(id: string, patch: Partial<Pick<Collection, "name" | "description" | "color">>): Promise<Collection | undefined> {
  const row = await db.get<Collection>("collections", id);
  if (!row) return;
  const next = { ...row, ...patch, id, updatedAt: Date.now() };
  if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 60) || row.name;
  await db.put("collections", next);
  changed();
  return next;
}

export async function deleteCollection(id: string): Promise<void> {
  await db.del("collections", id);
  changed();
}

export async function collectionAdd(id: string, itemKeys: string | string[]): Promise<Collection | undefined> {
  const row = await db.get<Collection>("collections", id);
  if (!row) return;
  const add = Array.isArray(itemKeys) ? itemKeys : [itemKeys];
  const keys = dedupeStrings([...(row.itemKeys || []), ...add.filter(Boolean)]);
  const next = { ...row, itemKeys: keys, updatedAt: Date.now() };
  await db.put("collections", next);
  changed();
  return next;
}

export async function collectionRemove(id: string, itemKey: string): Promise<Collection | undefined> {
  const row = await db.get<Collection>("collections", id);
  if (!row) return;
  const next = { ...row, itemKeys: (row.itemKeys || []).filter((k) => k !== itemKey), updatedAt: Date.now() };
  await db.put("collections", next);
  changed();
  return next;
}

export async function collectionsOf(itemKey: string): Promise<Collection[]> {
  return (await listCollections()).filter((c) => (c.itemKeys || []).includes(itemKey));
}

/** Drop a paper's traces after deletion (papers stay the only owner of their own record). */
export async function purgeItem(itemKey: string): Promise<void> {
  for (const c of await listCollections().catch(() => [] as Collection[])) {
    if ((c.itemKeys || []).includes(itemKey)) await collectionRemove(c.id, itemKey);
  }
  await db.del("cards", itemKey).catch(() => undefined);
  changed();
}

export async function removeItem(itemKey: string): Promise<void> {
  await removePaper(itemKey);
  await purgeItem(itemKey);
  changed();
}

// ---------------------------------------------------------------------------
// tags

/** Effective tags: what the paper record carries plus what the card stores. */
export function tagsOf(item: Paper, card?: PaperCard): string[] {
  return dedupeStrings([...splitTags(item.tags), ...splitTags(card?.tags)]);
}

/**
 * Tag writes go to the card so a demo paper's shipped record is never rewritten; uploads
 * keep their own field in sync so a bare backup still carries them.
 */
export async function setPaperTags(itemKey: string, tags: string[]): Promise<string[]> {
  const clean = splitTags(tags);
  const card = await getCard(itemKey);
  await saveCard({ ...(card || emptyCard(itemKey)), itemKey, tags: joinTags(clean), basis: card?.basis || "manual", updatedAt: Date.now() }, true);
  const item = getItem(itemKey);
  if (item && item.source !== "demo") await db.put("papers", { ...item, tags: joinTags(clean.filter((t) => !isOriginTag(t))) });
  changed();
  return clean;
}

function isOriginTag(t: string): boolean {
  return ["演示论文", "本地上传", "链接添加", "arXiv", "DOI"].includes(t);
}

export async function tagsIndex(): Promise<{ tag: string; count: number }[]> {
  const cards = await listCards().catch(() => [] as PaperCard[]);
  const byKey = new Map(cards.map((c) => [c.itemKey, c]));
  const counts = new Map<string, { tag: string; count: number }>();
  for (const p of listPapers()) {
    for (const t of tagsOf(p, byKey.get(p.itemKey))) {
      const k = t.toLocaleLowerCase();
      const hit = counts.get(k);
      if (hit) hit.count++;
      else counts.set(k, { tag: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// metadata cards

export function emptyCard(itemKey: string): PaperCard {
  return {
    itemKey,
    title: "",
    authors: "",
    year: "",
    venue: "",
    DOI: "",
    url: "",
    pdfUrl: "",
    abstract: "",
    method: "",
    datasets: "",
    metrics: "",
    summary: "",
    keywords: "",
    tags: "",
    basis: "",
    citations: 0,
    updatedAt: 0,
  };
}

export async function getCard(itemKey: string): Promise<PaperCard | undefined> {
  return db.get<PaperCard>("cards", itemKey).catch(() => undefined);
}

export async function listCards(): Promise<PaperCard[]> {
  return db.getAll<PaperCard>("cards").catch(() => [] as PaperCard[]);
}

/** @param bare write only the given fields (used for tag-only updates). */
export async function saveCard(card: Partial<PaperCard> & { itemKey: string }, bare = false): Promise<PaperCard> {
  const old = await getCard(card.itemKey);
  const base = bare ? old || emptyCard(card.itemKey) : old || emptyCard(card.itemKey);
  const merged: PaperCard = { ...base, ...card, itemKey: card.itemKey, updatedAt: Date.now() };
  if (!bare) {
    const item = getItem(card.itemKey);
    if (item) {
      const meta = paperMetadata(item);
      merged.title = merged.title || meta.title || "";
      merged.authors = merged.authors || meta.authors || "";
      merged.year = merged.year || meta.year || "";
      merged.venue = merged.venue || meta.venue || "";
      merged.DOI = merged.DOI || meta.DOI || "";
      merged.url = merged.url || meta.url || "";
      merged.pdfUrl = merged.pdfUrl || item.pdfUrl || "";
      merged.abstract = merged.abstract || meta.abstract || "";
    }
  }
  await db.put("cards", merged);
  changed("cards-changed");
  return merged;
}

/** Card fields with the paper record underneath, for display and BibTeX. */
export async function cardView(item: Paper): Promise<PaperCard> {
  const card = await getCard(item.itemKey);
  const meta = paperMetadata(item);
  return {
    ...emptyCard(item.itemKey),
    ...card,
    title: meta.title || card?.title || "",
    authors: meta.authors || card?.authors || "",
    year: meta.year || card?.year || "",
    venue: meta.venue || card?.venue || "",
    DOI: meta.DOI || card?.DOI || "",
    url: meta.url || card?.url || "",
    pdfUrl: item.pdfUrl || card?.pdfUrl || "",
    abstract: meta.abstract || card?.abstract || "",
    itemKey: item.itemKey,
  };
}

export async function deleteCard(itemKey: string): Promise<void> {
  await db.del("cards", itemKey);
  changed("cards-changed");
}

const CARD_SYSTEM = `你是科研知识库的卡片编辑，只输出一个 JSON 对象，不要解释、不要代码块。
字段全部为字符串、全部用中文（术语本身是英文时保留英文）：
{"method":"核心方法：模型/网络结构、训练目标、关键技巧","datasets":"数据集：名称、规模、预处理","metrics":"关键指标：论文报告的数字、对比对象、在哪个基准上","summary":"一句话总结：解决什么问题、用什么办法","keywords":"8-14个检索关键词，逗号分隔，中英文都给","tags":"2-4个分类标签，逗号分隔"}
只写材料里确实出现过的内容；材料没有的信息就留空字符串，绝不编造数字。`;

/** Fill the card from the abstract (and a spread of the full text when it is indexed). */
export async function generateCard(itemKey: string, opts: { signal?: AbortSignal; fullText?: boolean } = {}): Promise<PaperCard> {
  const item = getItem(itemKey);
  if (!item) throw new Error(`找不到文献 ${itemKey}`);
  const meta = paperMetadata(item);
  let sample = "";
  let basis = "metadata";
  if (opts.fullText !== false) {
    const text = await getPaperText(item).catch(() => null);
    if (text?.pages.length) {
      sample = sampleForCard(text.pages);
      basis = "fulltext";
    }
  }
  const parts = [
    `标题：${meta.title}`,
    `作者：${meta.authors}`,
    `年份/来源：${meta.year} ${meta.venue}`,
    `DOI：${meta.DOI}`,
    `摘要：${meta.abstract}`,
    sample ? `正文节选（跨页抽样）：\n${sample}` : "",
  ].filter(Boolean);
  const out = await completeText(
    { systemPrompt: CARD_SYSTEM, messages: [{ role: "user", content: parts.join("\n").slice(0, 16000), timestamp: Date.now() }] },
    { signal: opts.signal, maxTokens: 900, reasoning: "off" },
  );
  const json = parseJsonObject(out);
  const old = await getCard(itemKey);
  // 模型这次什么都没给（JSON 坏了/额度被限）：上一张卡片原样留着，绝不用空字段覆盖它。
  const got = ["method", "datasets", "metrics", "summary", "keywords", "tags"].some((k) => str((json as Record<string, unknown>)[k]));
  if (!got && old) return old;
  const tags = splitTags(json.tags);
  const card: PaperCard = {
    ...(old || emptyCard(itemKey)),
    itemKey,
    method: str(json.method) || old?.method || "",
    datasets: str(json.datasets) || old?.datasets || "",
    metrics: str(json.metrics) || old?.metrics || "",
    summary: str(json.summary) || old?.summary || "",
    keywords: str(json.keywords) || old?.keywords || "",
    tags: tags.length ? joinTags(tags) : old?.tags || "",
    basis: got ? basis : old?.basis || basis,
    updatedAt: got ? Date.now() : old?.updatedAt || Date.now(),
  };
  await saveCard(card, true);
  return card;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(String).join(", ") : "";
}

function parseJsonObject(text: string): Record<string, any> {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// import: identifiers, links, local PDFs

export interface ImportResult {
  input: string;
  ok: boolean;
  itemKey: string;
  title: string;
  action: "added" | "existing" | "failed";
  pdf: boolean;
  note: string;
}

function recordToPaper(rec: ExternalRecord): Partial<Paper> & { itemKey: string; title: string } {
  const stable = rec.itemKey || `url:${hashSeed(rec.pdfUrl || rec.url)}`;
  return {
    itemKey: stable,
    title: rec.title || stable,
    authors: rec.authors,
    year: rec.year,
    venue: rec.venue,
    DOI: rec.DOI,
    url: safeUrl(rec.url) || safeUrl(rec.pdfUrl),
    pdfUrl: safeUrl(rec.pdfUrl),
    abstract: rec.abstract,
    tags: joinTags([rec.tags]),
    source: "url",
  };
}

function hashSeed(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 导入只做两件事：拿元数据、写 IndexedDB。PDF 留到真正打开时再下（`paper.ts` 的懒加载），
 * 预取、AI 卡片和被引数都在后台慢车道补，所以批量导入是秒级的。
 */
export interface ImportOpts {
  collectionId?: string;
  signal?: AbortSignal;
  withCard?: boolean;
  onOne?: (r: ImportResult, i: number) => void;
}

/** 一条链路的耐心上限：慢链接只牺牲自己，不拖垮整批。 */
const RESOLVE_TIMEOUT_MS = 8000;
/** DOI / 普通链接的并行抓取数；arXiv 走一次 id_list 批量请求，不占这份并发。 */
const RESOLVE_CONCURRENCY = 4;

function failed(input: string, note: string): ImportResult {
  return { input, ok: false, itemKey: "", title: "", action: "failed", pdf: false, note: String(note).slice(0, 200) };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}：${Math.round(ms / 1000)} 秒内没有响应`)), ms);
  });
  // 超时之后原请求再失败，不该变成未处理的 rejection
  p.catch(() => undefined);
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/** 卡片先用抓到的元数据落库：列表和知识图谱立刻有内容，模型的活交给后台。 */
async function seedCard(item: Paper, rec: ExternalRecord): Promise<void> {
  const old = await getCard(item.itemKey);
  const keywords = dedupeStrings([...splitTags(old?.keywords || ""), ...rec.hints.keywords]).join(", ");
  await saveCard(
    {
      ...(old || emptyCard(item.itemKey)),
      itemKey: item.itemKey,
      method: old?.method || "",
      keywords,
      summary: old?.summary || rec.hints.tldr || "",
      tags: old?.tags || "",
      basis: old?.basis || "metadata",
      citations: rec.hints.citations || 0,
      updatedAt: Date.now(),
    },
    true,
  );
}

async function persistRecord(input: string, rec: ExternalRecord, opts: ImportOpts): Promise<ImportResult> {
  if (rec.kind === "url" && !rec.itemKey) {
    const known = findSimilar("", rec.pdfUrl || rec.url, rec.title);
    if (known) {
      return { input, ok: true, itemKey: known.itemKey, title: known.title, action: "existing", pdf: !!known.pdfUrl, note: "库中已有同一篇" };
    }
  }
  const dup = findSimilar(rec.DOI, rec.url || rec.pdfUrl, rec.title);
  const patch = recordToPaper(rec);
  const twin = dup && dup.itemKey !== patch.itemKey ? dup : null;
  const item = await registerMeta(patch);
  await seedCard(item, rec);
  if (opts.collectionId) await collectionAdd(opts.collectionId, item.itemKey);
  scheduleBackfill(item, rec, opts);
  return {
    input,
    ok: true,
    itemKey: item.itemKey,
    title: item.title,
    action: twin ? "existing" : "added",
    pdf: !!item.pdfUrl,
    note: twin ? `库中已有：${twin.title}` : rec.hints.citations ? `被引 ${rec.hints.citations}` : "",
  };
}

async function persistSafe(input: string, rec: ExternalRecord, opts: ImportOpts): Promise<ImportResult> {
  try {
    return await persistRecord(input, rec, opts);
  } catch (e: any) {
    return failed(input, e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// 后台慢车道：PDF 预取占带宽、模型调用占配额，各走各的队列，都不许挡住导入

const PDF_JOBS = 2;
const BG_JOBS = 1;

const pdfPending: Paper[] = [];
const pdfQueued = new Set<string>();
let pdfActive = 0;
/** 元数据还没抓完时先攒着，别和它们抢网络。 */
let pdfGo = false;

function enqueuePdf(item: Paper): void {
  if (item.source === "demo" || item.source === "upload" || !item.pdfUrl) return;
  if (hasPdfLoaded(item) || pdfQueued.has(item.itemKey)) return;
  pdfQueued.add(item.itemKey);
  pdfPending.push(item);
  drainPdf();
}

function drainPdf(): void {
  if (!pdfGo) return;
  while (pdfActive < PDF_JOBS && pdfPending.length) {
    const item = pdfPending.shift()!;
    pdfQueued.delete(item.itemKey);
    pdfActive++;
    void ensurePdf(item)
      .catch((e) => console.debug("[ScholarPi] 后台预取 PDF 失败", item.itemKey, e))
      .finally(() => {
        pdfActive--;
        drainPdf();
      });
  }
}

function releasePdfQueue(): void {
  pdfGo = true;
  drainPdf();
}

type BackfillJob = () => Promise<unknown>;
const bgPending: BackfillJob[] = [];
let bgActive = 0;

function enqueueBg(job: BackfillJob): void {
  bgPending.push(job);
  drainBg();
}

function drainBg(): void {
  while (bgActive < BG_JOBS && bgPending.length) {
    const next = bgPending.shift()!;
    bgActive++;
    void Promise.resolve()
      .then(next)
      .catch((e) => console.debug("[ScholarPi] 后台补全失败", e))
      .finally(() => {
        bgActive--;
        drainBg();
      });
  }
}

/** 打开论文时才下载是底线，导入结束后先在后台悄悄取好，让第一次点开也不用等。 */
function scheduleBackfill(item: Paper, rec: ExternalRecord, opts: ImportOpts): void {
  enqueuePdf(item);
  if (opts.withCard ?? getSettings().kbAutoCard) {
    enqueueBg(() => generateCard(item.itemKey).then(() => changed()));
  }
  if (rec.kind === "arxiv" && !rec.hints.citations) {
    // 批量解析省掉了 Semantic Scholar，被引数和 tldr 在这里慢慢补回来
    enqueueBg(async () => {
      const s2 = await semanticPaper(`ARXIV:${item.itemKey}`);
      const card = s2 ? await getCard(item.itemKey) : undefined;
      if (!card) return;
      await saveCard(
        {
          ...card,
          citations: card.citations || s2!.citationCount || 0,
          summary: card.summary || String(s2!.tldr?.text || s2!.tldr || ""),
          updatedAt: Date.now(),
        },
        true,
      );
      changed();
    });
  }
}

/** arXiv 一次请求拿全部；批量接口失败才退回逐篇解析。 */
async function arxivGroup(items: ImportJob[], opts: ImportOpts, done: (r: ImportResult, i: number) => void): Promise<void> {
  if (!items.length) return;
  let byId: Map<string, ExternalRecord>;
  try {
    byId = await withTimeout(arxivRecords(items.map((x) => x.raw), opts.signal), RESOLVE_TIMEOUT_MS + 4000, "arXiv 批量元数据");
  } catch (e: any) {
    console.debug("[ScholarPi] arXiv 批量解析失败，改逐篇", e);
    await resolveGroup(items, opts, done);
    return;
  }
  for (const it of items) {
    const id = arxivStableId(it.raw);
    const rec = byId.get(id);
    if (!rec) done(failed(it.raw, `arXiv 上找不到 ${id}`), it.i);
    else done(await persistSafe(it.raw, rec, opts), it.i);
  }
}

/** 并发上限 4 的工作池：每篇 8 秒超时，一篇慢不会让整批等。 */
async function resolveGroup(items: ImportJob[], opts: ImportOpts, done: (r: ImportResult, i: number) => void): Promise<void> {
  if (!items.length) return;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const it = items[next++];
      if (!it) return;
      try {
        const rec = await withTimeout(resolveExternal(it.raw, opts.signal), RESOLVE_TIMEOUT_MS, it.raw);
        done(await persistSafe(it.raw, rec, opts), it.i);
      } catch (e: any) {
        done(failed(it.raw, e?.message || e), it.i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, items.length) }, worker));
}

export async function importIdentifiers(
  values: string[],
  opts: ImportOpts = {},
  onOne?: (r: ImportResult, i: number) => void,
): Promise<ImportResult[]> {
  const report = onOne || opts.onOne;
  const out: ImportResult[] = [];
  // 结果按输入顺序返回（调用方靠下标对齐候选文献），所以每条输入都占一个位置。
  const plan = planImports(values);
  let finished = 0;
  const done = (r: ImportResult, i: number) => {
    out[i] = r;
    report?.(r, i);
    // 谁触发的导入都值得看见进度：界面和 agent 都读这一条事件
    globalEvents.emit({ type: "kb-import-progress", done: ++finished, total: values.length, ok: r.ok, title: (r.ok ? r.title : r.input).slice(0, 60) });
  };
  for (const b of plan.blanks) done(failed(b.raw, "内容为空"), b.i);
  try {
    await Promise.all([arxivGroup(plan.arxiv, opts, done), resolveGroup(plan.rest, opts, done)]);
    changed();
  } finally {
    releasePdfQueue();
  }
  return values.map((value, i) => out[i] || failed(String(value || ""), "导入未完成"));
}

/** 单篇入口（MCP 桥接器用），走的仍是同一条快路径。 */
export async function importIdentifier(
  value: string,
  opts: { collectionId?: string; signal?: AbortSignal; withCard?: boolean } = {},
): Promise<ImportResult> {
  const input = String(value || "").trim();
  if (!input) return failed(input, "内容为空");
  const rows = await importIdentifiers([input], opts);
  return rows[0] || failed(input, "导入失败");
}

/** Local PDFs: bytes go to IndexedDB, the card is created from whatever the file yields. */
export async function importFiles(files: File[], opts: { collectionId?: string; withCard?: boolean } = {}): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (const f of files) {
    try {
      const item = await registerFile(f);
      if (opts.collectionId) await collectionAdd(opts.collectionId, item.itemKey);
      if (opts.withCard ?? getSettings().kbAutoCard) {
        try {
          await generateCard(item.itemKey);
        } catch (e) {
          console.debug("[ScholarPi] 卡片生成失败", e);
        }
      }
      out.push({ input: f.name, ok: true, itemKey: item.itemKey, title: item.title, action: "added", pdf: true, note: "" });
    } catch (e: any) {
      out.push({ input: f.name, ok: false, itemKey: "", title: "", action: "failed", pdf: false, note: String(e?.message || e).slice(0, 200) });
    }
  }
  changed();
  return out;
}

/** Paste-a-block helper used by the UI and by the agent tool alike. */
export async function importBlock(raw: string, opts: ImportOpts = {}): Promise<ImportResult[]> {
  return importIdentifiers(parseIdentifiers(raw), opts);
}

// ---------------------------------------------------------------------------
// cross-paper search (keyword + optional semantic expansion)

export interface KbHit {
  itemKey: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  snippet: string;
  fields: string[];
  score: number;
  tags: string[];
  collections: string[];
  hasCard: boolean;
  pdf: boolean;
  citations: number;
}

export interface KbSearchResult {
  hits: KbHit[];
  total: number;
  expanded: string;
  engine: string;
}

const expandCache = new Map<string, string>();

/** Same-topic synonyms (中英对照), so a Chinese question can hit an English abstract. */
export async function expandQuery(query: string, signal?: AbortSignal): Promise<string> {
  const key = query.trim().toLocaleLowerCase();
  if (expandCache.has(key)) return expandCache.get(key)!;
  let joined = "";
  try {
    const out = await completeText(
      {
        systemPrompt: "你为学术检索扩展查询。只输出 8-14 个检索词，逗号分隔，包含中文与对应英文术语、同义词、常见缩写；不要解释、不要编号。",
        messages: [{ role: "user", content: `检索需求：${query}`, timestamp: Date.now() }],
      },
      { signal, maxTokens: 200, reasoning: "off" },
    );
    joined = splitTags(out)
      .map((t) => t.slice(0, 40))
      .filter((t) => t && t !== query.toLocaleLowerCase())
      .slice(0, 14)
      .join(", ");
  } catch (e) {
    console.debug("[ScholarPi] 查询扩展失败", e);
  }
  expandCache.set(key, joined);
  return joined;
}

export async function searchLibrary(
  opts: { query: string; semantic?: boolean; fullText?: boolean; limit?: number; itemKeys?: string[]; signal?: AbortSignal },
): Promise<KbSearchResult> {
  const query = String(opts.query || "").trim();
  const all = listPapers();
  const scoped = opts.itemKeys?.length ? all.filter((p) => opts.itemKeys!.includes(p.itemKey)) : all;
  if (!query || !scoped.length) return { hits: [], total: 0, expanded: "", engine: "none" };
  const cards = await listCards();
  const byKey = new Map(cards.map((c) => [c.itemKey, c]));
  const wantSemantic = opts.semantic !== false && getSettings().kbSemantic;
  const expanded = wantSemantic ? await expandQuery(query, opts.signal) : "";
  const q = expanded ? `${query} ${expanded}` : query;
  const fullTexts: Record<string, string> = {};
  if (opts.fullText) {
    for (const p of scoped.slice(0, 8)) {
      const text = await getPaperText(p).catch(() => null);
      if (text?.pages.length) fullTexts[p.itemKey] = text.pages.join("\n").slice(0, 24000);
    }
  }
  const docs = buildKbDocs(scoped, cards, fullTexts);
  const scored = bm25(q, docs, { weights: KB_WEIGHTS });
  const cols = await listCollections().catch(() => [] as Collection[]);
  const hits: KbHit[] = [];
  for (const s of scored.slice(0, opts.limit || 20)) {
    const item = scoped.find((p) => p.itemKey === s.id);
    const doc = docs.find((d) => d.id === s.id);
    if (!item || !doc) continue;
    const card = byKey.get(item.itemKey);
    hits.push({
      itemKey: item.itemKey,
      title: item.title,
      authors: item.authors,
      year: item.year,
      venue: item.venue,
      snippet: snippetFor(q, doc),
      fields: matchedFields(q, doc),
      score: Math.round(s.score * 100) / 100,
      tags: tagsOf(item, card),
      collections: cols.filter((c) => (c.itemKeys || []).includes(item.itemKey)).map((c) => c.name),
      hasCard: !!card && !!(card.method || card.summary || card.metrics),
      pdf: !!item.pdfUrl || item.source === "demo",
      citations: card?.citations || 0,
    });
  }
  return { hits, total: scored.length, expanded, engine: expanded ? "bm25+llm-expand" : "bm25" };
}

// ---------------------------------------------------------------------------
// backup: JSON round-trip + BibTeX

export async function exportBackup(): Promise<string> {
  const data = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: "ScholarPi Web",
    papers: listPapers().filter((p) => p.source !== "demo").map(stripPaperForBackup),
    collections: await listCollections().catch(() => [] as Collection[]),
    cards: await listCards(),
    annotations: await db.getAll("annotations").catch(() => []),
  };
  return JSON.stringify(data, null, 2);
}

export interface BackupSummary {
  papers: number;
  collections: number;
  cards: number;
  annotations: number;
  skipped: string[];
}

/** merge keeps what is here; replace clears the knowledge base first. */
export async function importBackup(text: string, mode: "merge" | "replace" = "merge"): Promise<BackupSummary> {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`备份文件不是合法 JSON：${String(e?.message || e).slice(0, 120)}`);
  }
  const issues = inspectBackup(data);
  if (issues.length) throw new Error(`备份文件有问题：${issues.map((i) => `${i.path} ${i.message}`).join("；")}`);
  const skipped: string[] = [];
  if (mode === "replace") {
    await Promise.all([db.clearStore("collections"), db.clearStore("cards"), db.clearStore("annotations"), db.clearStore("papers")]);
  }
  for (const p of data.papers || []) {
    if (p?.source === "demo") {
      skipped.push(`${p?.title || p?.itemKey}（内置演示论文）`);
      continue;
    }
    if (!p?.itemKey || !p?.title) continue;
    if (mode === "merge" && (p?.source === "upload" || p?.source === "url") && getItem(p.itemKey)) {
      skipped.push(`${p.title}（已存在）`);
      continue;
    }
    await registerMeta({ ...p, itemKey: String(p.itemKey), title: String(p.title) } as any);
  }
  for (const c of data.collections || []) {
    if (!c?.name) continue;
    const row: Collection = {
      id: String(c.id || uid("col")),
      name: String(c.name),
      description: String(c.description || ""),
      color: String(c.color || COLORS[0]),
      itemKeys: Array.isArray(c.itemKeys) ? c.itemKeys.map(String) : [],
      createdAt: Number(c.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    await db.put("collections", row);
  }
  for (const c of data.cards || []) {
    if (!c?.itemKey) continue;
    await db.put("cards", { ...emptyCard(String(c.itemKey)), ...c, itemKey: String(c.itemKey) });
  }
  for (const a of data.annotations || []) {
    if (!a?.key) continue;
    await db.put("annotations", a);
  }
  if (mode === "replace") await loadRegistry().catch(() => undefined);
  changed();
  changed("cards-changed");
  return {
    papers: (data.papers || []).length,
    collections: (data.collections || []).length,
    cards: (data.cards || []).length,
    annotations: (data.annotations || []).length,
    skipped,
  };
}

export async function exportBibtex(itemKeys?: string[]): Promise<string> {
  const all = listPapers();
  const picked = itemKeys?.length ? all.filter((p) => itemKeys.includes(p.itemKey)) : all;
  const cards = await listCards();
  const byKey = new Map(cards.map((c) => [c.itemKey, c]));
  const entries: BibEntry[] = picked.map((p) => {
    const view = { ...paperMetadata(p), ...(byKey.get(p.itemKey) || ({} as PaperCard)) };
    return {
      itemKey: p.itemKey,
      title: view.title || p.title,
      authors: view.authors || p.authors,
      year: view.year || p.year,
      venue: view.venue || p.venue,
      DOI: view.DOI || p.DOI,
      url: view.url || p.url,
      abstract: view.abstract || p.abstract,
      keywords: byKey.get(p.itemKey)?.keywords || "",
    };
  });
  return toBibtexLibrary(entries);
}

/** Blob download without a server round-trip. */
export function downloadText(name: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// first-visit seed

/**
 * Seed the three demo topics and their metadata cards once per version, so the knowledge
 * base opens with content instead of an empty pane. Never touches papers, sessions or
 * annotations, and an explicit "重置知识库" can remove it again.
 */
export async function ensureSeeded(): Promise<void> {
  if (await db.get("kv", SEED_FLAG).catch(() => undefined)) return;
  const collections = await listCollections().catch(() => null);
  if (!collections) return; // IndexedDB unavailable: skip seeding rather than half-build.
  if (collections.length || (await listCards()).length) {
    await db.put("kv", { key: SEED_FLAG, value: "skipped-existing" });
    return;
  }
  const known = new Set(listPapers().map((p) => p.itemKey));
  for (const c of DEMO_COLLECTIONS) {
    const row = await createCollection(c.name, c.description, c.color);
    const keys = c.itemKeys.filter((k) => known.has(k));
    if (keys.length) await collectionAdd(row.id, keys);
  }
  for (const c of DEMO_CARDS) {
    if (!known.has(c.itemKey)) continue;
    const item = getItem(c.itemKey);
    await saveCard({
      ...emptyCard(c.itemKey),
      ...(item ? { title: item.title, authors: item.authors, year: item.year, venue: item.venue, url: item.url, pdfUrl: item.pdfUrl, abstract: item.abstract, DOI: item.DOI } : {}),
      ...c,
      basis: "metadata",
      citations: 0,
    });
  }
  await db.put("kv", { key: SEED_FLAG, value: KB_SEED_VERSION });
  changed();
  changed("cards-changed");
}

export async function libraryStats(): Promise<{ papers: number; demo: number; mine: number; collections: number; cards: number; tags: number }> {
  const papers = listPapers();
  const [collections, cards, tags] = await Promise.all([listCollections().catch(() => [] as Collection[]), listCards(), tagsIndex()]);
  return {
    papers: papers.length,
    demo: papers.filter((p) => p.source === "demo").length,
    mine: papers.filter((p) => p.source !== "demo").length,
    collections: collections.length,
    cards: cards.filter((c) => c.method || c.summary || c.metrics).length,
    tags: tags.length,
  };
}
