export type RequestKind = "virtual-server" | "vfs-asset" | "module" | "external"

export function classifyRequest(url: URL): RequestKind {
  if (url.hostname.endsWith(".mars.localhost") || url.hostname === "mars.localhost") {
    return "virtual-server"
  }

  if (url.pathname.startsWith("/__mars__/vfs/")) return "vfs-asset"

  if (url.pathname.startsWith("/@vite/") || url.pathname.includes("/node_modules/")) {
    return "module"
  }

  return "external"
}