/**
 * Frontend build: bundle the Preact workbench with esbuild and copy the
 * browser-side vendor assets (pdf.js worker, KaTeX, Mermaid) next to it.
 *
 *   node build.mjs           production bundle
 *   node build.mjs --dev     unminified + sourcemaps
 *   node build.mjs --dev --watch
 */
import { build, context } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "frontend");
const OUT = join(SRC, "dist");
const NM = join(ROOT, "node_modules");
const dev = process.argv.includes("--dev");
const watch = process.argv.includes("--watch");

async function copy(src, dest) {
  if (!existsSync(src)) throw new Error(`missing vendor asset: ${src}`);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

async function vendor() {
  await mkdir(join(OUT, "vendor/katex"), { recursive: true });
  await copyFile(join(NM, "pdfjs-dist/build/pdf.worker.min.mjs"), join(OUT, "vendor/pdf.worker.min.mjs"));
  await copyFile(join(NM, "mermaid/dist/mermaid.min.js"), join(OUT, "vendor/mermaid.min.js"));
  await copyFile(join(NM, "katex/dist/katex.min.css"), join(OUT, "vendor/katex/katex.min.css"));
  await copy(join(NM, "katex/dist/fonts"), join(OUT, "vendor/katex/fonts"));
}

/**
 * The bundled demo papers ship as static files (manifest + per-page text index +
 * PDF), so a published site needs no server to open them.
 */
async function papers() {
  const src = join(ROOT, "backend", "data", "demo_papers");
  if (!existsSync(src)) throw new Error(`missing demo papers: ${src}`);
  await copy(src, join(OUT, "papers"));
}

/** Stamp the bundle hash into index.html: rebuilt assets keep the same URL, so
 *  without this a browser (or a CDN) can serve yesterday's main.js. */
async function stamp() {
  const html = join(OUT, "index.html");
  let doc = await readFile(html, "utf8");
  for (const file of ["assets/main.js", "assets/styles/app.css"]) {
    let buf;
    try {
      buf = await readFile(join(OUT, file));
    } catch {
      continue;
    }
    const v = createHash("sha256").update(buf).digest("hex").slice(0, 10);
    doc = doc.split(`/${file}"`).join(`/${file}?v=${v}"`);
  }
  await writeFile(html, doc);
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "assets"), { recursive: true });
  await vendor();
  await papers();

  const options = {
    absWorkingDir: ROOT,
    entryPoints: ["frontend/src/main.tsx", "frontend/src/styles/app.css"],
    outdir: "frontend/dist/assets",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    sourcemap: dev,
    minify: !dev,
    logLevel: "info",
    define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
    loader: { ".png": "dataurl", ".svg": "text" },
  };
  if (watch) {
    await copyFile(join(SRC, "index.html"), join(OUT, "index.html"));
    const ctx = await context(options);
    await ctx.watch();
    console.log("[build] watching frontend/src …");
  } else {
    await build(options);
    await copyFile(join(SRC, "index.html"), join(OUT, "index.html"));
    await stamp();
    console.log(`[build] -> ${resolve(OUT)}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
