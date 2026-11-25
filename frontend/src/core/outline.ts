/**
 * 论文脉络：把整篇论文梳成「摘要拆解 → 章节 → 关键句」的树，每个节点带 1–3 个逐字锚点。
 *
 * 引擎搬自队友的 zotero-coread-ai：`outline-schema.ts`（提示词、流式 JSON 解析、页码校正）和
 * `outline-geometry.ts`（段落/图表取框）是纯函数，原样拿过来，两边的脉络 JSON 因此可以互导。
 * 换掉的只有取文字层那一步——桌面版伸进 Zotero.Reader 的内部 iframe 算坐标，这里用我们自己的
 * pdf.js（`core/reader.ts`）；拿不到文字层就退成「只翻到那一页」，并让调用方如实说出来。
 *
 * 对外的 `paperKey` 一律是 `${libraryID}/${itemKey}`：缓存键、文字层取数、事件里都是它，
 * 和桌面版 `paperKey(ref)` 同格式，两边的脉络 JSON 因此能互导。
 */
import { getSettings } from "./config";
import { Emitter } from "./events";
import { clampThinking, getModel, streamSimple } from "./llm";
import { figureRegion, paragraphRange, unionRects, type Rect } from "./outline-geometry";
import {
  buildOutlineInput,
  buildOutlinePrompt,
  extractJson,
  normalizeOutline,
  parseFigureLabel,
  parsePartialJson,
  validateAnchors,
  type OutlineAnchor,
  type PaperOutline,
} from "./outline-schema";
import { getItem, getPaperText, paperMetadata, paperTitle } from "./paper";
import { getPageData } from "./reader";
import { kvDel, kvGet, kvSet } from "./store";
import { buildCharIndex, findQuote, getRangeRects, type PdfChar } from "./text";
import { gotoPage, highlightRects, refFromPaperKey } from "./viewer-state";

/** 和桌面版同一个键，脉络 JSON 能直接拷到插件里继续用。 */
export const OUTLINE_KV_PREFIX = "outline:v1:";
/** 提示词里最多塞多少字符全文：演示额度按 token 计，15 页论文用不到桌面版那 70k 的上限。 */
const INPUT_BUDGET = 60_000;
/** 流式重解析的最短间隔，避免每来一个 delta 就重建整棵树。 */
const PARTIAL_MS = 160;

export type OutlineState =
  | { status: "idle" }
  /** `partial` 是已经流出来的那半棵树：脉络是一边生成一边长出来的，不是转圈等最后一下。 */
  | { status: "loading"; stage: string; started: number; partial?: PaperOutline; rev?: number; thinking?: string }
  | { status: "ready"; outline: PaperOutline }
  /**
   * `transport` 区分两种失败：请求本身没成功（额度、限速、超时）由界面走既有的错误分类口径；
   * 我们自己判定出来的（没有文字层、JSON 没写全）照原话显示，别被改成「这次请求没有成功」。
   */
  | { status: "error"; message: string; transport?: boolean };

const states = new Map<string, OutlineState>();
const regionCache = new Map<string, AnchorRegion>();

export const outlineChanges = new Emitter<{ key: string; state: OutlineState }>();
let job: { key: string; ctrl: AbortController } | null = null;

export function outlineState(paperKey: string): OutlineState {
  return states.get(paperKey) || { status: "idle" };
}

function set(paperKey: string, state: OutlineState): void {
  states.set(paperKey, state);
  outlineChanges.emit({ key: paperKey, state });
}

/** 读缓存（内存 → IndexedDB），不触发模型请求；上一次失败的提示也该被缓存盖过去。 */
export async function loadOutline(paperKey: string): Promise<OutlineState> {
  const cur = outlineState(paperKey);
  if (cur.status === "loading" || cur.status === "ready") return cur;
  try {
    const raw = await kvGet(OUTLINE_KV_PREFIX + paperKey);
    if (raw) {
      const outline = JSON.parse(raw) as PaperOutline;
      if (outline?.version === 1 && Array.isArray(outline.sections) && outlineState(paperKey).status !== "loading") {
        set(paperKey, { status: "ready", outline });
      }
    }
  } catch {
    // 缓存读坏了就算了，让读者能重新生成
  }
  return outlineState(paperKey);
}

/** 生成（或重新生成）一篇论文的脉络；同一篇只允许跑一个。 */
export function generateOutline(paperKey: string, force = false): void {
  const st = outlineState(paperKey);
  if (st.status === "loading") return;
  if (st.status === "ready" && !force) return;
  job?.ctrl.abort();
  const ctrl = new AbortController();
  job = { key: paperKey, ctrl };
  set(paperKey, { status: "loading", stage: "读取全文…", started: Date.now() });
  void run(paperKey, ctrl.signal).finally(() => {
    if (job?.key === paperKey) job = null;
  });
}

export function cancelOutline(paperKey: string): void {
  if (job?.key === paperKey) job.ctrl.abort();
  states.delete(paperKey);
  outlineChanges.emit({ key: paperKey, state: { status: "idle" } });
}

export async function clearOutline(paperKey: string): Promise<void> {
  await kvDel(OUTLINE_KV_PREFIX + paperKey);
  dropAnchorCache(paperKey);
  set(paperKey, { status: "idle" });
}

/** 换 PDF 或重新解析后，之前算出来的段落框就不能再信了。 */
export function dropAnchorCache(paperKey: string): void {
  for (const k of [...regionCache.keys()]) if (k.startsWith(`${paperKey}|`)) regionCache.delete(k);
}

async function run(paperKey: string, signal: AbortSignal): Promise<void> {
  const item = getItem(refFromPaperKey(paperKey));
  if (!item) return set(paperKey, { status: "error", message: "找不到该文献" });
  const started = Date.now();
  const stage = (s: string) => {
    if (!signal.aborted) set(paperKey, { status: "loading", stage: s, started });
  };
  let lastErr: any = null;
  try {
    const text = await getPaperText(item);
    if (!text.pages.some((p) => p.trim())) {
      return set(paperKey, {
        status: "error",
        message: `《${paperTitle(item)}》没有可读的文字层，无法梳理脉络：导入带文字的 PDF 或换用 arXiv 文字版后再试。`,
      });
    }
    const meta = paperMetadata(item);
    const s = getSettings();
    const modelId = s.quickModel;
    const model = getModel(modelId);
    const prompt = buildOutlinePrompt({
      title: meta.title || "",
      abstract: meta.abstract,
      language: s.replyLanguage || "简体中文",
      text: buildOutlineInput(text.pages, text.headings, INPUT_BUDGET),
    });
    const totalPages = text.totalPages || text.pages.length;
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
      stage(attempt ? "重新梳理…" : "思考中…");
      let rev = 0;
      try {
        const reply = await collect(model, prompt, s.thinkingLevel, attempt, signal, (acc, thinking) => {
          if (signal.aborted) return;
          const raw = parsePartialJson(acc, { completeStringsOnly: true });
          if (!raw) return;
          try {
            const partial = normalizeOutline(raw, totalPages, modelId, true);
            // rev 每变一次，面板就知道这是新长出来的一层，而不是同一段文字重复渲染。
            if (partial.sections.length) set(paperKey, { status: "loading", stage: "生成中…", started, partial, rev: ++rev, thinking });
          } catch {
            // JSON 还没长成能解析的样子，等下一段
          }
        });
        const outline = normalizeOutline(extractJson(reply), totalPages, modelId);
        stage("定位段落…");
        validateAnchors(outline, text.pages);
        await kvSet(OUTLINE_KV_PREFIX + paperKey, JSON.stringify(outline));
        dropAnchorCache(paperKey);
        if (!signal.aborted) set(paperKey, { status: "ready", outline });
        return;
      } catch (e: any) {
        if (signal.aborted) return;
        lastErr = e;
      }
    }
    set(paperKey, {
      status: "error",
      message: lastErr?.transport ? String(lastErr.message) : `脉络生成失败：${lastErr?.message || lastErr}`,
      transport: !!lastErr?.transport,
    });
  } catch (e: any) {
    if (!signal.aborted) set(paperKey, { status: "error", message: String(e?.message || e) });
  }
}

/** 请求层面的失败（额度、限速、超时、HTTP 响应体）打上 `transport`，让界面走既有的错误分类口径。 */
function transportError(e: any): Error {
  const err = new Error(String(e?.errorMessage || e?.message || e));
  (err as any).transport = true;
  return err;
}

/** 一次性流式请求：把增量攒起来，并按 PARTIAL_MS 节流回调给上层做「边生成边长树」。 */
async function collect(
  model: ReturnType<typeof getModel>,
  prompt: string,
  level: string,
  attempt: number,
  signal: AbortSignal,
  onPartial: (text: string, thinking: string) => void,
): Promise<string> {
  let text = "";
  let thinking = "";
  let lastEmit = 0;
  try {
    const stream = streamSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        signal,
        maxTokens: 16000,
        // 第二次不再思考：第一遍已经把结构想清楚了，重试只为把 JSON 写完整。
        reasoning: attempt ? undefined : clampThinking(model, level || "medium"),
      },
    );
    for await (const ev of stream as any) {
      if (ev.type === "thinking_delta") {
        thinking = (thinking + (ev.delta || "")).slice(-3000);
      } else if (ev.type === "text_delta") {
        text += ev.delta || "";
      } else if (ev.type === "error") {
        throw new Error(ev.error?.errorMessage || "模型没有返回内容");
      } else {
        continue;
      }
      const now = Date.now();
      if (now - lastEmit < PARTIAL_MS) continue;
      lastEmit = now;
      onPartial(text, thinking);
    }
  } catch (e: any) {
    if (signal.aborted) throw e;
    throw transportError(e);
  }
  if (!text.trim()) throw new Error("模型只回了思考，没有 JSON");
  return text;
}

// ---------------------------------------------------------------------------
// 锚点 → 页面上的框

export interface AnchorRegion {
  pageIndex: number;
  /** 段落/图表的外框（PDF 用户坐标），null = 只能整页跳转。 */
  box: Rect | null;
  /** 外框里更该强调的那几行：逐字关键句。 */
  focus: Rect[];
  text?: string;
  start?: number;
  viewBox?: number[];
}

const charsText = (chars: PdfChar[], from: number, to: number): string =>
  chars
    .slice(from, to)
    .map((c) => c.c ?? "")
    .join("");

/** 把一个锚点换算成页面上的取框；同一篇同一锚点只算一次。 */
export async function resolveAnchor(paperKey: string, anchor: OutlineAnchor): Promise<AnchorRegion | null> {
  if (!anchor.page) return null;
  const pageIndex = anchor.page - 1;
  const key = `${paperKey}|${pageIndex}|${anchor.quote || ""}|${anchor.figure || ""}|${anchor.caption || ""}`;
  const hit = regionCache.get(key);
  if (hit) return hit;
  let region: AnchorRegion = { pageIndex, box: null, focus: [] };
  try {
    const data = await getPageData(paperKey, pageIndex);
    const chars = data.chars;
    if (chars.length) {
      const index = buildCharIndex(chars);
      const fig = anchor.figure ? parseFigureLabel(anchor.figure) : null;
      const cap = anchor.caption ? findQuote(chars, anchor.caption.slice(0, 60), index) : null;
      if (fig && cap) {
        const box = figureRegion(chars, cap[0], cap[1], fig.kind);
        // viewBox 一起带上：阅读器的 highlightRects 只认 PDF 用户坐标 + 页面视口，缺了就画不出框。
        if (box) region = { pageIndex, box, focus: [], viewBox: data.viewBox };
      } else if (anchor.quote) {
        const m = findQuote(chars, anchor.quote, index);
        if (m) {
          const [ps, pe] = paragraphRange(chars, m[0], m[1]);
          region = {
            pageIndex,
            box: unionRects(getRangeRects(chars, ps, pe)),
            focus: getRangeRects(chars, m[0], m[1]),
            text: charsText(chars, m[0], m[1]),
            start: m[0],
            viewBox: data.viewBox,
          };
        }
      }
    }
  } catch {
    // 没有文字层/那一页取不到：退回整页跳转，由调用方说明「没圈中原句」
  }
  regionCache.set(key, region);
  return region;
}

/**
 * 点一条脉络：翻到那一页，并把节点里的逐字关键句圈出来。
 *
 * 圈不住（扫描件、跨页拼接、模型改写了原句）也要如实返回 `ok:false`：面板会说明「只跳到了页」，
 * 而不是让读者以为屏幕上那圈就是依据。
 */
export async function revealAnchor(paperKey: string, anchor: OutlineAnchor): Promise<{ ok: boolean; page: number; text?: string }> {
  const page = anchor.page || 1;
  const region = await resolveAnchor(paperKey, anchor);
  gotoPage(page);
  const rects = region?.focus.length ? region.focus : region?.box ? [region.box] : [];
  if (region?.viewBox && rects.length) {
    highlightRects(region.pageIndex, rects, region.viewBox, true);
    return { ok: true, page, text: region.text };
  }
  return { ok: false, page };
}
