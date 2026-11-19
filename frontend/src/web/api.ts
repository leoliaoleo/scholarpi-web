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
import { SessionManager } from "../core/sessions";
import { gotoPage, highlightRects, paperKey, refFromPaperKey, setViewerState, viewerState } from "../core/viewer-state";

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
    } catch (e) {
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
