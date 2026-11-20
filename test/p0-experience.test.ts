/**
 * P0 体验收敛的回归锁。
 *
 * 三件事必须一直成立：预置精读的每一个页码芯片都能在随站打包的 PDF 文本里命中
 * （首访者点得到证据）；1280 / 1366 / 1440 / 125% 缩放下三栏加起来不超过视口宽度
 * （整页不出现横向滚动条）；错误分类只说事实，服务端没给秒数就绝不显示倒计时。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { findQuote, type PdfChar } from "../frontend/src/core/text.ts";
import { attentionPreset } from "../frontend/src/data/preset-attention.ts";
import { bertPreset } from "../frontend/src/data/preset-bert.ts";
import { resnetPreset } from "../frontend/src/data/preset-resnet.ts";
import { splitBullets } from "../frontend/src/shared/markdown.ts";
import { classifyError, retryLabel, statusLabel, usableRetryAfter } from "../frontend/src/shared/errors.ts";
import {
  CHAT_MIN_W,
  MIN_READER_W,
  NARROW_VW,
  RAIL_EDGE_W,
  SPLITTER_W,
  clampChatW,
  petMiniDefault,
  railCollapsed,
  railWidth,
} from "../frontend/src/shared/layout.ts";

const DEMO_DIR = new URL("../backend/data/demo_papers/", import.meta.url);

// ---------------------------------------------------------------- page evidence

const CHIP = /\[p\. (\d+)\]\(page:(\d+)\?q=([^)\s]+)\)/g;

function chipsOf(md: string): { label: number; page: number; quote: string }[] {
  const out: { label: number; page: number; quote: string }[] = [];
  for (const m of md.matchAll(CHIP)) {
    out.push({ label: Number(m[1]), page: Number(m[2]), quote: decodeURIComponent(m[3]) });
  }
  return out;
}

/** Mirror of the char stream the reader builds: one entry per glyph, line ends flagged. */
function charsOfPage(text: string): PdfChar[] {
  const out: PdfChar[] = [];
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    for (const g of [...lines[li]]) out.push({ c: g, rect: [0, 0, 1, 1] });
    if (li === lines.length - 1 || !out.length) continue;
    out[out.length - 1].lineBreakAfter = true;
    if (lines[li].trim() === "") out[out.length - 1].paragraphBreakAfter = true;
  }
  return out;
}

const PRESETS = [attentionPreset, resnetPreset, bertPreset];
const slugOf = (itemKey: string) => itemKey.replace(".", "p");

for (const preset of PRESETS) {
  test(`${preset.itemKey}: 每个页码芯片都能在被引用的那一页命中原文`, () => {
    const doc = JSON.parse(readFileSync(new URL(`${slugOf(preset.itemKey)}.json`, DEMO_DIR), "utf8")) as { pages: string[] };
    const body = [preset.conclusion, ...preset.turns.map((t) => `${t.q}\n${t.a}`)].join("\n\n");
    const chips = chipsOf(body);
    assert.ok(chips.length > 20, `芯片太少（${chips.length}），预置精读疑似被清空`);
    for (const chip of chips) {
      assert.equal(chip.label, chip.page, `芯片文字 p.${chip.label} 与跳转页 ${chip.page} 不一致`);
      assert.ok(chip.page >= 1 && chip.page <= doc.pages.length, `第 ${chip.page} 页不在这篇 ${doc.pages.length} 页的 PDF 里`);
      const hit = findQuote(charsOfPage(doc.pages[chip.page - 1]), chip.quote);
      assert.ok(hit, `p.${chip.page} 的引文在该页找不到：${chip.quote.slice(0, 60)}`);
    }
  });
}

test("示例精读入口指向随站打包的静态 PDF，首访不依赖外网", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", DEMO_DIR), "utf8")) as { id: string; slug: string }[];
  const entry = manifest.find((m) => m.id === attentionPreset.itemKey);
  assert.ok(entry, "manifest.json 里必须有小鲸鱼默认演示的那篇论文");
  for (const suffix of [".pdf", ".json"]) {
    assert.ok(existsSync(new URL(`${entry!.slug}${suffix}`, DEMO_DIR)), `缺少静态资源 ${entry!.slug}${suffix}`);
  }
});

test("核心贡献摘要：结论被拆成多条，首屏只铺前三条", () => {
  const items = splitBullets(attentionPreset.conclusion);
  assert.ok(items.length > 3, "结论条数应当足以验证「展开其余」这条交互");
  assert.ok(items.slice(0, 3).every((b) => b.trim().length > 8), "前几条贡献不应是空壳");
  const nested = splitBullets("说明：\n\n- 一\n  续行\n- 二\n\n注：以上。");
  assert.deepEqual(nested, ["说明：", "- 一\n  续行", "- 二", "注：以上。"]);
});

test("预置结论互不相同：首屏锚点靠它认出「这就是那篇预置精读」", () => {
  const presets = [attentionPreset, resnetPreset, bertPreset];
  for (const p of presets) {
    assert.ok(p.conclusion?.trim().length > 40, `${p.itemKey} 的结论太短，锚不住首屏`);
    assert.ok(splitBullets(p.conclusion).length >= 2, `${p.itemKey} 的结论至少要能拆出两条贡献`);
  }
  const seen = new Set(presets.map((p) => p.conclusion));
  assert.equal(seen.size, presets.length, "三篇预置结论必须互不相同，否则锚点会认错人");
});

// ---------------------------------------------------------------- multi-resolution shell

const SCREENS: [number, number][] = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1536, 864], // 1920×1080 @125%
  [1920, 1080],
];

for (const [vw] of SCREENS) {
  for (const stored of [null, "0", "1"]) {
    test(`${vw}px（rail=${stored ?? "auto"}）三栏宽度不超视口，PDF 有阅读宽度`, () => {
      const collapsed = railCollapsed(stored, vw);
      const rail = collapsed ? RAIL_EDGE_W : railWidth(vw);
      for (const wanted of [460, 760, 1200]) {
        const chat = clampChatW(wanted, vw, collapsed);
        assert.ok(chat >= CHAT_MIN_W, `聊天栏被压到 ${chat}px`);
        assert.ok(rail + SPLITTER_W + chat <= vw, `整页横向溢出：${rail}+${SPLITTER_W}+${chat} > ${vw}`);
        assert.ok(vw - rail - SPLITTER_W - chat >= MIN_READER_W, `PDF 栏只剩 ${vw - rail - SPLITTER_W - chat}px`);
      }
    });
  }
}

test("窄桌面默认收起文献栏、桌宠默认缩成侧边迷你气泡", () => {
  for (const vw of [1280, 1366, 1440]) assert.equal(railCollapsed(null, vw), true, `${vw}px 首访应当默认收起左侧栏`);
  assert.equal(railCollapsed(null, 1920), false);
  assert.equal(railCollapsed("1", 1280), false, "用户显式展开过就要记住");
  assert.equal(railCollapsed("0", 1920), true);
  assert.equal(petMiniDefault(1366), true);
  assert.equal(petMiniDefault(1920), false);
  assert.ok(NARROW_VW >= 1440, "1440×900 也算窄屏，否则抽屉逻辑不会生效");
});

// ---------------------------------------------------------------- honest errors

test("429 用「已保留你的问题」文案，并只信服务端给的等待秒数", () => {
  const raw = '429 {"error":"rate_limited","message":"公共演示额度已用完（每分钟 6 次）","retryAfter":42,"usage":{}}';
  const err = classifyError(raw);
  assert.equal(err.kind, "rate");
  assert.match(err.message, /已保留你的问题/);
  assert.equal(err.retryAfter, 42);
  assert.deepEqual(err.actions, ["example", "retry", "key"]);
  assert.equal(retryLabel(42), "约 42 秒后可以再试");
});

test("线上限流答复原样进分类：认分钟窗口，不误报成每日额度", () => {
  // 2026-11-20 实测 scholarpi-web-tpzo6tda9by.qoder.zone 的 429 响应体。
  const live = '{"error":"rate_limited","message":"公共演示额度已用完（每分钟 6 次）。请稍后再试，或在设置中填入自己的 DeepSeek Key 继续不限次使用。","retryAfter":54,"usage":{"usedMinute":6,"usedHour":6,"usedDay":6,"limitMinute":6,"limitHour":120,"limitDay":600,"remainingHour":114}}';
  const err = classifyError(live, { status: 429, retryAfter: "54" });
  assert.equal(err.kind, "rate");
  assert.match(err.message, /已保留你的问题/);
  assert.equal(err.retryAfter, 54);
  assert.equal(retryLabel(err.retryAfter), "约 54 秒后可以再试");
});

test("每日额度、超时、PDF、鉴权、断网各有各的说法", () => {  assert.equal(classifyError('{"error":"rate_limited","message":"每天 600 次已用完","retryAfter":3600}').kind, "quota");
  assert.equal(classifyError("上游请求超时 upstream_timeout").kind, "timeout");
  assert.equal(classifyError("PDF 下载超时").kind, "pdf");
  assert.equal(classifyError('{"error":"missing_demo_key"}').kind, "auth");
  assert.equal(classifyError("TypeError: Failed to fetch").kind, "network");
  assert.equal(classifyError("HTTP 500 服务器开小差了").kind, "unknown");
});

test("没有可信等待时间时绝不编造倒计时", () => {
  for (const bad of [undefined, null, 0, -3, NaN, "abc", "", "0"]) assert.equal(usableRetryAfter(bad), undefined, String(bad));
  assert.equal(usableRetryAfter("45"), 45);
  assert.equal(usableRetryAfter(999999), 7200, "荒谬的长等待要有上限");
  assert.equal(retryLabel(undefined), "");
  assert.equal(classifyError("rate limited 503").retryAfter, undefined);
});

test("状态灯只说一句人话", () => {
  assert.equal(statusLabel(null, false).text, "正在连接服务…");
  assert.equal(statusLabel({ ok: false }, false).text, "服务器未连接");
  assert.equal(statusLabel({ ok: true, demoKey: true }, false).text, "演示模式可用");
  assert.equal(statusLabel({ ok: true, demoKey: true }, true).text, "个人 Key 已配置");
  assert.equal(statusLabel({ ok: true, demoKey: false }, false).text, "需填入自己的 Key");
  assert.equal(statusLabel({ ok: true, demoKey: false }, false).tone, "warn");
});

test("限流答复不承诺做不到的事", () => {
  for (const copy of [classifyError("429 rate_limited").message, classifyError("每天额度已用完").message]) {
    assert.doesNotMatch(copy, /排队|第\s*\d+\s*位|马上|一定/);
  }
});
