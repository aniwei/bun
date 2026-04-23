/**
 * bun-browser 预览 ServiceWorker 入口。
 *
 * 本文件由 Vite 单独构建为 `/bun-preview-sw.js`，
 * 挂载在 `/__bun_preview__/` scope 下，拦截预览请求并通过
 * MessageChannel 转发给 Kernel Worker（WASM Bun.serve handler）。
 *
 * 在应用中通过以下方式使用（推荐）：
 * ```ts
 * const wc = await WebContainer.boot({
 *   wasmModule,
 *   serviceWorker: { scriptUrl: "/bun-preview-sw.js" },
 * })
 * ```
 * 或手动注册：
 * ```ts
 * await kernel.attachServiceWorker({ scriptUrl: "/bun-preview-sw.js" })
 * ```
 */

// 导入触发 ServiceWorker 事件监听器的注册（install / activate / fetch / message）。
import "../src/service-worker"
