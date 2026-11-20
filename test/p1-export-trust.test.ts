/**
 * P1 体验收敛的回归锁。
 *
 * 导出这条路径要一直守住三件事：笔记里的页码引用是真的页码而不是只能在应用里点的
 * `page:` 路由；头部字段只写库里记着的东西，预置示例必须自报“这是预置内容”；
 * 剪贴板被浏览器拒绝时仍然有下载这条路，不能把用户的报告吞掉。
 * 可信度那一侧同样有约定：跳页不等于匹配成功，对比矩阵与 Research Gap 的结论要带边界说明。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { arxivIdOf, buildNote, noteFileName, plainCitations, transcriptSections } from "../frontend/src/shared/note.ts";
import { textLayerNotice } from "../frontend/src/shared/errors.ts";

// ---------------------------------------------------------------- 笔记导出

const SRC = {
  title: "Attention Is All You Need",
  authors: "Vaswani et al.",
  year: "2017",
  venue: "NeurIPS",
  arxiv: "1706.03762",
  doi: "10.48550/arXiv.1706.03762",
  origin: "演示论文（随站打包）",
};

test("页码芯片降级成纯文本引用，内部跳转协议不留痕", () => {
  const md = "先看 [p. 3](page:3?q=self%20attention%20mechanism)，再看 [这段原话](page:9?q=a%20(single%20paren)) 与 [批注](annotation:AB23CDEF)。";
  const out = plainCitations(md);
  assert.ok(out.includes("[p. 3]"), out);
  assert.ok(out.includes("这段原话 [p. 9]"), out);
  assert.ok(out.includes("批注"), out);
  assert.ok(!out.includes("page:"), "导出文本里不该有应用内的 page: 路由");
  assert.ok(!out.includes("annotation:"), "批注链接在笔记里是死链，应该只留标题");
});

test("笔记头部：来源、年份、arXiv 标识与导出日期齐全", () => {
  const md = buildNote(SRC, [{ heading: "核心贡献与结论", body: "- 提出 Transformer [p. 3](page:3?q=x)" }], { exportedAt: Date.parse("2026-11-20T09:12:00") });
  assert.match(md, /^# Attention Is All You Need · 精读报告/);
  assert.ok(md.includes("2017 · NeurIPS · arXiv:1706.03762"), md);
  assert.ok(md.includes("导出：2026-11-20 09:12"), md);
  assert.ok(md.includes("[p. 3]"), md);
  assert.ok(!md.includes("page:3?q="), md);
});

test("预置示例自动标注「示例精读 · 预置内容」，普通会话不标注", () => {
  const preset = buildNote({ ...SRC, preset: true }, [{ heading: "答", body: "内容" }]);
  assert.match(preset, /示例精读 · 预置内容/);
  const mine = buildNote(SRC, [{ heading: "答", body: "内容" }]);
  assert.doesNotMatch(mine, /示例精读/);
});

test("缺字段就不编字段：只有标题时头部依然完整成文", () => {
  const md = buildNote({ title: "某篇本地 PDF" }, [{ heading: "答", body: "正文" }]);
  assert.match(md, /来源：来源未记录/);
  assert.ok(!/年份/.test(md), md);
  assert.ok(md.includes("本地"), "至少正文要在");
});

test("问答顺序即笔记章节顺序，空回答不成节", () => {
  const sections = transcriptSections([
    { q: "核心贡献是什么？", a: "提出 Transformer。" },
    { q: "局限呢？", a: "   " },
    { q: "", a: "没有提问也算一节。" },
  ]);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading, "问：核心贡献是什么？");
  assert.equal(sections[1].heading, "回答");
});

test("文件名去掉路径非法字符", () => {
  const name = noteFileName({ title: 'a/b\\c:d*e?f"g<h>i|j#k%l' }, "精读报告", Date.parse("2026-11-20T00:00:00"));
  assert.ok(!/[\\/:*?"<>|#%]/.test(name), name);
  assert.ok(name.endsWith("-精读报告-20261120.md"), name);
});

test("arXiv 标识从 itemKey、abs 链接与 pdf 链接里都能认出来", () => {
  assert.equal(arxivIdOf("1706.03762"), "1706.03762");
  assert.equal(arxivIdOf("", "https://arxiv.org/abs/2005.14165"), "2005.14165");
  assert.equal(arxivIdOf("https://arxiv.org/pdf/1512.03385v1.pdf"), "1512.03385v1");
  assert.equal(arxivIdOf("10.1109/CVPR.2016.90"), "", "DOI 不该被当成 arXiv id");
});

// ---------------------------------------------------------------- 可信度边界

test("无文本 PDF：扫描件与「只有摘要」分开说，且都禁止页码引用", () => {
  const scanned = textLayerNotice(12, 0);
  assert.match(scanned, /扫描件|图片版/);
  assert.match(scanned, /禁止输出任何 \[p\. x\] 页码引用/);
  assert.match(scanned, /12 页/, "有页数就要说清是有页没字");
  const metadataOnly = textLayerNotice(0, 0);
  assert.match(metadataOnly, /摘要|元数据/);
  assert.match(metadataOnly, /禁止输出任何 \[p\. x\] 页码引用/);
  assert.equal(textLayerNotice(12, 4096), "", "有文字就不该吓读者");
});

const source = (rel: string) => readFileSync(new URL(`../frontend/src/${rel}`, import.meta.url), "utf8");

test("跳页不等于匹配成功：这句话仍在 openPage 的失败分支里", () => {
  const api = source("web/api.ts");
  assert.match(api, /已跳转至第 \$\{page\} 页，未精确匹配到原句高亮/);
  assert.match(api, /\{ type: "notice"/, "提示要发给阅读器，而不是只写在 console");
  const viewer = source("web/viewer.tsx");
  assert.match(viewer, /c\.type === "notice"/, "阅读器得真的把 notice 画出来");
  assert.match(viewer, /reader-notice/, "提示要有自己的样式，浮在页面上方");
});

test("Agent 侧不许编页码：提示词与工具都守住无文本 PDF", () => {
  assert.match(source("core/prompt.ts"), /Never invent a page number/);
  const tools = source("core/tools/paper-tools.ts");
  assert.match(tools, /没有文字层/, "paper_read / paper_search 要区分扫描件和没有附件");
  assert.match(tools, /textLayerNotice/, "概览也要把同一句警告喂给模型");
});

test("对比矩阵与 Research Gap 的输出带边界说明", () => {
  const skills = source("core/skills.ts");
  assert.match(skills, /可比性说明/);
  assert.match(skills, /不能直接当作同条件对比|不是同条件对比/, "要明说指标不可直接比");
  assert.match(skills, /候选研究方向及核验建议/);
});

test("图谱标明节点关系来源与本地隐私边界", () => {
  const graph = source("web/graph.tsx");
  assert.match(graph, /预置示例/);
  assert.match(graph, /自动提取/);
  assert.match(graph, /PDF 仅保存在本地浏览器，仅在调用 AI 时发送所选文本\/截图/);
  assert.match(source("core/graph.ts"), /export function presetIds/, "预置与自动提取要能程序化区分");
});
