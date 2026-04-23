import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { resolve } from "path";
import type { Plugin } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** 为 dev server 和 preview server 注入 COEP/COOP 响应头（SharedArrayBuffer 必需）。 */
function crossOriginIsolationPlugin(): Plugin {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        next();
      });
    },
  };
}

/**
 * 开发时将 `bun-preview-sw.ts` 按需打包后以 `/bun-preview-sw.js` 提供。
 *
 * - dev  : 首次请求时用 esbuild bundle（后续缓存），文件变动时自动失效。
 * - build: 由 rollupOptions.input 单独产出固定名称 chunk。
 */
function serviceWorkerPlugin(): Plugin {
  let cached: string | null = null;

  return {
    name: "bun-preview-sw",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/bun-preview-sw.js") { next(); return; }

        if (!cached) {
          // esbuild 是 Vite 的直接依赖，无需额外安装
          const esbuild = await import("esbuild");
          const result = await esbuild.build({
            entryPoints: [resolve(__dirname, "bun-preview-sw.ts")],
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            target: "chrome90",
          });
          cached = result.outputFiles[0]?.text ?? "";
        }

        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(cached);
      });

      // 当 SW 相关源文件变动时清除缓存，下次请求时重新构建
      server.watcher.on("change", (file) => {
        if (file.includes("service-worker") || file.includes("preview-router")) {
          cached = null;
        }
      });
    },
  };
}

export default defineConfig({
  root: ".",
  plugins: [react(), crossOriginIsolationPlugin(), serviceWorkerPlugin()],

  // 让 Vite 把 .wasm 当作 binary asset 处理
  assetsInclude: ["**/*.wasm"],

  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        // ServiceWorker 独立 chunk，输出为固定名称 /bun-preview-sw.js
        "bun-preview-sw": resolve(__dirname, "bun-preview-sw.ts"),
      },
      output: {
        // SW 使用固定名称；其余 entry 和 chunk 保持哈希
        entryFileNames: (chunk) =>
          chunk.name === "bun-preview-sw" ? "[name].js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },

  server: {
    port: 4000,
  },

  preview: {
    port: 4000,
  },
});
