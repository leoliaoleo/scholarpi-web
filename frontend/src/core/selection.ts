/**
 * Which papers the left rail has ticked, shared between the library panel and the chat
 * panel (the 多篇横向对比矩阵 skill reads it). Keys are itemKeys.
 */
import { Emitter, globalEvents } from "./events";

const MAX = 5;

const changes = new Emitter<string[]>();
let keys: string[] = [];

export const selectionChanges = changes;

export function selectedKeys(): string[] {
  return keys;
}

export function isSelected(itemKey: string): boolean {
  return keys.includes(itemKey);
}

export function setSelection(next: string[]): void {
  keys = [...new Set(next)].slice(0, MAX);
  changes.emit(keys);
  globalEvents.emit({ type: "selection-changed", keys: [...keys] });
}

export function toggleSelection(itemKey: string): void {
  const next = keys.includes(itemKey) ? keys.filter((k) => k !== itemKey) : [...keys, itemKey];
  if (next.length > MAX) {
    globalEvents.emit({ type: "notice", text: `一次最多对比 ${MAX} 篇（矩阵列太宽会读不动）` });
    return;
  }
  setSelection(next);
}

export function clearSelection(): void {
  setSelection([]);
}
