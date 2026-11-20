/**
 * 蓝发小鲸鱼 · Pi 科研小助手 —— the floating web desktop pet.
 *
 * The mascot is the original illustration, served from /mascot.png and cut out
 * of its white ground once at load, so she stands on the page with no box around
 * her. She breathes, she is draggable, and she hosts the 1 分钟带逛导览 — each
 * step frames the region it is talking about by measuring that element, so the
 * highlight keeps up when a panel opens or a skill fills the chat. Where she may
 * not go is decided by the layout, not by a magic number: the send box, the 划词
 * dock and the bottom-right watermark stay clear.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getApi } from "./api";
import { petMiniDefault } from "../shared/layout";

const api = getApi();

const K_POS = "scholarpi.pet.pos";
const K_MIN = "scholarpi.pet.min";
const K_SEEN = "scholarpi.pet.seen";

/** Whale box (the art is 897x1024, so 110x126 keeps her exact ratio), plus the
 *  panels she must never sit on top of. */
const W = 110;
const H = 126;
const MIN_W = 44;
/** 右下角的 Made with Qoder 水印住在视口底边这条带子里，她绝不落到下面去。 */
const BOTTOM = 56;
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
  // 公网冷启动要把整篇 PDF 拉下来解析，十秒不够用
  return until(() => !!api.context.get().ref, 30000);
}

// ---------------------------------------------------------------------------
// placement

/** The lowest the whale may sit: above the send box, the quick dock and the watermark. */
function floorY(h: number): number {
  let y = window.innerHeight - h - BOTTOM;
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
  const right = chat ? chat.getBoundingClientRect().left : window.innerWidth - 20;
  return clampPos(right - W - 18, floorY(H));
}

function startPos(): Box {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec((localStorage.getItem(K_POS) || "").trim());
  return m ? clampPos(Number(m[1]), Number(m[2])) : homePos();
}

/** Narrow desktops get her as a side bubble from the start; an explicit choice always wins. */
function defaultMin(): boolean {
  const stored = localStorage.getItem(K_MIN);
  return stored === null ? petMiniDefault(window.innerWidth) : stored === "1";
}

// ---------------------------------------------------------------------------
// the mascot: the original illustration, knocked out of its white ground

const SPRITE = "/mascot.png";
/** 抠图只做一次，边长 420 够撑到 2x 屏，又不会让首帧等太久。 */
const SPRITE_EDGE = 420;

let spritePromise: Promise<string | null> | null = null;

/**
 * 她身上有白蕾丝发带、白围裙和白袜，按颜色全局去白会把这些一起擦掉，所以先只
 * 清除与画框连成一片的白。但呆毛卷成的圈、手臂与长发之间还封着几块同样的背景
 * 白：它们连不上画框，得靠「面积足够大的同色封闭色块」这条规则认出来。
 */
function cutout(img: HTMLImageElement): string | null {
  const k = Math.min(1, SPRITE_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * k));
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * k));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);
  const d = frame.data;
  const n = w * h;

  // 底色从画框一圈取中位数，别硬编码：换一张图也照样认
  const ring: number[] = [];
  for (let x = 0; x < w; x++) {
    ring.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    ring.push(y * w, y * w + w - 1);
  }
  const chan = (c: number) => {
    const v = ring.map((i) => d[i * 4 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const bgc = [chan(0), chan(1), chan(2)];
  /** 平涂背景：和底色几乎一模一样，没有笔触也没有阴影。 */
  const flat = (i: number) =>
    Math.abs(d[i * 4] - bgc[0]) <= 2 && Math.abs(d[i * 4 + 1] - bgc[1]) <= 2 && Math.abs(d[i * 4 + 2] - bgc[2]) <= 2;
  /** 泛白：背景连同它的一圈 JPEG 毛边。 */
  const pale = (i: number, lo: number) => {
    const m = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    return m >= lo && Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - m <= 28;
  };

  const bg = new Uint8Array(n);
  const queue: number[] = [];
  const eat = (i: number, lo: number) => {
    if (!bg[i] && pale(i, lo)) {
      bg[i] = 1;
      queue.push(i);
    }
  };
  const near = (i: number, lo: number) => {
    const x = i % w;
    if (x > 0) eat(i - 1, lo);
    if (x < w - 1) eat(i + 1, lo);
    if (i >= w) eat(i - w, lo);
    if (i + w < n) eat(i + w, lo);
  };
  for (const seed of ring) eat(seed, 236);
  for (let head = 0; head < queue.length; head++) near(queue[head], 236);
  // 白底边缘那圈淡灰毛边：向外再吃一格，够亮才吃，不碰描线
  const frontier = queue.length;
  for (let head = 0; head < frontier; head++) near(queue[head], 208);

  // 被封在角色身上的平涂背景：面积占画面 0.03% 以上才算，免得在衣服高光上打个洞
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || bg[s] || !flat(s)) continue;
    const comp: number[] = [s];
    seen[s] = 1;
    let touches = false;
    for (let head = 0; head < comp.length; head++) {
      const i = comp[head];
      const x = i % w;
      if (x === 0 || x === w - 1 || i < w || i + w >= n) touches = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < n ? i + w : -1]) {
        if (j >= 0 && !seen[j] && !bg[j] && flat(j)) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    if (touches || comp.length < n * 0.0003) continue;
    for (const i of comp) bg[i] = 1;
    for (const i of comp) near(i, 236);
  }

  for (let i = 0; i < n; i++) {
    if (bg[i]) {
      d[i * 4 + 3] = 0;
      continue;
    }
    const x = i % w;
    const edge = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (i >= w && bg[i - w]) || (i + w < n && bg[i + w]);
    if (edge && (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10 >= 228) d[i * 4 + 3] = 150;
  }
  ctx.putImageData(frame, 0, 0);
  return cv.toDataURL("image/png");
}

function loadSprite(): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve(cutout(img));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = SPRITE;
  });
}

/** 处理结果缓存在模块里：立绘、迷你气泡和卡片头像共用同一张透明图。 */
function useSprite(): string {
  const [src, setSrc] = useState(SPRITE);
  useEffect(() => {
    let live = true;
    if (!spritePromise) spritePromise = loadSprite();
    spritePromise.then((url) => {
      if (live && url) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, []);
  return src;
}

function Whale({ face = false }: { face?: boolean }) {
  const src = useSprite();
  // 抠图还没好（或失败了）：把整张原图收进圆角画框，白底就不会糊在页面上
  const cls = face ? "pet-face" : `pet-img${src === SPRITE ? " raw" : ""}`;
  return <img class={cls} src={src} alt="" aria-hidden="true" draggable={false} />;
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
      find: () => one(".kb-import") || one(".kb-tools") || one(".rail-body") || one(".rail"),
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
        if (!btn) {
          // 线上 PDF 边下边解析：等真实按钮出现，而不是固定等一会儿
          await ensurePaper();
          await until(() => !!regionButton(), 12000);
          btn = regionButton();
        }
        if (!btn) return "还没找到「框图提问」：先在左侧打开一篇论文，它就在阅读器工具栏右侧。";
        btn.click();
        return "框图提问已开启（出现了拖框提示）：在 PDF 上圈一张图表或公式，松手就发到右侧提问。";
      },
    },
    {
      title: "右下角「继续研究」4 个入口",
      say:
        "找相关论文 🔭 顺藤摸瓜、拆解方法 🔬 讲清公式与训练细节、跨篇对比 📊 排多篇差异、寻找研究方向 🧭 给出可执行选题。",
      find: () => one(".skill-box") || one(".pane-chat"),
      demo: async () => {
        if (!(await ensurePaper())) return "文献库是空的：先在左上「⇪ 批量导入」粘一行 1706.03762。";
        api.events.emit({ type: "run-skill", skill: "anatomy" });
        return "已按下「🔬 拆解方法」：右侧正在逐页解剖当前论文，结论都带 p.N 芯片。";
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

  const [min, setMin] = useState(defaultMin);
  const [pos, setPos] = useState<Box>(startPos);
  const [view, setView] = useState<"menu" | "welcome" | "">("");
  const [say, setSay] = useState("");
  const [hint, setHint] = useState("");
  const [step, setStep] = useState(-1);
  const [box, setBox] = useState<Box | null>(null);
  const [boing, setBoing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 窄屏首访：不自动展开大面板，只在迷你气泡上亮一颗待点的小圆点。 */
  const [nudge, setNudge] = useState(false);

  const posRef = useRef(pos);
  const minRef = useRef(min);
  minRef.current = min;
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

  // 首次访问：宽屏自己探出头来打个招呼；窄屏只点亮迷你气泡，等用户自己点开
  useEffect(() => {
    if (localStorage.getItem(K_SEEN)) return;
    const t = window.setTimeout(() => {
      if (minRef.current) {
        setNudge(true);
        return;
      }
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
    setHint("稍等，我这就动手演示…");
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
          setSay("🔬 拆解方法已启动：右侧正在逐页精读当前论文，每句结论都带 p.N 芯片。");
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
          setSay(`📊 已勾选 ${Math.min(3, list.length)} 篇并发起横向对比：右侧会生成创新点差异表。`);
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

  // 气泡贴着鲸鱼横向展开，整块都要留在屏幕里；头顶不如脚下宽敞就往下面开，尖角始终指回她
  const vw2 = window.innerWidth;
  const vh2 = window.innerHeight;
  const bubW = Math.min(316, vw2 - 24);
  const bubLeft = Math.max(12, Math.min(pos.x + W + 6 - bubW, Math.max(12, vw2 - bubW - 12)));
  const tail = Math.max(20, Math.min(pos.x + 26 - bubLeft, bubW - 28));
  const down = pos.y < vh2 - pos.y - H;
  const room = (down ? vh2 - pos.y - H : pos.y) - 16;
  const bubbleStyle = {
    width: `${bubW}px`,
    left: `${Math.round(bubLeft - pos.x)}px`,
    maxHeight: `${Math.max(132, Math.min(Math.round(vh2 * 0.62), room))}px`,
    "--tail": `${Math.round(tail)}px`,
  } as Style;

  return (
    <div class={`pet${min ? " min" : ""}${min && nudge ? " nudge" : ""}`} style={anchor}>
      {min ? (
        <button
          class={nudge ? "pet-min nudge" : "pet-min"}
          type="button"
          title={nudge ? "小鲸鱼 Pi 有个 1 分钟带逛，点开看看" : "叫出小鲸鱼 Pi 科研小助手"}
          onClick={() => {
            setMin(false);
            localStorage.setItem(K_MIN, "");
            setNudge(false);
            bounce();
            if (!view && step < 0) {
              setSay(
                nudge
                  ? "嗨！我是小鲸鱼 Pi，你的科研助手。要不要花 1 分钟，我把这个工作台带你逛一圈？"
                  : "我在呢！要逛一圈还是直接演示？",
              );
              setView(nudge ? "welcome" : "menu");
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
            <div class={down ? "pet-bubble down" : "pet-bubble"} style={bubbleStyle} role="dialog" aria-label="Pi 科研小助手">
              <div class="pet-bub-head">
                <span class="pet-avatar">
                  <Whale face />
                </span>
                <b>Pi 科研小助手</b>
                <button
                  class="pet-x"
                  type="button"
                  title="收起（Esc）"
                  onClick={() => {
                    if (view === "welcome") localStorage.setItem(K_SEEN, "1");
                    setView("");
                  }}
                >
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
