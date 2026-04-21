/**
 * 打包 demo 到 demo/dist/ 目录，生成可直接在浏览器中打开的静态文件。
 *
 * 用法: bun run build:demo
 */

const ROOT = new URL("..", import.meta.url).pathname;
const DEMO_DIR = ROOT + "demo";
const DIST_DIR = DEMO_DIR + "/dist";

await Bun.$`mkdir -p ${DIST_DIR}`;

// 1. Bundle main.ts → dist/main.js
console.log("⏳ Bundling demo/main.ts …");
const result = await Bun.build({
  entrypoints: [DEMO_DIR + "/main.ts"],
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
await Bun.write(DIST_DIR + "/bun-core.wasm", Bun.file(ROOT + "bun-core.wasm"));

// 3. Patch index.html: rewrite script src to point at compiled .js
console.log("📝 Generating dist/index.html …");
const html = await Bun.file(DEMO_DIR + "/index.html").text();
const distHtml = html.replace(
  '<script type="module" src="./main.ts"></script>',
  '<script type="module" src="./main.js"></script>',
);
await Bun.write(DIST_DIR + "/index.html", distHtml);

const wasmSize = (await Bun.file(DIST_DIR + "/bun-core.wasm").arrayBuffer()).byteLength;
const jsSize   = (await Bun.file(DIST_DIR + "/main.js").arrayBuffer()).byteLength;
console.log(`\n✅ Demo built to demo/dist/`);
console.log(`   bun-core.wasm  ${(wasmSize / 1024).toFixed(1)} KB`);
console.log(`   main.js        ${(jsSize / 1024).toFixed(1)} KB`);
console.log(`\n   Run: bun demo/server.ts`);

