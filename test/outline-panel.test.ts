/**
 * 论文脉络（借鉴队友 zotero-coread-ai 的增量）在我们这一层的回归锁。
 *
 * 引擎是纯函数，已由 test/outline-core.test.ts 直接调用；这里守的是移植时的四个取舍：
 * 缓存键与阅读器 docKey 同格式（两边的脉络 JSON 能互导）、打开面板绝不发模型请求
 * （不自动烧演示额度）、圈不到原句必须明说（跳页 ≠ 定位成功）、复用既有 NoteActions
 * 与纸墨变量而不引入新配色。UI 组件带浏览器依赖跑不了，按仓库既有办法断言源码。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  gotoPage,
  highlightRects,
  paperKey,
  refFromPaperKey,
  viewerCommands,
  type ViewerCommand,
} from "../frontend/src/core/viewer-state.ts";
import { RELATION_LABELS, buildOutlineInput, outlineToMarkdown, type PaperOutline } from "../frontend/src/core/outline-schema.ts";

const source = (rel: string) => readFileSync(new URL(`../frontend/src/${rel}`, import.meta.url), "utf8");

// --------------------------------------------------------------------------- 键与命令通道

test("脉络缓存键就是阅读器的 docKey：${libraryID}/${itemKey}，与桌面版 paperKey(ref) 同格式", () => {
  // 真实往返：这是跨端互导缓存的前提，格式错了不会报错，只会各自攒一份缓存。
  const key = "3/ABCD1234";
  assert.equal(paperKey(refFromPaperKey(key)), key);
  assert.deepEqual(refFromPaperKey(key), { libraryID: 3, itemKey: "ABCD1234" });

  const engine = source("core/outline.ts");
  assert.match(engine, /export const OUTLINE_KV_PREFIX = "outline:v1:"/, "键前缀要和桌面版一致，才能读出同一份缓存");
  assert.match(engine, /kvGet\(OUTLINE_KV_PREFIX \+ paperKey\)/);
  assert.match(engine, /getItem\(refFromPaperKey\(paperKey\)\)/, "getItem 吃的是 bare itemKey，必须先从 docKey 还原");
  assert.doesNotMatch(engine, /getItem\(paperKey\)/, "直接塞 docKey 会查不到文献");
  // 取文字层用同一个 key：阅读器缓存页数据时也按 docKey 存。
  assert.match(engine, /getPageData\(paperKey, pageIndex\)/);
  // 重开面板要先看见缓存，而不是停在上一轮的失败提示上。
  assert.match(engine, /if \(cur\.status === "loading" \|\| cur\.status === "ready"\) return cur;/, "缓存优先于旧的失败提示");
});

test("脉络跳转走阅读器命令：goto + highlight(keep)，不是自己伸手改 DOM", () => {
  const seen: ViewerCommand[] = [];
  const off = viewerCommands.on((c) => seen.push(c));
  gotoPage(5);
  highlightRects(4, [[1, 2, 3, 4]], [0, 0, 612, 792], true);
  off();
  assert.deepEqual(seen, [
    { type: "goto", page: 5, smooth: true },
    { type: "highlight", pageIndex: 4, rects: [[1, 2, 3, 4]], viewBox: [0, 0, 612, 792], keep: true },
  ]);

  const engine = source("core/outline.ts");
  assert.match(engine, /const rects = region\?\.focus\.length \? region\.focus : region\?\.box \? \[region\.box\] : \[\]/, "先圈关键句，退一步才圈整段/图表");
  assert.match(engine, /return \{ ok: false, page \};/, "什么框都算不出来时要承认，别回一个空高亮假装成功");
  assert.match(engine, /region = \{ pageIndex, box, focus: \[\], viewBox: data\.viewBox \}/, "图表分支也要带 viewBox：阅读器的 highlightRects 缺了它一个框都画不出");
});

// --------------------------------------------------------------------------- 不自动烧额度

test("打开脉络面板只读缓存，生成必须由读者点出来", () => {
  const panel = source("web/outline.tsx");
  const effect = panel.match(/useEffect\(\(\) => \{[\s\S]{0,400}?\}, \[paperKey\]\)/)?.[0] || "";
  assert.ok(effect, "换论文时要有一个按 paperKey 重置的副作用");
  assert.match(effect, /void loadOutline\(paperKey\)/, "挂载只读缓存");
  assert.doesNotMatch(effect, /generateOutline/, "挂载绝不能自己发模型请求：演示额度是读者的");
  assert.match(panel, /onClick=\{\(\) => generateOutline\(paperKey\)\}/);
  assert.match(panel, /会用掉一次演示额度/, "第一次生成本地要先说清代价");
  assert.match(panel, /title="重新梳理一次（会再用一次演示额度）"/);

  // 阅读器那边同理：入口只是个开关，不碰模型。
  const viewer = source("web/viewer.tsx");
  assert.match(viewer, /const \[outlineOn, setOutlineOn\] = useState\(false\)/, "默认收起：首屏不能因为新功能变挤");
  assert.match(viewer, /aria-pressed=\{outlineOn\}[\s\S]{0,120}onClick=\{\(\) => setOutlineOn\(!outlineOn\)\}/);
  assert.match(viewer, /\{outlineOn && item && docKey && doc && \(/, "没有打开的论文就不该出现脉络卡");
  assert.doesNotMatch(viewer, /generateOutline/, "工具栏按钮只负责显示面板");
});

test("没圈中原句要说「人工核对」，划重点走既有批注 API", () => {
  const panel = source("web/outline.tsx");
  assert.match(panel, /if \(!r\.ok\) \{/, "跳页成功不等于定位成功");
  assert.match(panel, /没找到脉络引用的原句[\s\S]{0,80}人工核对/);
  assert.match(panel, /createHighlight\(item, \{ quote: a\.quote, page: a\.page, comment: `脉络 · \$\{n\.title\}` \}\)/, "复用 annotate 的高亮落库，别在面板里自己造批注");
  assert.doesNotMatch(panel, /saveSelectionAsHighlight|indexedDB|localStorage/, "面板不直接碰存储");
  assert.match(panel, /划不了重点/, "没有逐字原句的节点要直说，而不是划一个凭空的框");
});

test("脉络导出复用 NoteActions：复制、降级下载与文案口径都跟着既有那份", () => {
  const panel = source("web/outline.tsx");
  assert.match(panel, /import \{ NoteActions, QuickError \} from "\.\/components"/);
  assert.match(panel, /build=\{\(\) => outlineToMarkdown\(st\.outline\)\}/);
  assert.match(panel, /copyLabel="复制脉络 Markdown"/);
  assert.match(panel, /noteFileName\(\{ title: item\.title \|\| "文献" \}, "文章脉络"\)/, "文件名跟着论文标题走");
  assert.doesNotMatch(panel, /navigator\.clipboard/, "复制的实现只留在 components.tsx 一处");
});

test("脉络失败分两类：请求层走既有错误分类，自己判定的照原话说", () => {
  const panel = source("web/outline.tsx");
  assert.match(panel, /st\.transport \? <QuickError error=\{st\.message\} \/> : <p class="ol-error">\{st\.message\}<\/p>/, "HTTP 响应体不能原样端给读者：请求失败要进 classifyError 那套文案");
  assert.match(panel, /import \{ NoteActions, QuickError \} from "\.\/components"/, "错误框复用同一个组件，不再造一套措辞");

  const engine = source("core/outline.ts");
  assert.match(engine, /\(err as any\)\.transport = true/);
  assert.match(engine, /if \(signal\.aborted\) throw e;/, "读者按停止不是失败，别弹错误框");
  assert.match(engine, /transport: !!lastErr\?\.transport/);
  assert.match(engine, /没有可读的文字层[\s\S]{0,160}arXiv/, "扫描版要给出去处：换文字版 PDF");
  assert.doesNotMatch(engine, /没有可读的文字层[\s\S]{0,120}transport/, "这类失败是我们自己判定的，不该被改写成「这次请求没有成功」");
});

// --------------------------------------------------------------------------- 纸墨风
test("脉络面板只用既有设计变量，不新增配色", () => {
  const css = source("styles/app.css");
  const block = css.match(/\/\* 文章脉络[\s\S]*?(?=\/\* quick card docked)/)?.[0] || "";
  assert.ok(block.length > 600, "脉络样式要成一段，别散在文件各处");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "新组件不许带十六进制色值：纸墨底色的唯一来源是 --bg/--bg2/--fg/--muted/--border/--accent");
  for (const token of ["var(--bg)", "var(--border)", "var(--muted)", "var(--shadow)", "var(--serif)"]) {
    assert.ok(block.includes(token), `缺 ${token}`);
  }
  assert.match(block, /calc\([^)]*var\(--site-space, 1\)\)/, "间距走 Nudge 缩放");
  assert.match(block, /calc\([^)]*var\(--site-type, 1\)\)/, "字号走 Nudge 缩放");
  assert.match(block, /animation: ol-in calc\(0\.16s \* var\(--site-motion, 1\)\)/, "动效也要能被 --site-motion 关掉");
  assert.doesNotMatch(block, /linear-gradient|radial-gradient/, "纸墨风不用渐变");
  assert.match(css, /\.ol-panel \{ max-height: 62%; \}/, "矮屏（1280×720）上脉络卡不能盖住整页 PDF");
});

// --------------------------------------------------------------------------- 引擎侧的真实行为

test("提示词塞进全文时守我们的额度预算，并丢掉参考文献列表", () => {
  const pages = Array.from({ length: 20 }, (_, i) => (i === 19 ? "References\n" + "[1] Doe et al. ".repeat(200) : "Body text. ".repeat(1200)));
  const headings = [{ title: "References", page: 19, offset: 11 }];
  const input = buildOutlineInput(pages, headings, 60_000);
  assert.ok(input.length <= 61_000, `超预算：${input.length}`);
  assert.match(input, /<<<PAGE 1>>>/);
  assert.ok(!input.includes("Doe et al"), "参考文献不进提示词：占额度又不给脉络信息");
  assert.match(input, /<<<PAGE 20>>>\nReferences$/, "参考文献页只留标题行，条目一条不发");

  // 桌面版把预算交给调用方（那边是 70k），我们压到 60k：引擎默认值仍在，调用点说我们的数。
  assert.match(source("core/outline.ts"), /const INPUT_BUDGET = 60_000/);
  assert.match(source("core/outline.ts"), /buildOutlineInput\(text\.pages, text\.headings, INPUT_BUDGET\)/);
});

test("脉络 Markdown：编号层级、页码引用与关系行都齐", () => {
  const node = (id: string, title: string, summary: string, anchors: any[] = [], children: any[] = []) => ({
    id,
    title,
    summary,
    anchors,
    children,
  });
  const outline = {
    version: 1,
    kind: "research",
    oneLine: "用自注意力替掉循环结构，翻译质量与并行度同时上去。",
    sections: [
      node("abs", "摘要拆解", "八句话各管一件事", [], [
        node("gap", "Gap", "循环结构无法并行", [{ page: 1, quote: "RNNs are sequential" }]),
      ]),
      node("method", "方法", "多头自注意力", [{ page: 3, figure: "Figure 1", caption: "The Transformer model" }]),
    ],
    relations: [{ from: "gap", to: "method", type: "addresses", label: "并行瓶颈" }],
    model: "deepseek-flash",
    created: 1,
  } as unknown as PaperOutline;

  const md = outlineToMarkdown(outline);
  assert.match(md, /\*\*研究\*\* · 用自注意力替掉循环结构/, "首行给类型与一句话");
  assert.match(md, /- 1 摘要拆解[\s\S]*?- 1\.1 Gap: 循环结构无法并行 \[p\.1\]/, "层级编号与逐字锚点页码");
  assert.match(md, /- 2 方法: 多头自注意力 \[p\.3\]/, "图表锚点也要留下页码");
  assert.match(md, new RegExp("- Gap →\\(" + RELATION_LABELS.addresses + ": 并行瓶颈\\) 方法"), "关系行用节点标题与中文标签，别把 id 或枚举值丢给读者");
  assert.ok(!md.includes("undefined"), `不该漏出 undefined：\n${md}`);
});
