import { normalizePath } from "@mars/vfs"

import type { MarsVFS } from "@mars/vfs"
import type { ViteConfigShape } from "./types"

export async function loadViteConfig(vfs: MarsVFS, root = "/workspace"): Promise<ViteConfigShape> {
  const configPath = normalizePath("vite.config.ts", root)
  const defaults = createDefaultViteConfig(root)
  if (!vfs.existsSync(configPath)) return defaults

  const source = String(await vfs.readFile(configPath, "utf8"))

  return {
    root: readStringProperty(source, "root") ?? defaults.root,
    define: readDefineMap(source),
    resolve: {
      alias: readAliasMap(source),
    },
    server: {
      hmr: !source.includes("hmr: false"),
    },
  }
}

export function createDefaultViteConfig(root = "/workspace"): ViteConfigShape {
  return {
    root,
    define: {},
    resolve: {
      alias: {},
    },
    server: {
      hmr: true,
    },
  }
}

function readStringProperty(source: string, property: string): string | null {
  const pattern = new RegExp(`${property}\\s*:\\s*["']([^"']+)["']`)
  return source.match(pattern)?.[1] ?? null
}

function readAliasMap(source: string): Record<string, string> {
  const aliasBlock = source.match(/alias\s*:\s*\{([^}]+)\}/s)?.[1]
  if (!aliasBlock) return {}

  const aliases: Record<string, string> = {}
  const aliasPattern = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g

  for (const match of aliasBlock.matchAll(aliasPattern)) {
    aliases[match[1]] = match[2]
  }

  return aliases
}

function readDefineMap(source: string): Record<string, string> {
  const defineBlock = source.match(/define\s*:\s*\{([^}]+)\}/s)?.[1]
  if (!defineBlock) return {}

  const defines: Record<string, string> = {}
  const definePattern = /["']?([A-Za-z_$][A-Za-z0-9_$.]*)["']?\s*:\s*([^,\n}]+)/g

  for (const match of defineBlock.matchAll(definePattern)) {
    defines[match[1]] = match[2].trim()
  }

  return defines
}