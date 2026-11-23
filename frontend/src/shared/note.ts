/**
 * 把会话里的报告变成一份能带走的 Markdown 笔记。
 *
 * 只做字符串工作：内容来自调用方（当前会话 / 当前回答），这里负责补上论文标题、来源、
 * 年份或 arXiv 标识、导出日期，并把 `[原文](page:5?q=…)` 这类只在应用内有效的跳转降级成
 * 纯文本页码 `[p. 5]`——笔记被复制到 Obsidian、微信或打印出来之后，链接不该是死的路由协议。
 */

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;

/** arXiv 标识：demo/导入论文的 itemKey 本身就是 arXiv id，其次是 url 里的 /abs/xxx。 */
export function arxivIdOf(...candidates: (string | undefined | null)[]): string {
  for (const raw of candidates) {
    const s = String(raw || "");
    if (!s) continue;
    const m = s.match(/arxiv\.org\/(?:abs|pdf)\/([^\s/?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
    if (m && ARXIV_ID.test(m[1])) return m[1];
    const id = s.split("/").pop() || "";
    if (ARXIV_ID.test(id)) return id;
  }
  return "";
}

/** `[label](page:5?q=…)` / `[label](annotation:…)` → 纯文本，页码留在正文里。 */
export function plainCitations(md: string): string {
  const CITE = /\[([^\]]*)\]\(((?:page|annotation):[^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  return String(md || "").replace(CITE, (_all, labelRaw: string, hrefRaw: string) => {
    const label = String(labelRaw || "").trim();
    const page = String(hrefRaw || "").match(/^page:\s*(\d+)/i)?.[1];
    if (!page) return label;
    // 「[p. 5](page:5?q=…)」的可见文字已经是页码本身，直接留 [p. 5]；引文型标签则附在句尾。
    if (/^p\.?\s*\d+$/i.test(label)) return `[p. ${page}]`;
    // 跨篇对比的芯片长成「[Transformer · p. 2](page:2?…)」：标签里已经写着同一个页码，别再重复一遍，
    // 但方括号要留在笔记里——它是一条引用，不是一句普通 prose。
    if (new RegExp(`p\\.?\\s*${page}\\b`, "i").test(label)) return `[${label}]`;
    return label ? `${label} [p. ${page}]` : `[p. ${page}]`;
  });
}

export interface PageChip {
  page: number;
  /** 已经解码过的原文，交给 `api.openPage` 圈句子；没有就只跳页。 */
  quote: string;
  /** 跨篇对比的芯片带着目标论文 itemKey；单篇报告不带，点击时退回当前论文。 */
  key?: string;
}

/** 报告里真实可点的页码证据：欢迎区的「示例预览」复用同一批芯片，不另写一套引用。 */
export function pageChips(md: string): PageChip[] {
  const CHIP = /\[((?:[^\]]|\[[^\]]*\])*?)\]\(page:(\d+)(?:\?q=([^)&]*))?(?:&k=([^)\s]*))?\)/g;
  const out: PageChip[] = [];
  for (const m of String(md || "").matchAll(CHIP)) {
    const page = Number(m[2]);
    if (!page) continue;
    let quote = "";
    try {
      quote = decodeURIComponent(String(m[3] || "").replace(/\+/g, " ")).trim();
    } catch {
      quote = "";
    }
    const key = String(m[4] || "").trim();
    out.push({ page, quote, ...(key ? { key } : {}) });
  }
  return out;
}

/** 收成预览用的一行纯文本：链接降级成页码、公式与强调符号去掉，行首的列表符也不留。 */
export function plainLine(md: string): string {
  return plainCitations(md)
    .replace(/\$\$?[^$]*\$\$?/g, "")
    .replace(/[*_`>#|]/g, "")
    .replace(/^\s*[-+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NoteSource {
  /** 论文标题；对比矩阵一类的多文献任务传任务名。 */
  title: string;
  authors?: string;
  year?: string;
  venue?: string;
  /** 有 arXiv id 时优先于 DOI 展示。 */
  arxiv?: string;
  doi?: string;
  /** 没有任何外部标识时说明文献从哪来（本地 PDF / 演示论文）。 */
  origin?: string;
  /** 预置示例精读：内容不是这次对话生成的，必须在笔记里写明。 */
  preset?: boolean;
}

export interface NoteSection {
  heading: string;
  body: string;
}

/** 一问一答 → 章节：问答顺序就是笔记的阅读顺序，空回答不成节。 */
export function transcriptSections(turns: { q: string; a: string }[]): NoteSection[] {
  const out: NoteSection[] = [];
  for (const t of turns || []) {
    const q = String(t?.q || "").trim();
    const a = String(t?.a || "").trim();
    if (!a) continue;
    out.push({ heading: q ? `问：${clip(q.replace(/\s+/g, " "), 120)}` : "回答", body: a });
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function dayOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sourceLine(src: NoteSource): string {
  const id = src.arxiv ? `arXiv:${src.arxiv}` : src.doi ? `DOI:${src.doi}` : src.origin || "";
  return [src.year, src.venue, id].filter(Boolean).join(" · ") || "来源未记录";
}

/**
 * 一份笔记的全部文本。章节之间用 `---` 分隔，页码引用统一降级为 `[p. N]`。
 * 头部只写已知字段：库里没记年份就不编年份。
 */
export function buildNote(
  src: NoteSource,
  sections: NoteSection[],
  opts: { exportedAt?: number; heading?: string; note?: string } = {},
): string {
  const at = opts.exportedAt ?? Date.now();
  const head: string[] = [`# ${String(src.title || "未命名文献").trim()} · ${opts.heading || "精读报告"}`, ""];
  head.push(`- 来源：${sourceLine(src)}`);
  if (src.authors) head.push(`- 作者：${clip(src.authors, 160)}`);
  if (src.arxiv && src.doi) head.push(`- DOI：${src.doi}`);
  head.push(`- 导出：${dayOf(at)}`);
  if (src.preset) head.push("- 说明：示例精读 · 预置内容（ScholarPi Web 随站打包的解读，非本次对话生成）");
  head.push("", "> 页码 [p. N] 指该论文 PDF 的物理页；在 ScholarPi Web 中打开原文可逐页核对。", "");
  if (opts.note) head.push(`**说明：** ${opts.note}`, "");

  const body = (sections || [])
    .filter((s) => String(s?.body || "").trim())
    .map((s) => [`## ${s.heading}`, "", plainCitations(s.body.trim()).trim(), ""].join("\n"))
    .join("\n---\n\n");
  return [head.join("\n"), body].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** 文件名去掉路径非法字符，留标题前缀方便在 Downloads 里认出来。 */
export function noteFileName(src: NoteSource, heading = "精读报告", at?: number): string {
  const base = `${String(src.title || "文献").replace(/[\\/:*?"<>|#%]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)}-${heading}`;
  const stamp = dayOf(at ?? Date.now()).slice(0, 10).replace(/-/g, "");
  return `${base}-${stamp}.md`;
}
