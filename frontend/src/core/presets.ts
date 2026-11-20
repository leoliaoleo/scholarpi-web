/**
 * Preset close-readings for the three bundled demo papers.
 *
 * A first-time visitor (empty IndexedDB) should land on a finished, chip-clickable
 * analysis instead of an empty chat. The seeded transcript is written through the
 * normal store, so the Agent afterwards continues from it like any other session —
 * and deleting it stays deleted (the kv marker is never cleared).
 */
import { getSettings } from "./config";
import { getModel } from "./llm";
import { getItem, paperKey, paperTitle, type PaperRef } from "./paper";
import { attentionPreset } from "../data/preset-attention";
import { bertPreset } from "../data/preset-bert";
import { resnetPreset } from "../data/preset-resnet";
import * as store from "./store";

export interface PresetTurn {
  q: string;
  a: string;
}

export interface Preset {
  /** arXiv id of the demo paper — the registry's `itemKey`. */
  itemKey: string;
  title: string;
  conclusion: string;
  turns: PresetTurn[];
}

const PRESETS: Preset[] = [attentionPreset, resnetPreset, bertPreset];

/** The one the welcome screen and the 限流 recovery both point at: zero model calls. */
export const EXAMPLE_ITEM_KEY = attentionPreset.itemKey;

export function presetFor(itemKey: string): Preset | null {
  return PRESETS.find((p) => p.itemKey === itemKey) || null;
}

const marker = (itemKey: string) => `presetSeeded:${itemKey}`;
const inflight = new Map<string, Promise<string | null>>();

/** pi-shaped messages: user text + assistant text blocks with provider metadata. */
function presetMessages(preset: Preset, startedAt: number): any[] {
  const model = getModel(getSettings().model);
  const out: any[] = [];
  preset.turns.forEach((turn, i) => {
    const askedAt = startedAt + i * 150_000;
    out.push({ role: "user", content: turn.q, timestamp: askedAt });
    const input = 1400 + i * 3200;
    const output = Math.max(160, Math.round(turn.a.length / 2.2));
    out.push({
      role: "assistant",
      content: [{ type: "text", text: turn.a }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseModel: model.id,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: askedAt + 60_000,
    });
  });
  return out;
}

/**
 * Seed this paper's preset session. Returns the new session id, or null when the
 * paper has no preset, was already seeded, or already has a session.
 */
export async function seedPreset(ref: PaperRef): Promise<string | null> {
  const preset = presetFor(ref.itemKey);
  if (!preset) return null;
  if (inflight.has(ref.itemKey)) return inflight.get(ref.itemKey)!;
  const job = doSeed(ref, preset).finally(() => inflight.delete(ref.itemKey));
  inflight.set(ref.itemKey, job);
  return job;
}

async function doSeed(ref: PaperRef, preset: Preset): Promise<string | null> {
  if (await store.kvGet(marker(preset.itemKey))) return null;
  if ((await store.listSessionsForPaper(ref.libraryID, ref.itemKey)).length) return null;
  await store.kvSet(marker(preset.itemKey), "1");

  const item = getItem(ref);
  const meta = await store.createSession({
    id: store.newSessionID(),
    libraryID: ref.libraryID,
    itemKey: ref.itemKey,
    paperTitle: item ? paperTitle(item) : "",
    title: preset.title,
    conclusion: preset.conclusion,
    model: getSettings().model,
  });
  const messages = presetMessages(preset, Date.now() - 8 * 60_000);
  await store.saveMessages(meta.id, messages, 0);
  await store.kvSet(`active:${paperKey(ref)}`, meta.id);
  return meta.id;
}
