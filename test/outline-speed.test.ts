/**
 * 文章脉络的提速改动与示例论文预置脉络。
 *
 * 上一轮实测：默认跟着右下角「思考：高」走，读者点完「梳一遍」要干等几十秒思考流，
 * 树还容易长到三十来个节点。这一轮把四件事钉住——非思考通道、节点预算、输入预算、
 * 示例论文的静态脉络——并校验预置那份的每个锚点真的命中打包好的页面文字。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  buildOutlinePrompt,
  capOutline,
  normalizeOutline,
  outlineToMarkdown,
  validateAnchors,
  type PaperOutline,
} from "../frontend/src/core/outline-schema.ts";

const source = (rel: string) => readFileSync(new URL(`../frontend/src/${rel}`, import.meta.url), "utf8");
const DEMO_DIR = new URL("../backend/data/demo_papers/", import.meta.url);

// --------------------------------------------------------------------------- 非思考通道

test("脉络请求固定走非思考通道：不吃右下角「思考：高」，也不把全局档位传下去", () => {
  const engine = source("core/outline.ts");
  assert.match(engine, /reasoning: "off"/, "thinking 关掉是这一轮最关键的提速：结构化抽取不需要先想几十秒");
  assert.match(engine, /maxTokens: 8000/, "输出上限跟着节点预算收紧，别留 16k 让它自由发挥");
  assert.doesNotMatch(engine, /thinkingLevel|s\.thinking|clampThinking/, "生成脉络不该读全局思考档位");
  assert.doesNotMatch(engine, /async function collect\([\s\S]{0,200}level/, "collect 不再收思考档位参数：多一个入口就多一次误传");

  // llm.ts 那侧的契约：reasoning === "off" 时压根不发 reasoning 参数。
  const llm = source("core/llm.ts");
  assert.match(llm, /opts\.reasoning && opts\.reasoning !== "off" \? clampThinking\(model, opts\.reasoning\) : undefined/);
});

test("关掉思考后面板不会留一个空的「思考过程」", () => {
  const panel = source("web/outline.tsx");
  assert.match(panel, /\{!!st\.thinking && \(/, "没有思考流就整块不渲染");
  assert.match(panel, /<summary class="muted small">思考过程<\/summary>/);
});

// --------------------------------------------------------------------------- 节点与输入预算

test("capOutline 先删孙节点、再删零散子节点，摘要拆解的逐字锚点最后才动", () => {
  const node = (id: string, children: any[] = []) => ({ id, title: `n${id}`, summary: "", anchors: [{ page: 1, quote: `q${id}` }], children });
  const abs = node("abs", [node("a1"), node("a2")]);
  const method = node("m", [node("m1", [node("m1.1"), node("m1.2")]), node("m2")]);
  const outline = {
    version: 1,
    kind: "research",
    oneLine: "",
    sections: [abs, { ...method, key: "method" }],
    relations: [{ from: "m1.1", to: "a1", type: "supports", label: "x" }],
    model: "m",
    created: 1,
  } as unknown as PaperOutline;

  const capped = capOutline(outline, 5);
  const ids: string[] = [];
  const walk = (ns: any[]) => ns.forEach((n) => (ids.push(n.id), walk(n.children)));
  walk(capped.sections);
  assert.equal(ids.length, 5, `没收敛到 5 个：${ids.join(",")}`);
  assert.ok(!ids.includes("m1.1") && !ids.includes("m1.2"), "孙节点先走：侧栏窄，第三层没人看");
  assert.ok(ids.includes("a1") && ids.includes("a2"), "摘要拆解那几条逐字锚点留到最后");
  assert.deepEqual(capped.relations, [], "关系两端被删了就得跟着删，否则面板画一条指向空气的箭头");
  assert.equal(capOutline(outline, 0), outline, "maxNodes 非正数时不动树");
});

test("提示词的节点预算只在调用方要时出现：引擎默认仍与桌面版一致", () => {
  const withBudget = buildOutlinePrompt({ title: "T", language: "简体中文", text: "BODY", maxNodes: 18 });
  assert.match(withBudget, /Total budget: ≤ 18 nodes counting sections \+ children \+ grandchildren/);
  assert.match(withBudget, /no grandchildren/, "第三层没人看，数字写进章节摘要而不是加节点");
  assert.ok(!/≤ 18 nodes/.test(buildOutlinePrompt({ title: "T", language: "简体中文", text: "BODY" })), "不传 maxNodes 时提示词保持桌面版原样");

  const engine = source("core/outline.ts");
  assert.match(engine, /const MAX_NODES = 18;/);
  assert.match(engine, /maxNodes: MAX_NODES/, "提示词要预算，落地的树还要硬裁：模型不会老实听话");
  assert.match(engine, /capOutline\(normalizeOutline\(raw, totalPages, modelId, true\), MAX_NODES\)/, "流式的半成品同样要裁，否则先长出三十个节点再缩回去");
  // 全文预算：每一字符都要过公网边缘函数，越短首字越快。
  assert.match(engine, /const INPUT_BUDGET = 30_000;/);
  assert.doesNotMatch(engine, /60_000|70_000/);
});

// --------------------------------------------------------------------------- 等待反馈

test("生成过程报阶段，不再只挂一个「思考中...」", () => {
  const engine = source("core/outline.ts");
  for (const stage of ["正在读取论文全文…", "正在抽取章节与关键句…", "生成中…", "定位段落…", "重新梳理…"]) {
    assert.ok(engine.includes(stage), `缺阶段文案：${stage}`);
  }
  assert.match(engine, /set\(paperKey, \{ status: "loading", stage: "正在读取论文全文…", started: Date\.now\(\) \}\)/, "点下去的第一帧就要有话说");
  assert.match(engine, /stage\(attempt \? "重新梳理…" : "正在抽取章节与关键句…"\)/);
  assert.match(engine, /if \(partial\.sections\.length\) set\(paperKey, \{ status: "loading", stage: "生成中…", started, partial, rev: \+\+rev, thinking \}\)/);

  const panel = source("web/outline.tsx");
  assert.match(panel, /<span class="spinner" \/> \{st\.stage\}/, "阶段文案要跟着 spinner 一起显示");
  assert.match(panel, /极速非思考通道/, "空闲态就说清这次不用等思考流");
  assert.doesNotMatch(panel, /思考中/, "面板里不该再挂一个静态的「思考中...」占位");
});

// --------------------------------------------------------------------------- 示例论文预置脉络

test("预置脉络挂在 manifest 上，读缓存时排在模型请求之前", () => {
  const paper = source("core/paper.ts");
  assert.match(paper, /outlineFile\?: string;/, "Paper 与 DemoEntry 都要有这个字段");
  assert.match(paper, /outlineFile: d\.outlineFile,/);

  const engine = source("core/outline.ts");
  assert.match(engine, /staticJson<PaperOutline>\(`\$\{PAPERS_BASE\}\/\$\{encodeURIComponent\(file\)\}`\)/, "预置脉络是静态文件读取，不是模型请求");
  assert.match(engine, /if \(raw\?\.version !== 1 \|\| !Array\.isArray\(raw\.sections\) \|\| !raw\.sections\.length\) return null;/, "坏掉的静态文件不能端给读者");
  const load = engine.match(/export async function loadOutline[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(load.includes("bundledOutline(paperKey)"), "KV 没命中时要退到预置那份");
  assert.ok(load.indexOf("kvGet") < load.indexOf("bundledOutline"), "先读本地缓存，再动静态包");
  assert.doesNotMatch(load, /generateOutline|streamSimple/, "打开面板绝不发模型请求：演示额度是读者的");
  assert.match(engine, /await kvSet\(OUTLINE_KV_PREFIX \+ paperKey, JSON\.stringify\(raw\)\)/, "预置那份写进缓存，第二次打开连网络都不用");
});

test("预置脉络数据：节点收敛、锚点全部命中打包文字、导出没有 undefined", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", DEMO_DIR), "utf8")) as any[];
  const entry = manifest.find((m) => m.id === "1706.03762");
  assert.ok(entry?.outlineFile, "Attention 这篇必须配 outlineFile：评委第一次打开 ☰ 就该看到东西");
  const file = new URL(entry.outlineFile, DEMO_DIR);
  assert.ok(existsSync(file), `缺少静态脉络文件 ${entry.outlineFile}`);

  const preset = JSON.parse(readFileSync(file, "utf8")) as PaperOutline;
  const pages = (JSON.parse(readFileSync(new URL(entry.textFile, DEMO_DIR), "utf8")) as { pages: string[] }).pages;

  assert.equal(preset.version, 1, "版本号要和桌面版一致，两边的缓存才能互读");
  assert.equal(preset.kind, "research");
  assert.ok(preset.oneLine?.length > 10, "要有一句话主线");
  const nodes: any[] = [];
  const walk = (ns: any[]) => ns.forEach((n) => (nodes.push(n), walk(n.children)));
  walk(preset.sections);
  assert.ok(nodes.length >= 12 && nodes.length <= 18, `节点数 ${nodes.length} 不在 12–18 的精华区间`);
  assert.ok(preset.sections.some((s) => s.key === "abstract" && s.children.length >= 5), "摘要拆解是这块面板的主入口");
  assert.ok(preset.sections.some((s) => s.anchors.some((a) => a.figure)), "图表锚点也要有：光有页码跳过去只是一片空白");

  const before = JSON.stringify(preset);
  const stats = validateAnchors(preset, pages);
  assert.equal(stats.total, stats.resolved, `有 ${stats.total - stats.resolved} 个锚点在文字层里找不到，点了只会「只跳到页」`);
  assert.ok(stats.resolved >= 15, `锚点太少：${stats.resolved}`);
  assert.equal(JSON.stringify(preset), before, "预置那份该是校验后的形态：再跑一遍不该有锚点被改页码或删掉");
  for (const s of preset.sections) {
    assert.ok(s.key && s.title, "章节要有 key 与标题，面板按标题显示");
    for (const a of [s, ...s.children].flatMap((n: any) => n.anchors)) {
      assert.ok(a.page >= 1 && a.page <= pages.length, `第 ${a.page} 页不在这篇 ${pages.length} 页里`);
      assert.ok(a.quote || a.caption, "每个锚点都要留下逐字原句或题注，别给读者一个空跳转");
      if (a.figure) assert.ok(a.caption, `${a.figure} 要带题注：resolveAnchor 靠题注定位，缺了只能翻到那一页`);
    }
  }
  const md = outlineToMarkdown(preset);
  assert.ok(!md.includes("undefined"), `导出里漏了 undefined：\n${md.slice(0, 400)}`);
  assert.ok(md.length < 1600, `预置脉络太长又变成清单：${md.length} 字符`);

  // 重新归一化一遍仍然收敛，说明这份数据是引擎认的形状，不是手糊的。
  const again = capOutline(normalizeOutline(JSON.parse(readFileSync(file, "utf8")), pages.length, "preset"), 18);
  assert.equal(again.sections.length, preset.sections.length);
  assert.equal(stats.resolved, validateAnchors(again, pages).resolved);
});
