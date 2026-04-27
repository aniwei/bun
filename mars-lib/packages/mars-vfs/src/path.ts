export const defaultWorkspaceRoot = "/workspace"

export function normalizePath(path: string | URL, cwd = defaultWorkspaceRoot): string {
  const rawPath = path instanceof URL ? path.pathname : path
  const normalizedInput = rawPath.replaceAll("\\", "/")
  const absoluteInput = normalizedInput.startsWith("/")
    ? normalizedInput
    : `${cwd}/${normalizedInput}`
  const parts: string[] = []

  for (const part of absoluteInput.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }

    parts.push(part)
  }

  return `/${parts.join("/")}`
}

export function joinPath(...paths: string[]): string {
  if (!paths.length) return "/"

  const [firstPath, ...restPaths] = paths
  return normalizePath(restPaths.join("/"), normalizePath(firstPath || "/"))
}

export function dirname(path: string): string {
  const normalizedPath = normalizePath(path)
  if (normalizedPath === "/") return "/"

  const parts = normalizedPath.split("/")
  parts.pop()

  return parts.join("/") || "/"
}

export function basename(path: string): string {
  const normalizedPath = normalizePath(path)
  if (normalizedPath === "/") return "/"

  const parts = normalizedPath.split("/")
  return parts.at(-1) ?? ""
}

export function resolvePath(cwd: string, path: string | URL): string {
  return normalizePath(path, cwd)
}