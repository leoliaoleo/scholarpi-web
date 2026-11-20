/**
 * 蓝发小鲸鱼 · Pi 科研小助手 —— the floating web desktop pet.
 *
 * The whale is inline SVG: same-origin, no extra request, transparent around the
 * silhouette so it never veils the page. It breathes, it is draggable, and it
 * hosts the 1 分钟带逛导览 — each step frames the region it is talking about by
 * measuring that element, so the highlight keeps up when a panel opens or a skill
 * fills the chat.  Where it may not go is decided by the layout, not by a magic
 * number: the send box and the 划词 dock are always left clickable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getApi } from "./api";

const api = getApi();

const K_POS = "scholarpi.pet.pos";
const K_MIN = "scholarpi.pet.min";
const K_SEEN = "scholarpi.pet.seen";

/** Whale box, plus the panels it must never sit on top of. */
const W = 92;
const H = 108;
const MIN_W = 44;
const AVOID = [".pane-chat .composer", ".quick-dock"];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Style = Record<string, string>;

// ---------------------------------------------------------------------------
// dom helpers

function one<T extends HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function all<T extends HTMLElement>(sel: string): T[] {
  return [...document.querySelectorAll<T>(sel)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!test() && Date.now() - t0 < ms) await sleep(200);
  return test();
}

/** A Preact-controlled field only notices text that arrives through the native setter. */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/** Open whatever the library already has, so a step that needs a paper can have one. */
async function ensurePaper(): Promise<boolean> {
  if (api.context.get().ref) return true;
  const paper = api.papers.list().find((p) => p.source === "demo") || api.papers.list()[0];
  if (!paper) return false;
  await api.openPaper(paper.itemKey);
  return until(() => !!api.context.get().ref, 10000);
}

// ---------------------------------------------------------------------------
// placement

/** The lowest the whale may sit: above the send box and above the quick dock. */
function floorY(h: number): number {
  let y = window.innerHeight - h - 10;
  for (const sel of AVOID) {
    const el = one<HTMLElement>(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) y = Math.min(y, r.top - h - 10);
  }
  return Math.max(8, y);
}

function clampPos(x: number, y: number, w = W, h = H): Box {
  return {
    x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, y), floorY(h)),
    w,
    h,
  };
}

/** Bottom-right of the reading area: against the chat pane, never on its send box. */
function homePos(): Box {
  const chat = one<HTMLElement>(".pane-chat");
  const right = chat ? chat.getBoundingClientRect().left : window.innerWidth;
  return clampPos(right - W - 18, floorY(H));
}

function startPos(): Box {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec((localStorage.getItem(K_POS) || "").trim());
  return m ? clampPos(Number(m[1]), Number(m[2])) : homePos();
}

// ---------------------------------------------------------------------------
// the mascot

function Whale({ face = false }: { face?: boolean }) {
  if (face) {
    // A crop of the same drawing: the mini bubble and the card avatar show her face.
    return (
      <svg class="pet-svg pet-svg-face" viewBox="50 24 28 36" aria-hidden="true" focusable="false">
        <circle cx="64" cy="46" r="11" fill="#ffe9dc" />
        <path d="M53 42 C54 30 60 27 64 27 C68 27 74 30 75 42 C70 36 58 36 53 42 Z" fill="#6cb4ee" />
        <path d="M55 30 C58 26 70 26 73 30 C69 28 59 28 55 30 Z" fill="#fff" />
        <ellipse cx="58.6" cy="46" rx="2.5" ry="3.1" fill="#fff" />
        <circle cx="58.8" cy="46.4" r="1.9" fill="#2f6fbf" />
        <circle cx="58.1" cy="45.6" r=".7" fill="#fff" />
        <ellipse cx="69.4" cy="46" rx="2.5" ry="3.1" fill="#fff" />
        <circle cx="69.2" cy="46.4" r="1.9" fill="#2f6fbf" />
        <circle cx="68.5" cy="45.6" r=".7" fill="#fff" />
        <ellipse cx="55" cy="50.5" rx="2.2" ry="1.3" fill="#ffb0b0" opacity=".55" />
        <ellipse cx="73" cy="50.5" rx="2.2" ry="1.3" fill="#ffb0b0" opacity=".55" />
        <path d="M61.5 51.5 Q64 54 66.5 51.5" fill="none" stroke="#c76b6b" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg class="pet-svg" viewBox="0 0 128 150" role="img" aria-label="蓝发小鲸鱼女仆 · Pi 科研小助手">
      <defs>
        <linearGradient id="piHair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fd0ff" />
          <stop offset="1" stopColor="#4a92d6" />
        </linearGradient>
        <linearGradient id="piDress" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#31549a" />
          <stop offset="1" stopColor="#1d3263" />
        </linearGradient>
        <linearGradient id="piTail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7ec3f3" />
          <stop offset="1" stopColor="#468ed3" />
        </linearGradient>
      </defs>

      <ellipse class="pet-shadow" cx="64" cy="146" rx="25" ry="4" fill="#16233f" opacity=".16" />

      {/* 鲸尾，坐在裙子后面 */}
      <path
        class="pet-tail"
        d="M64 110 C58 121 46 129 32 127 C39 141 56 144 64 132 C72 144 89 141 96 127 C82 129 70 121 64 110 Z"
        fill="url(#piTail)"
      />

      {/* 女仆裙与围裙 */}
      <g class="pet-body">
        <path d="M64 72 C47 72 39 90 37 106 C35 121 47 129 64 129 C81 129 93 121 91 106 C89 90 81 72 64 72 Z" fill="url(#piDress)" />
        <path d="M40 116 C50 125 78 125 88 116" fill="none" stroke="#f2c14e" strokeWidth="3.4" strokeLinecap="round" />
        <path
          d="M64 82 C55 82 50 90 49 101 C48 113 54 123 64 123 C74 123 80 113 79 101 C78 90 73 82 64 82 Z"
          fill="#fbfdff"
          stroke="#e2e9f4"
          strokeWidth="1.2"
        />
        <path d="M49.5 95 C58 99 70 99 78.5 95" fill="none" stroke="#dbe6f5" strokeWidth="2.2" />
        {/* 围裙上的小鲸鱼 */}
        <g transform="translate(62 108)">
          <ellipse cx="-1.5" cy="0" rx="7" ry="4.4" fill="#5aa9e6" />
          <path d="M4.8 -0.8 C7 -2.6 9.2 -3.8 10.8 -3.2 C10.2 -0.8 8.6 1.8 5.6 2.4 Z" fill="#5aa9e6" />
          <circle cx="-6" cy="-1.1" r=".95" fill="#1d3263" />
          <path d="M-4 -4.8 C-3.2 -6.6 -3.8 -7.8 -5 -8.8" fill="none" stroke="#8fd0ff" strokeWidth="1.2" strokeLinecap="round" />
        </g>
        {/* 领口蝴蝶结 */}
        <g transform="translate(64 85)">
          <ellipse cx="-5" cy="0" rx="4.2" ry="3" fill="#f2c14e" />
          <ellipse cx="5" cy="0" rx="4.2" ry="3" fill="#f2c14e" />
          <circle r="1.9" fill="#d9a431" />
        </g>
        {/* 鳍状小手 */}
        <ellipse cx="39" cy="99" rx="6.4" ry="11.5" fill="#22417a" transform="rotate(12 39 99)" />
        <ellipse cx="89" cy="99" rx="6.4" ry="11.5" fill="#22417a" transform="rotate(-12 89 99)" />
      </g>

      {/* 头 */}
      <g class="pet-head">
        <ellipse cx="64" cy="50" rx="34" ry="33" fill="url(#piHair)" />
        <path d="M32 46 C28 58 30 70 35 77 C39 72 37 56 39 47 Z" fill="#4a92d6" />
        <path d="M96 46 C100 58 98 70 93 77 C89 72 91 56 89 47 Z" fill="#4a92d6" />
        <circle cx="64" cy="52" r="27" fill="#ffe9dc" />
        {/* 刘海 */}
        <path d="M37 47 C38 29 50 21 64 21 C78 21 90 29 91 47 C84 38 76 43 64 37 C52 43 44 38 37 47 Z" fill="url(#piHair)" />
        {/* 呆毛 */}
        <path class="pet-ahoge" d="M64 22 C60 12 66 4 76 5 C68 9 67 15 68 22 Z" fill="#8fd0ff" stroke="#5b9bd8" strokeWidth="1" />
        {/* 女仆头饰 */}
        <path d="M40 31 C46 15 82 15 88 31 C78 24 50 24 40 31 Z" fill="#fff" stroke="#e2e9f4" strokeWidth="1.2" />
        <g fill="#fff">
          <circle cx="42" cy="31" r="3.1" />
          <circle cx="49.5" cy="27.4" r="3.3" />
          <circle cx="57" cy="25.4" r="3.3" />
          <circle cx="64.5" cy="24.8" r="3.3" />
          <circle cx="72" cy="25.6" r="3.3" />
          <circle cx="79.5" cy="27.6" r="3.3" />
          <circle cx="86.5" cy="31.2" r="3.1" />
        </g>
        {/* 两侧发带蝴蝶结 */}
        <g transform="translate(37 33)">
          <ellipse cx="-4.6" cy="0" rx="4.4" ry="3.2" fill="#5aa9e6" />
          <ellipse cx="4.6" cy="0" rx="4.4" ry="3.2" fill="#5aa9e6" />
          <circle r="2" fill="#3f86c9" />
        </g>
        <g transform="translate(91 33)">
          <ellipse cx="-4.6" cy="0" rx="4.4" ry="3.2" fill="#5aa9e6" />
          <ellipse cx="4.6" cy="0" rx="4.4" ry="3.2" fill="#5aa9e6" />
          <circle r="2" fill="#3f86c9" />
        </g>
        {/* 大眼睛 */}
        <g class="pet-eyes">
          <ellipse cx="52" cy="56" rx="7" ry="8" fill="#fff" />
          <circle cx="52.4" cy="57" r="5" fill="#2f6fbf" />
          <circle cx="52.4" cy="57.4" r="2.5" fill="#152a4d" />
          <circle cx="50.4" cy="54.8" r="1.9" fill="#fff" />
          <circle cx="54.4" cy="59.6" r=".9" fill="#fff" opacity=".9" />
          <path d="M45.4 52 C47 48 57 48 58.6 52" fill="none" stroke="#2c4a78" strokeWidth="1.5" strokeLinecap="round" />
          <ellipse cx="76" cy="56" rx="7" ry="8" fill="#fff" />
          <circle cx="75.6" cy="57" r="5" fill="#2f6fbf" />
          <circle cx="75.6" cy="57.4" r="2.5" fill="#152a4d" />
          <circle cx="73.6" cy="54.8" r="1.9" fill="#fff" />
          <circle cx="77.6" cy="59.6" r=".9" fill="#fff" opacity=".9" />
          <path d="M69.4 52 C71 48 81 48 82.6 52" fill="none" stroke="#2c4a78" strokeWidth="1.5" strokeLinecap="round" />
        </g>
        <ellipse cx="43" cy="64" rx="5.4" ry="3.1" fill="#ffb0b0" opacity=".5" />
        <ellipse cx="85" cy="64" rx="5.4" ry="3.1" fill="#ffb0b0" opacity=".5" />
        <path d="M59 66 Q64 71.5 69 66" fill="none" stroke="#c76b6b" strokeWidth="2.2" strokeLinecap="round" />
      </g>

      {/* 亮晶晶 */}
      <g class="pet-spark" fill="#9ad4ff">
        <path d="M14 40 l1.6 4.4 4.4 1.6 -4.4 1.6 -1.6 4.4 -1.6 -4.4 -4.4 -1.6 4.4 -1.6 Z" />
        <path d="M112 32 l1.4 3.8 3.8 1.4 -3.8 1.4 -1.4 3.8 -1.4 -3.8 -3.8 -1.4 3.8 -1.4 Z" />
        <path d="M104 76 l1.2 3.2 3.2 1.2 -3.2 1.2 -1.2 3.2 -1.2 -3.2 -3.2 -1.2 3.2 -1.2 Z" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// the tour

interface Step {
  title: string;
  say: string;
  /** The live region this step frames; null leaves the frame off. */
  find: () => HTMLElement | null;
  /** 帮我演示: really does the thing, then reports what happened. */
  demo: () => string | Promise<string>;
}

/** 滚出可视区的芯片坐标没用（窄屏下聊天栏还会整块跑出视口），只框真正在屏幕里的那一枚。 */
function visibleChip(): HTMLElement | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return (
    all<HTMLElement>('.pane-chat a[href^="page:"]').find((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.bottom > 70 && r.top < vh - 10 && r.right > 0 && r.left < vw;
    }) || null
  );
}

/** 芯片可能藏在滚动区上方：滚一条进来，再等它落到可视区。 */
async function chipInView(): Promise<HTMLElement | null> {
  if (visibleChip()) return visibleChip();
  one<HTMLElement>('.pane-chat a[href^="page:"]')?.scrollIntoView({ block: "center" });
  await sleep(220);
  return visibleChip();
}

/** The reader toolbar's 框图提问 toggle. */
function regionButton(): HTMLElement | null {
  return all<HTMLElement>(".pane-reader .icon-btn").find((b) => (b.getAttribute("title") || "").startsWith("框图提问")) || null;
}

function makeSteps(host: { current: { onShowGraph: () => void; onExpandRail: () => void } }): Step[] {
  return [
    {
      title: "左侧文献库 · arXiv ID 一键抓取",
      say:
        "这里是我的家——个人文献知识库：3 篇内置论文已经精读好，批注、卡片、专题都齐了。点「⇪ 批量导入」，粘一行 1706.03762，剩下的抓取解析不用你动手。",
      find: () => one(".kb-import") || one(".kb-tools") || one(".rail-body"),
      demo: async () => {
        // 文献栏可能是收起的，面板也是点了才出现：每步都等真实 DOM 到位再做下一步。
        host.current.onExpandRail();
        if (!(await until(() => !!one(".kb-tools"), 2000))) return "文献栏没能展开：请点左上角的「»」后再试。";
        const toggle = all<HTMLElement>(".kb-tools .chip").find((b) => (b.textContent || "").includes("批量导入"));
        if (toggle && toggle.getAttribute("data-on") !== "true") toggle.click();
        if (!(await until(() => !!one(".kb-import textarea"), 2000))) return "批量导入面板没打开：手动点一下「⇪ 批量导入」。";
        typeInto(one<HTMLTextAreaElement>(".kb-import textarea")!, "1706.03762");
        return "arXiv ID 已经填进输入框：点「抓取导入」就会自动抓元数据 + 解析 PDF + 生成卡片。";
      },
    },
    {
      title: "右侧回答里的 [p. x] 页码芯片",
      say:
        "Pi 写的每句结论后面都挂着一枚 p.N 小标签。点它，左侧 PDF 立刻跳到那一页，并把它引用的原文句子圈出来——所以它想一本正经地胡说八道是不可能的。",
      find: () => visibleChip() || one(".pane-chat .scroll") || one(".pane-chat"),
      demo: async () => {
        // 芯片来自预置精读会话：先开论文，再等会话写入 IndexedDB 后渲染出来。
        let chip = await chipInView();
        if (!chip && (await ensurePaper())) {
          for (let i = 0; i < 30 && !(chip = await chipInView()); i++) await sleep(300);
        }
        if (!chip) return "右侧当前会话里还没有页码芯片：跑一次「🔬 快速精读」就会满屏都是。";
        chip.scrollIntoView({ block: "center", behavior: "smooth" });
        await sleep(320);
        chip.click();
        return `已替你点了「${(chip.textContent || "").trim()}」：左边 PDF 跳到了那一页，并把原文圈了出来。`;
      },
    },
    {
      title: "中间 PDF · 划词提问 + 框图提问",
      say:
        "鼠标在 PDF 里划过任意一句话，会浮出「翻译 / 解释 / 追问」；点工具栏的「框图提问」再拖一个方框圈住图表或公式，就能就着那张图直接提问。",
      find: () => one(".region-hint") || one(".pages") || one(".pane-reader"),
      demo: async () => {
        let btn = regionButton();
        if (!btn && (await ensurePaper())) {
          await sleep(700);
          btn = regionButton();
        }
        if (!btn) return "还没找到「框图提问」：先在左侧打开一篇论文，它就在阅读器工具栏右侧。";
        btn.click();
        return "框图提问已开启（出现了拖框提示）：在 PDF 上圈一张图表或公式，松手就发到右侧提问。";
      },
    },
    {
      title: "右下角 4 大科研 Skills 工具箱",
      say:
        "文献侦察兵 🔭 找上下游、方法论解剖室 🔬 拆公式与训练细节、横向对比矩阵 📊 排多篇差异、Research Gap 🧭 挖选题。技能自己抓数据，Pi 只负责把它讲成人话。",
      find: () => one(".skill-box") || one(".pane-chat"),
      demo: async () => {
        if (!(await ensurePaper())) return "文献库是空的：先在左上「⇪ 批量导入」粘一行 1706.03762。";
        api.events.emit({ type: "run-skill", skill: "anatomy" });
        return "已替你按下「🔬 方法论解剖室」：右侧正在逐页解剖当前论文，结论都带 p.N 芯片。";
      },
    },
    {
      title: "左上角 🕸 知识图谱 · 定位到原文",
      say:
        "图谱把知识库拆成 文献 / 方法 / 数据集 三类节点，用「改进自 / 基于 / 评测于」连成演化线。拖动可平移、滚轮可缩放，点节点再看「定位到原文 p.N」一键跳回 PDF。",
      find: () =>
        one(".node-detail") || one(".graph-view .graph-toolbar") || one(".graph-view") || one(".mode-toggle") || one(".rail-head"),
      demo: async () => {
        // 文献栏收起时 🕸 按钮根本没渲染，先展开再切模式。
        host.current.onExpandRail();
        await until(() => !!one(".mode-toggle"), 1500);
        host.current.onShowGraph();
        await until(() => !!one(".graph-view"), 4000);
        return "已切到知识图谱模式：随便点一个节点试试，详情页里有「定位到原文」。";
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// the pet

export function Pet({ onShowGraph, onExpandRail, dockOpen }: { onShowGraph: () => void; onExpandRail: () => void; dockOpen: boolean }) {
  const host = useRef({ onShowGraph, onExpandRail });
  useEffect(() => {
    host.current = { onShowGraph, onExpandRail };
  }, [onShowGraph, onExpandRail]);
  const steps = useMemo(() => makeSteps(host), []);

  const [min, setMin] = useState(() => localStorage.getItem(K_MIN) === "1");
  const [pos, setPos] = useState<Box>(startPos);
  const [view, setView] = useState<"menu" | "welcome" | "">("");
  const [say, setSay] = useState("");
  const [hint, setHint] = useState("");
  const [step, setStep] = useState(-1);
  const [box, setBox] = useState<Box | null>(null);
  const [boing, setBoing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const posRef = useRef(pos);
  const dragRef = useRef({ on: false, moved: false, dx: 0, dy: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(!!localStorage.getItem(K_POS));

  const save = useCallback((b: Box) => {
    posRef.current = b;
    setPos(b);
  }, []);

  const bounce = useCallback(() => {
    setBoing(true);
    window.setTimeout(() => setBoing(false), 560);
  }, []);

  // 首次访问：小鲸鱼自己探出头来打个招呼
  useEffect(() => {
    if (localStorage.getItem(K_SEEN)) return;
    const t = window.setTimeout(() => {
      setMin(false);
      setSay("嗨！我是小鲸鱼 Pi，你的科研助手。要不要花 1 分钟，我把这个工作台带你逛一圈？");
      setView("welcome");
    }, 900);
    return () => window.clearTimeout(t);
  }, []);

  // splitter、划词浮窗、窗口尺寸变化后：没被拖过就回到右下角，拖过就只做避让
  useEffect(() => {
    const fit = () => save(dragged.current ? clampPos(posRef.current.x, posRef.current.y) : homePos());
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [dockOpen, min, save]);

  // 导览进行中：跟着真实功能区走
  useEffect(() => {
    if (step < 0) {
      setBox(null);
      return;
    }
    let timer = 0;
    // A key of "" means "nothing to frame"; the sentinel start guarantees that
    // state is written at least once, so a step without a target drops the frame.
    let prev = "\u0000";
    const tick = () => {
      const el = steps[step]?.find() || null;
      let key = "";
      let next: Box | null = null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          next = { x: r.left, y: r.top, w: r.width, h: r.height };
          key = `${next.x.toFixed(1)},${next.y.toFixed(1)},${next.w.toFixed(1)},${next.h.toFixed(1)}`;
        }
      }
      if (key !== prev) {
        prev = key;
        setBox(next);
      }
      timer = window.setTimeout(tick, 220);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [step, steps]);

  const startTour = useCallback(() => {
    localStorage.setItem(K_SEEN, "1");
    bounce();
    setView("");
    setHint("");
    setStep(0);
  }, [bounce]);

  const finishTour = useCallback((note?: string) => {
    localStorage.setItem(K_SEEN, "1");
    setStep(-1);
    setBox(null);
    setHint("");
    if (note) {
      setSay(note);
      setView("menu");
    }
  }, []);

  const tap = useCallback(() => {
    bounce();
    if (step >= 0) {
      finishTour();
      return;
    }
    if (view) {
      setView("");
      return;
    }
    localStorage.setItem(K_SEEN, "1");
    setSay("想让我带你逛一圈，还是直接演示某个功能？下面这几个按钮都是真的会动手的。");
    setView("menu");
  }, [bounce, finishTour, step, view]);

  // 位移不足 6px 算点击，算了拖动就把位置记下来
  const grab = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      d.on = true;
      d.moved = false;
      d.dx = e.clientX - posRef.current.x;
      d.dy = e.clientY - posRef.current.y;
      const x0 = e.clientX;
      const y0 = e.clientY;
      setDragging(true);
      const move = (ev: PointerEvent) => {
        if (!d.on) return;
        if (!d.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) >= 6) d.moved = true;
        if (d.moved) save(clampPos(ev.clientX - d.dx, ev.clientY - d.dy));
      };
      const up = () => {
        d.on = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDragging(false);
        if (!d.moved) {
          tap();
          return;
        }
        dragged.current = true;
        localStorage.setItem(K_POS, `${Math.round(posRef.current.x)},${Math.round(posRef.current.y)}`);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [save, tap],
  );

  const runDemo = useCallback(async () => {
    const fn = steps[step]?.demo;
    if (!fn || busy) return;
    bounce();
    setBusy(true);
    try {
      setHint(String(await fn()));
    } catch (e: any) {
      setHint(`演示没成功：${String(e?.message || e)}`);
    } finally {
      setBusy(false);
    }
  }, [bounce, busy, step, steps]);

  const nextStep = useCallback(() => {
    bounce();
    if (step + 1 < steps.length) {
      setHint("");
      setStep(step + 1);
    } else finishTour("导览完啦！上面那几个按钮随时能再来一遍；嫌我挡路就把我拖走，或者按右上角「—」收进侧边 🐳");
  }, [bounce, finishTour, step, steps]);

  const shortcut = useCallback(
    async (kind: "read" | "compare" | "graph") => {
      bounce();
      localStorage.setItem(K_SEEN, "1");
      if (kind === "graph") {
        setView("");
        setSay("");
        host.current.onShowGraph();
        return;
      }
      if (busy) return;
      setBusy(true);
      try {
        if (kind === "read") {
          if (!(await ensurePaper())) {
            setSay("文献库还是空的：先在「⇪ 批量导入」里粘一行 1706.03762，我马上给你精读。");
            return;
          }
          api.events.emit({ type: "run-skill", skill: "anatomy" });
          setSay("🔬 方法论解剖室已启动：右侧正在逐页精读当前论文，每句结论都带 p.N 芯片。");
        } else {
          host.current.onExpandRail();
          const list = api.papers.list();
          if (list.length < 2) {
            setSay("对比至少需要 2 篇文献：先在「⇪ 批量导入」里多粘几行 arXiv ID。");
            return;
          }
          if (!(await ensurePaper())) return;
          api.selection.set(list.slice(0, 3).map((p) => p.itemKey));
          api.events.emit({ type: "run-skill", skill: "matrix" });
          setSay(`📊 已替你勾选 ${Math.min(3, list.length)} 篇并发起横向对比：右侧会生成创新点差异矩阵。`);
        }
      } finally {
        setBusy(false);
      }
    },
    [bounce, busy],
  );

  const collapse = useCallback(() => {
    setMin(true);
    setView("");
    setStep(-1);
    setBox(null);
    localStorage.setItem(K_MIN, "1");
  }, []);

  const spot: Style | null = box
    ? { left: `${box.x - 9}px`, top: `${box.y - 9}px`, width: `${box.w + 18}px`, height: `${box.h + 18}px` }
    : null;

  // 卡片贴在功能区旁边，位置随实测尺寸算，绝不压在被讲解的区域上
  let card: Style | undefined;
  if (step >= 0) {
    if (!box) card = { left: "50%", top: "auto", bottom: "18px", transform: "translateX(-50%)" };
    else {
      const cw = cardRef.current?.offsetWidth || 340;
      const ch = cardRef.current?.offsetHeight || 208;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const below = box.y + box.h + 22;
      const above = box.y - ch - 20;
      let top = below + ch <= vh - 12 ? below : above >= 12 ? above : Math.max(12, vh - ch - 12);
      if (box.h + 18 > vh * 0.55) top = Math.max(56, vh - ch - 18);
      card = { left: `${Math.round(Math.min(Math.max(12, box.x - 8), Math.max(12, vw - cw - 12)))}px`, top: `${Math.round(top)}px` };
    }
  }

  const anchor: Style = min
    ? { left: `${Math.max(8, window.innerWidth - MIN_W - 12)}px`, top: `${Math.min(pos.y + H - MIN_W, floorY(MIN_W))}px` }
    : { left: `${pos.x}px`, top: `${pos.y}px` };

  // 气泡贴着鲸鱼向左展开，但整块都要留在屏幕里；尖角始终指回鲸鱼头顶
  const vw2 = window.innerWidth;
  const bubW = Math.min(316, vw2 - 24);
  const bubLeft = Math.max(12, Math.min(pos.x + W + 6 - bubW, Math.max(12, vw2 - bubW - 12)));
  const tail = Math.max(20, Math.min(pos.x + 26 - bubLeft, bubW - 28));
  const bubbleStyle = { width: `${bubW}px`, left: `${Math.round(bubLeft - pos.x)}px`, "--tail": `${Math.round(tail)}px` } as Style;

  return (
    <div class={min ? "pet min" : "pet"} style={anchor}>
      {min ? (
        <button
          class="pet-min"
          type="button"
          title="叫出小鲸鱼 Pi 科研小助手"
          onClick={() => {
            setMin(false);
            localStorage.setItem(K_MIN, "");
            bounce();
            if (!view && step < 0) {
              setSay("我在呢！要逛一圈还是直接演示？");
              setView("menu");
            }
          }}
        >
          <Whale face />
        </button>
      ) : (
        <>
          <div class={`pet-float${boing ? " boing" : ""}${dragging ? " drag" : ""}`}>
            <button
              class="pet-whale"
              type="button"
              aria-label="Pi 科研小助手：点一下看功能导览，按住可以拖动"
              onPointerDown={grab}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  tap();
                }
              }}
            >
              <Whale />
            </button>
          </div>
          <button class="pet-hide" type="button" title="收起小助手（变成侧边迷你气泡）" onClick={collapse}>
            —
          </button>
          {!!view && (
            <div class="pet-bubble" style={bubbleStyle} role="dialog" aria-label="Pi 科研小助手">
              <div class="pet-bub-head">
                <span class="pet-avatar">
                  <Whale face />
                </span>
                <b>Pi 科研小助手</b>
                <button class="pet-x" type="button" title="收起（Esc）" onClick={() => setView("")}>
                  ×
                </button>
              </div>
              <p class="pet-say">{say}</p>
              <div class="pet-btns">
                <button class="primary" type="button" onClick={startTour}>
                  ▶ 1 分钟带逛导览
                </button>
                <button type="button" disabled={busy} onClick={() => void shortcut("read")}>
                  🔬 快速精读当前论文
                </button>
                <button type="button" disabled={busy} onClick={() => void shortcut("compare")}>
                  📊 多篇对比找创新点
                </button>
                <button type="button" onClick={() => void shortcut("graph")}>
                  🕸 查看知识演化图谱
                </button>
              </div>
              {view === "welcome" && (
                <button
                  class="link-btn"
                  type="button"
                  onClick={() => {
                    localStorage.setItem(K_SEEN, "1");
                    setView("");
                  }}
                >
                  先不用，我自己逛逛
                </button>
              )}
              <div class="pet-foot muted small">按住我可以换位置 · 右上角「—」收进侧边</div>
            </div>
          )}
        </>
      )}

      {step >= 0 && spot && <div class="pet-spot" style={spot} />}
      {step >= 0 && (
        <div class="pet-card" ref={cardRef} style={card} role="dialog" aria-label="1 分钟带逛导览">
          <div class="pet-card-head">
            <span class="pet-avatar">
              <Whale face />
            </span>
            <b>{steps[step].title}</b>
            <span class="pet-step-no muted small">
              {step + 1}/{steps.length}
            </span>
            <button class="pet-x" type="button" title="结束导览（Esc）" onClick={() => finishTour()}>
              ×
            </button>
          </div>
          <p class="pet-say">{steps[step].say}</p>
          {!!hint && <div class="pet-hint">✨ {hint}</div>}
          <div class="pet-card-foot">
            <span class="pet-dots">
              {steps.map((s, i) => (
                <i key={s.title} class={i === step ? "on" : ""} />
              ))}
            </span>
            <span class="spacer" />
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            )}
            <button class="link-btn" type="button" onClick={() => finishTour()}>
              跳过
            </button>
            <button type="button" disabled={busy} onClick={() => void runDemo()}>
              {busy ? <span class="spinner" /> : "✨"} 帮我演示
            </button>
            <button class="primary" type="button" onClick={nextStep}>
              {step + 1 < steps.length ? "下一步" : "完成导览"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
