/**
 * Browser entry: warm the local store, pull the paper registry, then mount the
 * workbench. Everything after this is ordinary Preact.
 */
import { render } from "preact";
import { loadRegistry } from "./core/paper";
import { openStore } from "./core/store";
import { App } from "./web/app";

const host = document.getElementById("app");

async function boot(): Promise<void> {
  if (!host) return;
  try {
    await openStore();
  } catch (e: any) {
    host.innerHTML = `<div class="boot-error"><h1>无法打开本地数据库</h1><p>${String(
      e?.message || e,
    )}</p><p class="muted">ScholarPi 的会话、批注与上传的 PDF 都存在浏览器 IndexedDB 里；若刚在本浏览器的其他标签页打开过应用，请关闭后刷新。</p></div>`;
    return;
  }
  // pull the catalogue before the first paint, so the rail never flashes empty
  await loadRegistry().catch((e) => console.warn("[ScholarPi] 演示论文加载失败（后端未启动？）", e));
  render(<App />, host);
}

void boot();
