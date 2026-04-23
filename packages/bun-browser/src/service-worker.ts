/**
 * Bun Browser Preview ServiceWorker
 *
 * 职责：
 *   - 拦截 `${location.origin}/__bun_preview__/{port}/...` 请求，
 *     通过 MessageChannel 将请求转发到 Kernel Worker，
 *     等待 Response 再回灌给浏览器。
 *   - 可选地向预览响应注入 COOP/COEP 头以启用 SharedArrayBuffer。
 *
 * 运行环境：此文件由打包器单独产出为独立脚本（classic SW），应用通过
 * `Kernel.attachServiceWorker()` 或手动 `navigator.serviceWorker.register()` 注入。
 *
 * 推荐挂载作用域：`/__bun_preview__/`（仅拦截预览请求，不干扰主页路由）。
 *
 * 消息协议：
 *   控制端 → SW: `{ type: "registerKernel", port: MessagePort, opts?: SwKernelOpts }` 用 transferable
 *     SwKernelOpts: { injectIsolationHeaders?: boolean; fetchTimeoutMs?: number }
 *   SW → 控制端 (MessagePort 内): `{ type: "fetch", id, port, url, method, headers, body? }`
 *   控制端 → SW (MessagePort 内): `{ type: "fetch:response", id, status, statusText?, headers, body }`
 *     或 `{ type: "fetch:error", id, error }`
 *   控制端 → SW: `{ type: "unregisterKernel" }` 解除关联
 */

/// <reference lib="webworker" />

import { parsePreviewUrl } from './preview-router'

/** @internal 每次 registerKernel 时传入的可选配置。 */
interface SwKernelOpts {
  /** 向预览响应注入 COOP/COEP 头（默认 false）。 */
  injectIsolationHeaders?: boolean
  /** fetch 超时毫秒数；0 = 无超时（默认 30000）。 */
  fetchTimeoutMs?: number
  /**
   * T5.14.3 — 是否向 `text/html` 预览响应注入 iframe bridge 脚本。
   *
   * 该脚本允许 iframe 内容通过 `window.parent.postMessage` 将消息路由到外层 Kernel
   * 的 `on("preview-message")` listener，同时向 iframe 内部转发外层下发的消息。
   *
   * 仅当内容类型为 `text/html` 时才注入，非 HTML 响应不受影响。
   */
  injectBridgeScript?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self_ = globalThis as any as ServiceWorkerGlobalScope & {
  __bun_kernel_port?: MessagePort
  __bun_kernel_opts?: SwKernelOpts
  __bun_pending?: Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>
}

self_.__bun_pending ??= new Map()

self_.addEventListener('install', event => {
  // 安装后立刻激活，避免用户需要刷新一次。
  event.waitUntil(self_.skipWaiting())
})

self_.addEventListener('activate', event => {
  event.waitUntil(self_.clients.claim())
})

self_.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as
    | { type: 'registerKernel'; port: MessagePort; opts?: SwKernelOpts }
    | { type: 'unregisterKernel' }
    | undefined
  if (!data) return
  if (data.type === 'registerKernel' && data.port) {
    const port = data.port
    self_.__bun_kernel_port = port
    self_.__bun_kernel_opts = data.opts ?? {}
    port.onmessage = onKernelMessage
    port.start?.()
  } else if (data.type === 'unregisterKernel') {
    self_.__bun_kernel_port = undefined
    self_.__bun_kernel_opts = undefined
  }
})

self_.addEventListener('fetch', (event: FetchEvent) => {
  const parsed = parsePreviewUrl(event.request.url)
  if (!parsed) return // 非预览请求，放行
  event.respondWith(forwardToKernel(event.request, parsed.port, parsed.forwardUrl))
})

async function forwardToKernel(request: Request, port: number, forwardUrl: string): Promise<Response> {
  const kernelPort = self_.__bun_kernel_port
  if (!kernelPort) {
    return new Response(`bun-browser: kernel not registered (preview port ${port})`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const headers: Record<string, string> = {}
  request.headers.forEach((v, k) => {
    headers[k] = v
  })
  const method = request.method.toUpperCase()
  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await request.text()
    } catch {
      body = undefined
    }
  }

  const pending = self_.__bun_pending!
  const promise = new Promise<Response>((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
  const timeoutMs = self_.__bun_kernel_opts?.fetchTimeoutMs ?? 30_000
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          const entry = pending.get(id)
          if (entry) {
            pending.delete(id)
            entry.reject(new Error('kernel fetch timeout'))
          }
        }, timeoutMs)
      : undefined

  kernelPort.postMessage({
    type: 'fetch',
    id,
    port,
    url: forwardUrl,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  })

  try {
    return await promise
  } catch (e) {
    return new Response(`bun-browser: ${(e as Error).message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function onKernelMessage(event: MessageEvent): void {
  const msg = event.data as
    | {
        type: 'fetch:response'
        id: string
        status: number
        statusText?: string
        headers: Record<string, string>
        body: string
      }
    | { type: 'fetch:error'; id: string; error: string }
  if (!msg || typeof msg !== 'object') return
  const pending = self_.__bun_pending!.get(msg.id)
  if (!pending) return
  self_.__bun_pending!.delete(msg.id)
  if (msg.type === 'fetch:error') {
    pending.reject(new Error(msg.error || 'kernel fetch error'))
    return
  }
  if (msg.type === 'fetch:response') {
    const headers = new Headers(msg.headers || {})
    // 按配置决定是否注入 COOP/COEP（启用 SharedArrayBuffer / wasm-threads 时需要）
    if (self_.__bun_kernel_opts?.injectIsolationHeaders) {
      if (!headers.has('cross-origin-embedder-policy')) {
        headers.set('cross-origin-embedder-policy', 'require-corp')
      }
      if (!headers.has('cross-origin-opener-policy')) {
        headers.set('cross-origin-opener-policy', 'same-origin')
      }
    }
    pending.resolve(
      new Response(maybeInjectBridgeScript(msg.body, headers, self_.__bun_kernel_opts?.injectBridgeScript ?? false), {
        status: msg.status,
        ...(msg.statusText !== undefined ? { statusText: msg.statusText } : {}),
        headers,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// T5.14.3: Bridge script 内容注入优化
// ---------------------------------------------------------------------------

/**
 * 若当前响应为 `text/html` 且已开启 `injectBridgeScript`，
 * 将一段小型内联 `<script>` 插入到 `</head>` 或 `<body>` 标签前，
 * 使 iframe 内容能通过 postMessage 与外部 Kernel 双向通信。
 */
function maybeInjectBridgeScript(body: string, headers: Headers, inject: boolean): string {
  if (!inject) return body
  const ct = headers.get('content-type') ?? ''
  if (!ct.startsWith('text/html')) return body
  const script =
    '<script>(function(){' +
    'if(window.__bun_bridge__)return;' +
    'window.__bun_bridge__=true;' +
    // 通知外层 iframe 已就绪
    'window.parent&&window.parent!==window&&window.parent.postMessage({__bun_iframe_ready__:true,origin:location.href},"*");' +
    // 外层 → iframe: 转发 __bun_to_iframe__ 消息
    'window.addEventListener("message",function(e){' +
    'if(e.source===window.parent&&e.data&&e.data.__bun_to_iframe__)' +
    'window.dispatchEvent(new MessageEvent("message",{data:e.data.__bun_to_iframe__,origin:e.origin}));' +
    '});' +
    '})();<\/script>'
  const insertBefore = '</head>'
  const idx = body.indexOf(insertBefore)
  if (idx !== -1) return body.slice(0, idx) + script + body.slice(idx)
  // fallback: 在 </body> 前插入
  const bodyIdx = body.indexOf('</body>')
  if (bodyIdx !== -1) return body.slice(0, bodyIdx) + script + body.slice(bodyIdx)
  // 无标签时直接前置
  return script + body
}
