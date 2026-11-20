/**
 * 终审前那一轮的回归锁。
 *
 * 两条主流程断点必须一直通着：勾选不够就点「跨篇对比」时，左栏要自己展开并聚焦到多选条
 * （而不是发一次请求、或悄悄替用户勾两篇）；「复制 Markdown」要在按钮上给出真实的
 * 「已复制 ✓」并在 2 秒后复位，剪贴板被拦时把兜底的下载按钮亮起来。
 * 首屏文案与工具区命名同理：改起来只是一行字符串，所以直接对源码断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { COPY_FLASH_MS, EMPTY_NOTE_HINT, copyButtonLabel, copyHint } from "../frontend/src/shared/clipboard.ts";
import { pageChips, plainLine } from "../frontend/src/shared/note.ts";
import { splitBullets } from "../frontend/src/shared/markdown.ts";
import { attentionPreset } from "../frontend/src/data/preset-attention.ts";
import { bertPreset } from "../frontend/src/data/preset-bert.ts";
import { resnetPreset } from "../frontend/src/data/preset-resnet.ts";

const source = (rel: string) => readFileSync(new URL(`../frontend/src/${rel}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- P0-1 跨篇对比叫回左栏

test("勾选不够就点对比：先展开左栏，且不发请求、不代勾选", () => {
  const skills = source("web/skills.tsx");
  const guard = skills.slice(skills.indexOf('meta.needs === "papers" && selected.length < 2'));
  const block = guard.slice(0, guard.indexOf("}\n"));
  assert.match(block, /api\.events\.emit\(\{ type: "focus-library" \}\)/, "要点名让左栏展开");
  assert.match(block, /return;/, "凑不够 2 篇就停在这里");
  assert.ok(block.indexOf("return;") < guard.indexOf("api.skills.run"), "停在真正取数据之前：不消耗演示额度");
  assert.doesNotMatch(block, /selection\.(set|toggle)/, "绝不替用户勾选论文");
  assert.match(block, /已选 \$\{selected\.length\}\/5 篇，至少选 2 篇/);

  const app = source("web/app.tsx");
  assert.match(app, /e\.type === "focus-library"\) openRail\(\)/, "窄屏要开抽屉、宽屏要展开，走的就是既有的 openRail");

  const lib = source("web/library.tsx");
  assert.match(lib, /if \(e\.type === "focus-library"\) pickerFocus\.emit\(\+\+focusNonce\)/, "文献栏要认这个事件");
  assert.match(lib, /useState\(\(\) => focusNonce > 0\)|useState\(focusNonce > 0\)/, "折叠态/抽屉里的左栏是这一次点击才挂载的，初始 state 就要读到这次请求");
  assert.match(lib, /\(sel\.length > 0 \|\| picker\) && \(/, "一篇没选时多选条也得出现");
  assert.match(lib, /barRef\.current\?\.scrollIntoView/, "展开之后滚动聚焦到勾选的地方");
});

test("多选条说清「已选 n/5 篇，至少选 2 篇」，够了才给生成对比", () => {
  const lib = source("web/library.tsx");
  assert.match(lib, /已选 \{sel\.length\}\/5 篇\{sel\.length < 2 \? "，至少选 2 篇" : ""\}/);
  assert.match(lib, /disabled=\{sel\.length < 2\}/, "没够 2 篇时按钮是禁用的");
  assert.match(lib, /📊 生成对比/, "够 2 篇之后按钮就是这句直白动作名");
  assert.doesNotMatch(lib, /已选 \{sel\.length\} 篇<\/span>/, "旧的「已选 n 篇」不说上限，也没说还差几篇");
});

// ---------------------------------------------------------------- P0-2 复制闭环

test("复制反馈：按钮亮 2 秒「已复制 ✓」，失败另说一句人话", () => {
  assert.equal(copyButtonLabel(false), "复制 Markdown");
  assert.equal(copyButtonLabel(false, "复制本条回答"), "复制本条回答");
  assert.equal(copyButtonLabel(true), "已复制 ✓");
  assert.equal(COPY_FLASH_MS, 2000);
  assert.match(copyHint("精读报告", true), /^已复制精读报告的 Markdown/);
  assert.match(copyHint("本条回答", false), /浏览器拒绝了剪贴板写入/);
  assert.match(copyHint("本条回答", false), /下载 本条回答|下载 本条/, "失败要指向那条真实退路");
  assert.ok(EMPTY_NOTE_HINT.trim().length > 6, "空报告也要有话说");
  assert.doesNotMatch(EMPTY_NOTE_HINT, /已复制|成功/);
});

test("NoteActions 真的接上了这套反馈：门限、复位、兜底高亮", () => {
  const comp = source("web/components.tsx");
  assert.match(comp, /if \(!text\.trim\(\)\) return setStatus\(\{ msg: EMPTY_NOTE_HINT \}\)/, "空内容先挡住，不谎报成功");
  assert.match(comp, /setFlash\(true\)/);
  assert.match(comp, /setTimeout\(\(\) => setFlash\(false\), COPY_FLASH_MS\)/, "2 秒后按钮自己要复位");
  assert.match(comp, /copyButtonLabel\(flash, copyLabel\)/);
  assert.match(comp, /status\?\.blocked \? "chip note-dl-alert"/, "剪贴板被拦时点亮「下载笔记 .md」");
  assert.match(comp, /copyHint\(label, false\), text, blocked: true/, "失败提示带上可自选中复制的原文");

  // 报告组叫「整篇笔记」，单条气泡叫「复制本条回答」，两套入口不再撞名。
  const chat = source("web/chat.tsx");
  assert.match(chat, /group="导出笔记 · 整篇笔记"/);
  assert.match(chat, /copyLabel="复制本条回答"/);
  assert.match(chat, /label="本条回答"/);
});

// ---------------------------------------------------------------- P1-1 / P1-2 首屏

test("欢迎区：主副标题说价值，预置说明只剩一行轻提示", () => {
  const app = source("web/app.tsx");
  assert.match(app, /<h1>让组会笔记，每条结论都有原文可查。<\/h1>/);
  assert.match(app, /精读单篇论文、横向比较多篇方法，带着页码证据导出 Markdown。/);
  assert.match(app, /预置示例 · 无需 Key · 不消耗模型额度/);
  assert.doesNotMatch(app, /30 页英文论文/, "具体页数不再写进主文案");
  assert.match(app, /class="muted small start-tag">预置示例 · 无需 Key · 不消耗模型额度<\/p>/, "预置说明收成一行轻提示");
  assert.match(app, /class="sc-badge">示例预览</, "预览卡要自己标明是示例");
});

test("示例预览复用预置结论：一行纯文本 + 真实可点页码", () => {
  const first = splitBullets(attentionPreset.conclusion)[0];
  const chips = pageChips(first);
  assert.equal(chips.length, 1, "首条贡献要带自己的页码证据");
  assert.ok(chips[0].page >= 1 && chips[0].quote.length > 20, "芯片得带原文，不然只能跳页不能圈句");
  const line = plainLine(first);
  assert.doesNotMatch(line, /page:|\*\*|\$/, "预览卡是纯文本，不该漏出路由协议或 Markdown 记号");
  assert.doesNotMatch(line, /^\s*[-*+]\s/, "列表符不该跟着进卡片");
  assert.match(line, /解决什么问题/);
  assert.match(source("web/app.tsx"), /api\.openPage\(example\.itemKey, c\.page, c\.quote/, "点芯片走的是和正文芯片同一条跳页+高亮路径");
});

test("核心贡献先讲问题/做法/结果，页码一律用可点芯片", () => {
  for (const preset of [attentionPreset, resnetPreset, bertPreset]) {
    const items = splitBullets(preset.conclusion);
    assert.ok(items.length > 3, `${preset.itemKey} 的结论条数不足以验证「展开其余」`);
    // 摘要只铺前三条，所以「解决什么问题 / 怎么做 / 结果如何」必须就排在前三。
    assert.match(items[0], /解决什么问题/, `${preset.itemKey} 的首屏要先说问题`);
    assert.match(items[1], /怎么做/, `${preset.itemKey} 的首屏要说做法`);
    assert.match(items[2], /结果如何/, `${preset.itemKey} 的首屏要说结果`);
    const head = items.slice(0, 3).join("\n");
    assert.doesNotMatch(head, /（p\.\s*\d/, `${preset.itemKey} 还在用纯文本页码，点不动`);
    assert.ok(pageChips(head).length >= 3, `${preset.itemKey} 的前三条至少要三条可点证据`);
    assert.ok(pageChips(items[0]).length >= 1, `${preset.itemKey} 的首条结论要自带页码角标`);
  }
  // 公式与超参不在结论里刷屏：它们留在方法拆解那一轮。
  assert.doesNotMatch(attentionPreset.conclusion, /mathrm|sqrt/, "注意力缩放公式属于方法拆解");
  assert.doesNotMatch(resnetPreset.conclusion, /bottleneck（p/, "块设计细节属于方法拆解");
});

// ---------------------------------------------------------------- P1-3 工具区命名

test("工具区只留动作名：继续研究 + 四个直白入口", () => {
  // core/skills.ts 带 .ts 之外的相对导入，Node 直跑不了，所以按源码断言（和其余 UI 锁一样）。
  const core = source("core/skills.ts");
  const meta = core.slice(core.indexOf("export const SKILLS"), core.indexOf("export type CandidateGroup"));
  let at = -1;
  for (const name of ["找相关论文", "拆解方法", "跨篇对比", "寻找研究方向"]) {
    const next = meta.indexOf(`label: "${name}"`, at + 1);
    assert.ok(next > at, `四个入口要按这个顺序排：${name}`);
    at = next;
  }
  assert.doesNotMatch(meta, /label: "(文献侦察兵|方法论解剖室|多篇横向对比矩阵|Research Gap)/, "旧的内部名字不该还挂在按钮上");
  assert.doesNotMatch(meta, /Semantic Scholar/, "数据源说明不该写在快捷按钮上");

  const skills = source("web/skills.tsx");
  assert.match(skills, /🧪 继续研究/);
  assert.doesNotMatch(skills, /科研 Skills 工具箱/, "内部名字不该出现在界面上");
  assert.match(skills, /选一个方向，剩下的交给 Pi/);
});
