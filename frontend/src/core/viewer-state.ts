/**
 * Shared state + command bus between the agent core and the pdf.js reader UI.
 * The reader owns the pixels; tools only ask it to move or highlight.
 */
// .ts extension: node --test loads this module directly (test/outline-panel.test.ts).
import { Emitter } from "./events.ts";

export interface ViewerState {
  /** paperKey (`${libraryID}/${itemKey}`) currently displayed, null when empty. */
  paperKey: string | null;
  /** 1-based page currently shown. */
  currentPage: number;
  pageCount: number;
  /** Set while the reader is loading a document. */
  loading: boolean;
}

export const viewerState: ViewerState = { paperKey: null, currentPage: 1, pageCount: 0, loading: false };

export const viewerChanges = new Emitter<ViewerState>();

export function setViewerState(patch: Partial<ViewerState>): void {
  Object.assign(viewerState, patch);
  viewerChanges.emit({ ...viewerState });
}

export type ViewerCommand =
  | { type: "goto"; page: number; smooth?: boolean }
  | { type: "highlight"; pageIndex: number; rects: number[][]; viewBox: number[]; keep?: boolean }
  | { type: "clear-highlight" }
  | { type: "notice"; text: string; tone?: "warn" | "info" }
  | { type: "refresh" };

export const viewerCommands = new Emitter<ViewerCommand>();

export function paperKey(ref: { libraryID: number; itemKey: string }): string {
  return `${ref.libraryID}/${ref.itemKey}`;
}

export function refFromPaperKey(key: string): { libraryID: number; itemKey: string } {
  const [libraryID, ...rest] = key.split("/");
  return { libraryID: Number(libraryID) || 1, itemKey: rest.join("/") };
}

/** Ask the reader to show a page (1-based). */
export function gotoPage(page: number, smooth = true): void {
  viewerCommands.emit({ type: "goto", page: Math.max(1, Math.round(page)), smooth });
}

/** Ask the reader to outline a located quote (rects in PDF user space). */
export function highlightRects(pageIndex: number, rects: number[][], viewBox: number[], keep = false): void {
  viewerCommands.emit({ type: "highlight", pageIndex, rects, viewBox, keep });
}

export function clearHighlight(): void {
  viewerCommands.emit({ type: "clear-highlight" });
}
