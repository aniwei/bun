/**
 * 打包 demo 到 demo/dist/ 目录，生成可直接在浏览器中打开的静态文件。
 *
 * 用法: bun run build:demo
 */

import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const DEMO_DIR = join(ROOT, "demo");
const DIST_DIR = join(DEMO_DIR, "dist");

await mkdir(DIST_DIR, { recursive: true });

// 1. Bundle main.ts → dist/main.js
console.log("⏳ Bundling demo/main.ts …");
const result = await Bun.build({
  entrypoints: [join(DEMO_DIR, "main.ts")],
  outdir: DIST_DIR,
  target: "browser",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}

// 2. Copy bun-core.wasm
console.log("📦 Copying bun-core.wasm …");
await copyFile(join(ROOT, "bun-core.wasm"), join(DIST_DIR, "bun-core.wasm"));

// 3. Patch index.html: rewrite script src + wasm path reference to relative dist paths
console.log("📝 Generating dist/index.html …");
const html = await readFile(join(DEMO_DIR, "index.html"), "utf-8");
const distHtml = html.replace(
  '<script type="module" src="./main.ts"></script>',
  '<script type="module" src="./main.js"></script>',
);
await writeFile(join(DIST_DIR, "index.html"), distHtml);

const wasmSize = (await Bun.file(join(DIST_DIR, "bun-core.wasm")).arrayBuffer()).byteLength;
const jsSize = (await Bun.file(join(DIST_DIR, "main.js")).arrayBuffer()).byteLength;
console.log(`\n✅ Demo built to demo/dist/`);
console.log(`   bun-core.wasm  ${(wasmSize / 1024).toFixed(1)} KB`);
console.log(`   main.js        ${(jsSize / 1024).toFixed(1)} KB`);
console.log(`\n   Open: bun --hot demo/dist/index.html`);
console.log(`   Or:   npx serve demo/dist`);
