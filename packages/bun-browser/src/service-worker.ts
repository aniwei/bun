/**
 * Bun Browser Preview ServiceWorker —— Phase 3 T3.1
 *
 * 职责：
 *   - 拦截 `${location.origin}/__bun_preview__/{port}/...` 请求，
 *     通过 MessageChannel 将请求转发到 Kernel Worker，
 *     等待 Response 再回灌给浏览器。
 *   - 响应注入 COOP/COEP 头以启用 SharedArrayBuffer（可选）。
 *
 * 运行环境：此文件由打包器单独产出为 `bun-preview-sw.js`，必须在应用
 * 注册 SDK 前以 `navigator.serviceWorker.register()` 注入。
 *
 * 消息协议：
 *   控制端 → SW: `{ type: "registerKernel", port: MessagePort }` 用 transferable
 *   SW → 控制端 (MessagePort 内): `{ type: "fetch", id, port, url, method, headers, body }`
 *   控制端 → SW (MessagePort 内): `{ type: "fetch:response", id, status, statusText, headers, body }`
 *     或 `{ type: "fetch:error", id, error }`
 */

/// <reference lib="webworker" />

import { parsePreviewUrl } from './preview-router'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self_ = globalThis as any as ServiceWorkerGlobalScope & {
  __bun_kernel_port?: MessagePort
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
  const data = event.data as { type: 'registerKernel'; port: MessagePort } | { type: 'unregisterKernel' } | undefined
  if (!data) return
  if (data.type === 'registerKernel' && data.port) {
    const port = data.port
    self_.__bun_kernel_port = port
    port.onmessage = onKernelMessage
    port.start?.()
  } else if (data.type === 'unregisterKernel') {
    self_.__bun_kernel_port = undefined
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
  const timeout = setTimeout(() => {
    const entry = pending.get(id)
    if (entry) {
      pending.delete(id)
      entry.reject(new Error('kernel fetch timeout'))
    }
  }, 30_000)

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
    clearTimeout(timeout)
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
    // 注入 COOP/COEP（可选：允许 SharedArrayBuffer）
    if (!headers.has('cross-origin-embedder-policy')) {
      headers.set('cross-origin-embedder-policy', 'require-corp')
    }
    if (!headers.has('cross-origin-opener-policy')) {
      headers.set('cross-origin-opener-policy', 'same-origin')
    }
    pending.resolve(
      new Response(msg.body, {
        status: msg.status,
        ...(msg.statusText !== undefined ? { statusText: msg.statusText } : {}),
        headers,
      }),
    )
  }
}
