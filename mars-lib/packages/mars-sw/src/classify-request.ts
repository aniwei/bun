export type RequestKind = "virtual-server" | "vfs-asset" | "module" | "websocket" | "external"

export function classifyRequest(url: URL): RequestKind {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (url.hostname.endsWith(".mars.localhost") || url.hostname === "mars.localhost") {
      return "websocket"
    }
    return "external"
  }

  if (url.hostname.endsWith(".mars.localhost") || url.hostname === "mars.localhost") {
    return "virtual-server"
  }

  if (url.pathname.startsWith("/__mars__/vfs/")) return "vfs-asset"

  if (url.pathname.startsWith("/__mars__/module")) return "module"

  if (url.pathname.startsWith("/@vite/")) return "external"

  if (url.pathname.includes("/node_modules/") || isSourceModulePath(url.pathname)) {
    return "module"
  }

  return "external"
}

function isSourceModulePath(pathname: string): boolean {
  if (!/^\/(src|app|pages|components|core-modules)\//.test(pathname)) return false

  return /\.(mjs|js|jsx|mts|ts|tsx)$/.test(pathname)
}