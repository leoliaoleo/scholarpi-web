/**
 * The single façade the Preact UI talks to.
 *
 * In the desktop plugin this was a ChromeUtils / window.postMessage bridge into
 * the Zotero window. Here everything runs in one page: the agent core is
 * imported directly, and the browser-only bits (opening a paper, jumping to a
 * page) are delegated to hooks the workbench registers on startup.
 */
import { getAnnotation, listAnnotations, locate } from "../core/annotate";
import { getSettings, saveSettings as persistSettings } from "../core/config";
import { Emitter, globalEvents } from "../core/events";
import { getHealth, type Health } from "../core/host";
import * as kb from "../core/library";
import { builtinToolInfos, configuredServers, mcpStates, parseServers, refreshMcp } from "../core/mcp";
import { listModels, testConnection } from "../core/llm";
import {
  getItem,
  listPapers,
  loadRegistry,
  paperTitle,
  ref as makeRef,
  registerFile,
  registerUrl,
  removePaper,
  type Paper,
  type PaperRef,
} from "../core/paper";
import { QuickService, IMAGE_ACTIONS } from "../core/quick";
import { seedPreset as seedPresetSession } from "../core/presets";
import { clearSelection, selectionChanges, selectedKeys, setSelection, toggleSelection } from "../core/selection";
import { SKILLS, grabCandidates, lastSkillRun, runSkill } from "../core/skills";
import { SessionManager } from "../core/sessions";
import { gotoPage, highlightRects, paperKey, refFromPaperKey, setViewerState, viewerCommands, viewerState } from "../core/viewer-state";

export const VERSION = "0.1.0";

export const sessions = new SessionManager();
export const quick = new QuickService(sessions);

// ---------------------------------------------------------------------------
// viewer hooks (registered by the reader component)

export interface ViewerHooks {
  /** Render the region the user boxed, for 框图提问. */
  captureRegion?: () => Promise<any | null>;
  /** Load a paper into the reader (and optionally jump to a page). */
  openPaper?: (itemKey: string, page?: number) => void | Promise<void>;
  /** Bring up the settings panel. */
  openSettings?: () => void;
}

const hooks: ViewerHooks = {};

export function registerViewerHooks(h: ViewerHooks): void {
  Object.assign(hooks, h);
}

// ---------------------------------------------------------------------------
// context: the paper the reader has open drives the chat panel

interface ContextInfo {
  ref: PaperRef | null;
  title: string;
  /** "reader" when a PDF is actually rendered, so capture / page jumps work. */
  source: "reader" | "none";
}

const contextChanges = new Emitter<ContextInfo>();

function contextInfo(): ContextInfo {
  const key = viewerState.paperKey;
  const item = key ? getItem(refFromPaperKey(key)) : null;
  return {
    ref: item ? { libraryID: item.libraryID, itemKey: item.itemKey } : null,
    title: item ? paperTitle(item) : "",
    source: item ? "reader" : "none",
  };
}

export function refreshContext(): void {
  contextChanges.emit(contextInfo());
}

// ---------------------------------------------------------------------------
// settings, wrapped so every change reaches the UI through one event

function saveSettings(patch: any): void {
  persistSettings(patch);
  globalEvents.emit({ type: "settings-changed" });
  // MCP rows change the tool list, so idle sessions are rebuilt (ensureMcp runs first).
  if ("mcpBridge" in patch || "mcpServers" in patch) void rebuildAfterMcpChange();
}

async function rebuildAfterMcpChange(): Promise<void> {
  try {
    await sessions.refreshAll();
  } finally {
    globalEvents.emit({ type: "tools-changed", servers: mcpStates() });
  }
}

// ---------------------------------------------------------------------------
// papers

export async function openItemKey(itemKey: string, page?: number): Promise<void> {
  if (hooks.openPaper) return hooks.openPaper(itemKey, page);
  setViewerState({ paperKey: itemKey ? paperKey(makeRef(itemKey)) : null });
}

const api = {
  version: VERSION,
  events: globalEvents,
  sessions,
  quick,
  imageActions: () => IMAGE_ACTIONS,
  context: {
    get: () => contextInfo(),
    changes: contextChanges,
  },

  getSettings,
  saveSettings,
  listModels,
  testConnection,
  health: getHealth,

  papers: {
    /** Refresh the demo list + user papers from the backend / IndexedDB. */
    reload: loadRegistry,
    list: listPapers,
    get: (itemKey: string): Paper | null => getItem(makeRef(itemKey)),
    addFile: registerFile,
    addUrl: registerUrl,
    remove: removePaper,
    annotations: (itemKey: string) => listAnnotations(getItem(makeRef(itemKey)) as Paper),
  },

  /** 个人科研知识库：专题、标签、元数据卡片、全局检索、导入导出。 */
  kb: {
    /** 首次访问写入示范专题与演示论文卡片；库里已有数据时不做任何改动。 */
    ensureSeeded: kb.ensureSeeded,
    stats: kb.libraryStats,
    collections: kb.listCollections,
    createCollection: kb.createCollection,
    updateCollection: kb.updateCollection,
    deleteCollection: kb.deleteCollection,
    addToCollection: kb.collectionAdd,
    removeFromCollection: kb.collectionRemove,
    collectionsOf: kb.collectionsOf,
    tags: kb.tagsIndex,
    paperTags: async (itemKey: string): Promise<string[]> => {
      const item = getItem(itemKey);
      if (!item) return [];
      return kb.tagsOf(item, await kb.getCard(itemKey));
    },
    setTags: kb.setPaperTags,
    /** All cards, so the list can show which papers still need one. */
    cards: kb.listCards,
    card: async (itemKey: string) => {
      const item = getItem(itemKey);
      return item ? kb.cardView(item) : null;
    },
    saveCard: kb.saveCard,
    generateCard: kb.generateCard,
    search: kb.searchLibrary,
    importBlock: kb.importBlock,
    importFiles: kb.importFiles,
    /** 删除文献本体，并把它从专题/卡片里清理干净。 */
    remove: kb.removeItem,
    exportJson: kb.exportBackup,
    exportBibtex: kb.exportBibtex,
    importBackup: kb.importBackup,
    download: kb.downloadText,
  },

  /** 科研 Skills 工具箱：技能自己抓数据，回答仍然走当前会话。 */
  skills: {
    list: () => SKILLS,
    run: runSkill,
    grab: grabCandidates,
    last: lastSkillRun,
  },

  /** MCP：内置学术桥接器 + 用户自配的 HTTP/SSE 服务。 */
  mcp: {
    servers: configuredServers,
    states: mcpStates,
    parse: parseServers,
    refresh: refreshMcp,
    builtinTools: builtinToolInfos,
    /** 设置面板的「连接并测试」：先落盘，再强制发现，最后把工具列表交给现有会话。 */
    async apply(patch: any) {
      persistSettings(patch);
      globalEvents.emit({ type: "settings-changed" });
      const report = await refreshMcp({ probe: true });
      await sessions.refreshAll().catch((e) => console.warn("[ScholarPi] MCP 工具重建失败", e));
      globalEvents.emit({ type: "tools-changed", servers: report.servers });
      return report;
    },
  },

  /** 左侧勾选的多篇文献（对比矩阵技能读取）。 */
  selection: {
    get: selectedKeys,
    set: setSelection,
    toggle: toggleSelection,
    clear: clearSelection,
    changes: selectionChanges,
  },

  /** First visit to a demo paper: load its built-in close-reading session. */
  seedPreset: (ref: PaperRef) => seedPresetSession(ref),

  openPaper: openItemKey,

  /** `[p. 5]` citation chip → scroll the reader (and outline the passage when given). */
  async openPage(refOrKey: PaperRef | string, page: number, quote?: string): Promise<void> {
    const itemKey = typeof refOrKey === "string" ? refOrKey : refOrKey.itemKey;
    const item = getItem(makeRef(itemKey));
    const key = paperKey(makeRef(itemKey));
    if (viewerState.paperKey !== key) await openItemKey(itemKey, page);
    gotoPage(page);
    if (!item || !quote) return;
    try {
      const loc = await locate(item, quote, page);
      highlightRects(loc.pageIndex, loc.rects, loc.viewBox);
      if (loc.pageIndex + 1 !== page) viewerCommands.emit({ type: "notice", text: `原句在第 ${loc.pageIndex + 1} 页，已按引用跳到第 ${page} 页。`, tone: "info" });
    } catch (e: any) {
      // 跳页成功不等于匹配成功：这句话必须说出来，否则读者会以为圈出来的就是依据。
      const noText = !!e?.noTextLayer;
      viewerCommands.emit({
        type: "notice",
        text: noText
          ? String(e?.message || e)
          : `已跳转至第 ${page} 页，未精确匹配到原句高亮：这段引用可能是改写或跨页拼接，请以页面原文为准。`,
        tone: "warn",
      });
      console.debug("[ScholarPi] quote not located for highlight", e);
    }
  },

  /** Annotation chip / toast click → jump and outline it in the reader. */
  async openAnnotation(_libraryID: number, key: string): Promise<void> {
    const ann = await getAnnotation(key);
    if (!ann) return;
    const at = paperKey({ libraryID: ann.libraryID, itemKey: ann.itemKey });
    if (viewerState.paperKey !== at) await openItemKey(ann.itemKey, Number(ann.pageLabel) || 1);
    gotoPage(Number(ann.pageLabel) || ann.pageIndex + 1);
    if (ann.rects?.length) highlightRects(ann.pageIndex, ann.rects, ann.viewBox, true);
    globalEvents.emit({ type: "show-annotation", key: ann.key });
  },

  async captureRegion(): Promise<any | null> {
    return (await hooks.captureRegion?.()) ?? null;
  },

  openSettings(): void {
    if (hooks.openSettings) hooks.openSettings();
    else globalEvents.emit({ type: "open-settings" });
  },

  launchURL(url: string): void {
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
  },
};

export type PiApi = typeof api;

export function getApi(): PiApi {
  return api;
}

/** Kept for the migrated components, which cloned values across the chrome boundary. */
export function clone<T>(x: T): T {
  return x == null ? x : (JSON.parse(JSON.stringify(x)) as T);
}

export function subscribe<T>(emitter: Emitter<T>, fn: (v: T) => void): () => void {
  const off = emitter.on(fn);
  window.addEventListener("unload", off, { once: true });
  return off;
}

export type { Health };
