/**
 * WebSocket route handler for the Service Worker.
 *
 * Native browser WebSocket connections bypass Service Worker fetch events, so
 * Mars-lib uses an in-process MessageChannel WebSocket pair that is created
 * server-side when Bun.serve's websocket handler calls server.upgrade(request).
 *
 * The ServiceWorkerRouter classifies ws://mars.localhost URLs as "websocket"
 * and returns a 426 Upgrade Required with diagnostic headers so that callers
 * know to fall back to the in-process MarsClientWebSocket channel instead of a
 * native WebSocket upgrade.
 */

export interface WebSocketRouteInfo {
  url: URL
  request: Request
}

/**
 * Returns a 426 Upgrade Required response for a classified ws:// request.
 * Callers should use MarsClientWebSocket (from @mars/runtime) which communicates
 * via the kernel's in-process MessageChannel pair instead of a native upgrade.
 */
export function handleWebSocketRoute(info: WebSocketRouteInfo): Response {
  return new Response(
    [
      "WebSocket upgrade is handled in-process by MarsClientWebSocket.",
      "Use the WebSocket class provided by the Mars runtime instead of a native ws:// URL.",
    ].join(" "),
    {
      status: 426,
      headers: {
        "upgrade": "websocket",
        "x-mars-ws-port": info.url.port || "80",
        "x-mars-ws-pathname": info.url.pathname,
      },
    },
  )
}
