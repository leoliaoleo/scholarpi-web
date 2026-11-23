/**
 * 「继续研究」— four one-click workflows that turn the agent into a research
 * assistant with a procedure, not just a chat box.
 *
 * A skill does the deterministic part in code (fetch the citation graph, collect the
 * metadata cards), then hands the model a prompt that embeds what it gathered. The result
 * travels through the normal paper session, so streaming, `[p. 5]` chips, page jumps and
 * annotations keep working; the candidate list the scout collects is what the 一键入库
 * button in the chat panel imports.
 */
import { arxivSearch, semanticGraph } from "./academic";
import { globalEvents } from "./events";
import { cardView, importIdentifiers, listCards, searchLibrary, type ImportResult } from "./library";
import { toSemanticId } from "./mcp";
import { getItem, getPaperText, hasPdfLoaded, listPapers, paperTitle, type Paper } from "./paper";
import { clip } from "./tools/common";

export type SkillId = "scout" | "anatomy" | "matrix" | "gap";

export interface SkillMeta {
  id: SkillId;
  icon: string;
  label: string;
  /** one line, shown under the button */
  desc: string;
  /** paper = the open paper, papers = a 2–5 selection, topic = an optional keyword box */
  needs: "paper" | "papers" | "topic";
  hint: string;
}

export const SKILLS: SkillMeta[] = [
  {
    id: "scout",
    icon: "🔭",
    label: "找相关论文",
    desc: "奠基工作、后续跟进与推荐阅读顺序",
    needs: "paper",
    hint: "以当前论文为种子找上下游，挑中的可以一键入库。",
  },
  {
    id: "anatomy",
    icon: "🔬",
    label: "拆解方法",
    desc: "核心痛点 → 架构 → 损失函数 → 消融结论",
    needs: "paper",
    hint: "按需读原文与图表，产出可复现的方法拆解。",
  },
  {
    id: "matrix",
    icon: "📊",
    label: "跨篇对比",
    desc: "2–5 篇文献排一张差异表",
    needs: "papers",
    hint: "在左侧文献列表勾选 2–5 篇后使用。",
  },
  {
    id: "gap",
    icon: "🧭",
    label: "寻找研究方向",
    desc: "从知识库归纳空白并给出可执行选题",
    needs: "topic",
    hint: "可填写感兴趣的方向，留空则分析整个知识库。",
  },
];

export type CandidateGroup = "foundation" | "followup" | "related";

export interface SkillCandidate {
  /** what kb_import / 一键入库 feeds: an arXiv id when there is one, else a DOI */
  identifier: string;
  title: string;
  authors: string;
  year: string;
  venue: string;
  citations: number;
  why: string;
  group: CandidateGroup;
  inLibrary: boolean;
}

export interface SkillRun {
  id: SkillId;
  label: string;
  icon: string;
  itemKey: string;
  paperTitle: string;
  prompt: string;
  note: string;
  candidates: SkillCandidate[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// the run the chat panel should render (skills are one at a time by nature)

let last: SkillRun | null = null;

export function lastSkillRun(): SkillRun | null {
  return last;
}

export function clearSkillRun(): void {
  last = null;
}

/** File the scout's recommendations into the library; rows come back in candidate order. */
export async function grabCandidates(
  candidates: SkillCandidate[],
  opts: { collectionId?: string; onOne?: (r: ImportResult, i: number) => void } = {},
): Promise<ImportResult[]> {
  const todo = candidates.filter((c) => c.identifier && !c.inLibrary);
  if (!todo.length) return [];
  const rows = await importIdentifiers(todo.map((c) => c.identifier), opts);
  rows.forEach((r, i) => {
    if (r.ok) todo[i].inLibrary = true;
  });
  globalEvents.emit({ type: "skill-imported", added: rows.filter((r) => r.ok).length });
  return rows;
}

// ---------------------------------------------------------------------------
// entry point

export async function runSkill(
  id: SkillId,
  opts: { itemKey?: string; itemKeys?: string[]; query?: string; signal?: AbortSignal } = {},
): Promise<SkillRun> {
  const meta = SKILLS.find((s) => s.id === id);
  if (!meta) throw new Error(`未知技能 ${id}`);
  const item = pickPaper(opts.itemKey);
  const built =
    id === "scout"
      ? await buildScout(item, opts.signal)
      : id === "anatomy"
        ? await buildAnatomy(item)
        : id === "matrix"
          ? await buildMatrix(opts.itemKeys?.length ? opts.itemKeys : [item.itemKey])
          : await buildGap(String(opts.query || "").trim(), item);
  last = {
    id,
    label: meta.label,
    icon: meta.icon,
    itemKey: item.itemKey,
    paperTitle: paperTitle(item),
    prompt: built.prompt,
    note: built.note,
    candidates: built.candidates,
    createdAt: Date.now(),
  };
  globalEvents.emit({ type: "skill-run", skill: id, itemKey: item.itemKey, note: built.note });
  return last;
}

function pickPaper(itemKey?: string): Paper {
  const hit = itemKey ? getItem(itemKey) : null;
  if (hit) return hit;
  const all = listPapers();
  if (!all.length) throw new Error("知识库是空的：先导入一篇论文（本地 PDF 或 arXiv 链接）再使用技能。");
  return all[0];
}

// ---------------------------------------------------------------------------
// 1) 文献侦察兵

async function buildScout(item: Paper, signal?: AbortSignal): Promise<{ prompt: string; note: string; candidates: SkillCandidate[] }> {
  const seedId = toSemanticId(item.DOI || item.itemKey || item.url);
  const [refs, cites] = await Promise.all([
    semanticGraph(seedId, "references", { limit: 24, signal }).catch(() => null),
    semanticGraph(seedId, "citations", { limit: 24, signal }).catch(() => null),
  ]);
  const seedYear = Number(item.year) || 0;
  const byCitations = (a: any, b: any) => Number(b.citationCount || 0) - Number(a.citationCount || 0);
  const foundational = (refs || []).filter((p: any) => p?.title).sort(byCitations).slice(0, 8);
  const followups = (cites || [])
    .filter((p: any) => p?.title)
    .sort((a, b) => byCitations(a, b) || String(b.year || "").localeCompare(String(a.year || "")))
    .slice(0, 8);
  let candidates: SkillCandidate[] = [
    ...foundational.map((p) => toCandidate(p, "foundation")),
    ...followups.map((p) => toCandidate(p, "followup", seedYear)),
  ];
  let note = `引用图：奠基 ${foundational.length} 篇 / 后续 ${followups.length} 篇`;

  // Throttled or an id Semantic Scholar does not know: arXiv's own search is a decent stand-in.
  if (!candidates.length) {
    const phrase = String(item.title || "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(" ");
    try {
      const r = await arxivSearch(`all:"${phrase}"`, { max: 10, signal });
      candidates = r.entries
        .filter((e) => e.id && e.id !== item.itemKey)
        .map((e) => ({
          identifier: e.id,
          title: e.title.replace(/\s+/g, " "),
          authors: e.authors.slice(0, 3).join(", "),
          year: e.published.slice(0, 4),
          venue: "arXiv",
          citations: 0,
          why: "主题相近（引用图数据未取到）",
          group: "related" as CandidateGroup,
          inLibrary: inLibrary(e.id, ""),
        }));
      note = `引用图数据不可用（限流或 id 未收录），改用 arXiv 主题检索，命中 ${candidates.length} 篇`;
    } catch (e: any) {
      note = `引用数据抓取失败：${String(e?.message || e).slice(0, 60)}；模型会改用 academic__semantic_scholar_citations 工具重试`;
    }
  }

  const section = (group: CandidateGroup, title: string) => {
    const rows = candidates.filter((c) => c.group === group);
    return `${title}：\n${rows.length ? rows.map(candidateLine).join("\n") : "（无数据）"}`;
  };
  const groups = [
    section("foundation", "A. 奠基工作（本论文引用的文献）"),
    "",
    section("followup", "B. 后续工作（引用本论文的文献）"),
  ];
  if (candidates.some((c) => c.group === "related")) groups.push("", section("related", "C. 主题相近的文献"));

  const prompt = `【科研技能 · 找相关论文】以《${paperTitle(item)}》（item_key=${item.itemKey}${seedYear ? `，${seedYear} 年` : ""}）为种子论文做文献侦察。

本地已抓到的引用关系（可直接使用，不必重复抓取）：
${groups.join("\n")}

请输出：
1. **研究脉络**：3–5 句话说明这篇论文站在哪些工作之上、又被谁接续，点出关键作者与团队。
2. **推荐阅读顺序**：从上面挑 5–8 篇，按"先补基础 → 再看竞争方法 → 最后看改进"排序，每篇一行：标题（年份，被引数）— 为什么读它 — 精读还是泛读。
3. **值得跟进的线索**：哪些后续工作提出了新问题，或反驳、修正了本文的假设。
4. **入库建议**：指出哪几篇最该收进知识库，提醒用户可点「一键入库」；需要补充的条目用 kb_import 抓取。
标了「已在库中」的不要再重复推荐。外部结论不确定时用 academic__semantic_scholar_citations 或 arxiv_search 核实，不要编造引用数。`;
  return { prompt, note, candidates };
}

function toCandidate(p: any, group: CandidateGroup, seedYear = 0): SkillCandidate {
  const ext = p.externalIds || {};
  const arxiv = String(ext.ArXiv || "");
  const doi = String(ext.DOI || "");
  const year = String(p.year || "");
  const venue = String(p.venue || "").trim() || (arxiv ? "arXiv" : "");
  const why = group === "foundation" ? "被本论文引用" : group === "followup" ? `引用本论文${year ? `（${year}）` : ""}` : "主题相近";
  return {
    identifier: arxiv || (doi ? `doi:${doi}` : ""),
    title: String(p.title || "").replace(/\s+/g, " "),
    authors: (p.authors || []).slice(0, 3).map((a: any) => a.name).join(", "),
    year,
    venue,
    citations: Number(p.citationCount || 0),
    why,
    group,
    inLibrary: inLibrary(arxiv, doi),
  };
}

function inLibrary(arxiv: string, doi: string): boolean {
  if (arxiv && getItem(arxiv)) return true;
  const d = doi.toLowerCase();
  return !!d && listPapers().some((p) => p.DOI && p.DOI.toLowerCase() === d);
}

function candidateLine(c: SkillCandidate): string {
  return `- ${c.identifier || "无标识符"} | ${clip(c.title, 90)} | ${c.authors || "作者未知"} | ${c.year || "?"} | ${c.venue || "?"} | 被引 ${c.citations}${c.inLibrary ? " | 已在库中" : ""}`;
}

// ---------------------------------------------------------------------------
// 2) 方法论解剖室

async function buildAnatomy(item: Paper): Promise<{ prompt: string; note: string; candidates: SkillCandidate[] }> {
  const card = await cardView(item);
  const known = [card.method && `核心方法：${clip(card.method, 400)}`, card.datasets && `数据集：${clip(card.datasets, 240)}`, card.metrics && `关键指标：${clip(card.metrics, 300)}`]
    .filter(Boolean)
    .join("\n");
  const prompt = `【科研技能 · 拆解方法】解剖《${paperTitle(item)}》（item_key=${item.itemKey}）的方法。
${hasPdfLoaded(item) ? "PDF 已解析，可直接检索原文。" : "先用 paper_overview 看结构，再 paper_search 定位、paper_read 精读，不要一次读全文。"}
${known ? `\n知识库卡片里已有这些信息（核对后补充，不要照抄）：\n${known}\n` : ""}
按四步解剖，每步都给出原文依据（页码写成可点击的 [p. N](page:N?q=…) 引用，公式用 $...$）：

1. **核心痛点**：论文要解决什么、现有方法卡在哪（3–6 点，点名被引工作）。
2. **网络/算法架构**：输入 → 模块 → 输出的数据流，标出关键超参（层数、维度、头数、容量）。用 \`\`\`mermaid flowchart TD 画管线，节点标签写模块名和张量形状。涉及架构图时用 view_page_image 看图，别只靠正文猜。
3. **损失函数**：逐项写出公式和直觉含义，说明权重、温度、掩码等细节，以及与 baseline 损失的区别。
4. **消融实验结论**：每个消融变体去掉或换掉了什么、指标变化多少（照抄表里的数字，不要估算），并总结哪个组件最关键、哪个其实可省。

收尾给：**复现要点**（数据规模、训练预算、易踩的坑）+ **一句话方法定位**。
原文没写的项就明确写"论文未给出"，不要编造。
最后把方法要点写回知识库：用 kb_update_card 更新 核心方法 / 数据集 / 关键指标 / 一句话总结。`;
  return { prompt, note: card.method ? "已带上库内卡片" : "该论文还没有卡片，回答后可用 kb_update_card 补全", candidates: [] };
}

// ---------------------------------------------------------------------------
// 3) 跨篇对比

/** 判定全文可用性时给一个上限：慢链接只牺牲自己，不拖住对比启动。 */
function withTextTimeout<T>(p: Promise<T>, ms = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("全文加载超时")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function buildMatrix(itemKeys: string[]): Promise<{ prompt: string; note: string; candidates: SkillCandidate[] }> {
  const keys = [...new Set(itemKeys)].filter((k) => !!getItem(k)).slice(0, 5);
  if (keys.length < 2) throw new Error("跨篇对比需要至少 2 篇文献：在左侧文献列表勾选后再运行。");
  const cards = await Promise.all(keys.map((k) => cardView(getItem(k)!)));

  // 先判定每篇是否有可用全文：仅链接 / 下载失败 / 扫描件（无文字层）都算「无全文」，
  // 不进入对比表；剩下有全文的继续生成，避免缺几篇 PDF 就整体失败。
  const readable = await Promise.all(
    keys.map(async (k) => {
      const it = getItem(k)!;
      if (it.source !== "demo" && it.source !== "upload" && !it.pdfUrl) return false;
      try {
        const t = await withTextTimeout(getPaperText(it));
        return t.pages.some((p) => p.trim().length > 0);
      } catch {
        return false;
      }
    }),
  );
  const kept = cards.filter((_, i) => readable[i]); // 有全文 --- 进表
  const skipped = cards.filter((_, i) => !readable[i]); // 没有全文 --- 不进表
  if (kept.length < 2) {
    const names = skipped.map((c) => `《${c.title}》`).join("、");
    throw new Error(
      `勾选的文献里只有 ${kept.length} 篇有可用 PDF 全文，无法生成横向对比。缺少全文的文献：${names || "（无）"}。可尝试：导入本地 PDF、换用 arXiv 文字版，或改勾其它文献。`,
    );
  }
  const blocks = kept.map((c, i) =>
    [
      `### [${i + 1}] ${c.title}`,
      `${c.authors || "作者未知"} | ${c.year || "?"} | ${c.venue || "?"}${c.DOI ? ` | DOI:${c.DOI}` : ""} | item_key=${c.itemKey}`,
      c.method && `核心方法: ${clip(c.method, 350)}`,
      c.datasets && `数据集: ${clip(c.datasets, 200)}`,
      c.metrics && `关键指标: ${clip(c.metrics, 300)}`,
      c.summary && `一句话总结: ${clip(c.summary, 160)}`,
      c.keywords && `关键词: ${clip(c.keywords, 160)}`,
      c.abstract && `摘要: ${clip(c.abstract, 500)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const missing = kept.filter((c) => !c.method && !c.metrics);
  const prompt = `【科研技能 · 跨篇对比】对比下面 ${kept.length} 篇文献。知识库卡片先用来填表，缺的字段再查原文。

${blocks.join("\n\n")}

输出一张 Markdown 表格，列为：
| 论文（年份，venue）<br>item_key=… | 核心思路 | 模型复杂度 | 关键 SOTA 指标 | 数据集/评测 | 局限性 |
首列那一格把短名、年份、venue 和这一篇的 item_key 一起写全（例：Transformer（2017，NeurIPS）<br>item_key=1706.03762）——读者要按行首的 item_key 回原文核对，界面也靠它把页码认回正确的论文。
每格控制在 30 字内；一格要写两层信息就用 <br> 换行，别塞竖线；指标要带数字和对比基准（例如 "top-1 25.03%（较 plain-34 +3.5pt）"）；没有依据的格子写 "待核对"，并说明该去哪一页确认。
表格之后给：
1. **按场景的选型建议**：只说"什么情况下该选哪篇"，条件落在任务类型、数据规模、算力预算、是否易复现这些场景上；不要排名。
2. **分歧点**：这些论文结论互相矛盾或假设不同的地方。
3. **演进关系**：谁沿用了谁的做法（用 \`\`\`mermaid flowchart TD）。

页码引用一律写成可点芯片，并把目标论文的 item_key 一起带上，否则点只会翻错论文：
✅ [Transformer · p. 2](page:2?q=Attention%20Is%20All%20You%20Need&k=1706.03762)
❌ [p. 2](page:2?q=Attention%20Is%20All%20You%20Need) —— 少了 &k=，点它只会翻到当前那篇的第 2 页，看着生效其实全错。
正文、表格、按场景的选型建议里的每一处 page: 链接都必须带 &k=，值取它所在那一行首列的 item_key；整篇回答里不允许出现不带 k= 的页码芯片。
每篇先定一个不超过 12 字的短名（模型名或方法名），芯片标签写成「短名 · p. N」，全表与后面各节都用同一个短名；q= 只填原文里逐字出现的短语（≤12 个词，空格写成 %20），拿不准就退成 [短名 · p. N](page:N&k=<item_key>)。

可比性红线：这几篇的任务与评价口径不同（评测集、预处理、指标定义、训练算力、参数量、是否用外部数据都可能不一样），因此表里的数字不是同条件对比。禁止据此给出统一的优劣排名或"谁最强"的综合结论，也禁止仅凭跨任务指标数字或训练硬件（GPU 数量、训练时长）判定高下——差异要落成适用场景。
最后必须另起一段「⚠️ 可比性说明」：明确写出这些论文的任务与数据集口径并不相同，表里的数字不能直接同条件比较；请读者按行首的 item_key 回到原文核对指标与评价协议后再做选型。这一附注是输出的一部分，不能省略。
${skipped.length ? `\n已跳过 ${skipped.length} 篇没有可用 PDF 全文的文献：${skipped.map((c) => `《${c.title}》`).join("、")}。它们不在对比表中，不要调用 paper_read / paper_search 去读它们。\n` : ""}${missing.length ? `\n这几篇还没有元数据卡片：${missing.map((c) => c.title).join("、")}。请用 paper_search / paper_read 补齐，并用 kb_update_card 写回。\n` : ""}
需要读某篇原文时用对应 item_key 调用 paper_overview / paper_search / paper_read。`;
  const note = `${kept.length} 篇进入对比${skipped.length ? `，${skipped.length} 篇无 PDF 已跳过` : ""}${missing.length ? `，其中 ${missing.length} 篇缺卡片` : ""}`;
  return { prompt, note, candidates: [] };
}

// ---------------------------------------------------------------------------
// 4) Research Gap 选题挖掘

async function buildGap(query: string, item: Paper): Promise<{ prompt: string; note: string; candidates: SkillCandidate[] }> {
  let blocks: string[] = [];
  let note = "";
  if (query) {
    const r = await searchLibrary({ query, limit: 12 }).catch(() => null);
    blocks = (r?.hits || []).map((h) => `### ${h.title}\n${h.authors} | ${h.year || "?"} | ${h.venue || "?"} | item_key=${h.itemKey}\n命中：${clip(h.snippet, 320)}`);
    note = `按「${query}」检索知识库，命中 ${blocks.length} 篇（引擎 ${r?.engine || "none"}）`;
  } else {
    const cards = (await listCards()).filter((c) => c.summary || c.method || c.metrics);
    blocks = cards.slice(0, 16).map(
      (c) =>
        `### ${c.title}\n${c.authors || "作者未知"} | ${c.year || "?"} | ${c.venue || "?"} | item_key=${c.itemKey}\n方法：${clip(c.method, 220)}\n指标：${clip(c.metrics, 220)}\n总结：${clip(c.summary, 180)}`,
    );
    note = blocks.length ? `用了知识库中 ${blocks.length} 篇的元数据卡片` : "知识库还没有卡片：先生成几张（kb_generate_card）或让模型边读边总结";
  }
  const prompt = `【科研技能 · 寻找研究方向】${query ? `围绕方向「${query}」` : `基于整个知识库${item ? `（当前论文《${paperTitle(item)}》作为切入点）` : ""}`}找研究空白并产出选题。

相关材料：
${blocks.join("\n\n") || "（知识库为空：先用 kb_import 导入几篇，或用 academic__arxiv_search 检索后入库。）"}

请输出：
1. **共性梳理**：这些工作共同假设了什么、评测口径有什么惯例、大家都在回避什么（每条点名具体论文）。
2. **三类空白**：数据/评测空白、方法空白、应用场景空白，各说明"为什么现在还是空白"；需要核实时用 academic__semantic_scholar_citations、academic__arxiv_search 或 web_search 查证有没有人做过，并给出依据。
3. **候选研究方向及核验建议（5 个可执行选题）**，每个含：问题定义（一句话）｜切入角度｜最小实验设计（数据集 + 基线 + 指标 + 预计算力和时间）｜风险与退路｜适合投的会议或期刊。这一节的标题就写成「候选研究方向及核验建议」：每个选题都要分开写明哪些前提已由上面文献核实、哪些还需要查证或做实验，不要把候选方向说成已被证明的结论或现成的创新点。
4. **下一步**：挑 2–3 篇最该补的文献用 kb_import 入库，并建议用 kb_create_collection 新建一个专题收纳选题材料。
选题要落在学生或小团队能执行的尺度，不要依赖超大算力或私有数据。`;
  return { prompt, note, candidates: [] };
}
