/**
 * 极简静态文件服务器，用于本地预览 demo/dist/。
 * 运行: bun demo/server.ts
 */

const DIST = import.meta.dir + "/dist";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css":  "text/css; charset=utf-8",
  ".map":  "application/json",
};

const PORT = Number(process.env.PORT ?? 4000);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    path = path.replace(/^\/+/, "");
    const file = Bun.file(DIST + "/" + path);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot) : "";
    const ct = MIME[ext] ?? "application/octet-stream";
    return new Response(file, {
        headers: {
          "Content-Type": ct,
          // Cross-Origin Isolation — required for SharedArrayBuffer / wasm-threads
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          // Allow DevTools and same-origin subresource loads under COEP require-corp
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
  },
});

console.log(`\n  bun-browser demo\n`);
console.log(`  http://localhost:${PORT}\n`);
