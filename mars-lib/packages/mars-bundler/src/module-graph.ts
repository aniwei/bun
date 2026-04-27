import type { ImportRecord } from "@mars/transpiler"
import type { ModuleGraphEntry } from "./types"

export class ModuleGraph {
  readonly #entries = new Map<string, ModuleGraphEntry>()

  updateModule(path: string, imports: ImportRecord[]): ModuleGraphEntry {
    const importedPaths = imports.map(record => record.path).sort()
    const entry = this.#entries.get(path) ?? {
      path,
      imports: [],
      importers: [],
      invalidated: false,
      transformedAt: 0,
    }

    entry.imports = importedPaths
    entry.invalidated = false
    entry.transformedAt = Date.now()
    this.#entries.set(path, entry)

    for (const importedPath of importedPaths) {
      const importedEntry = this.#entries.get(importedPath) ?? {
        path: importedPath,
        imports: [],
        importers: [],
        invalidated: false,
        transformedAt: 0,
      }
      if (!importedEntry.importers.includes(path)) importedEntry.importers.push(path)
      importedEntry.importers.sort()
      this.#entries.set(importedPath, importedEntry)
    }

    return { ...entry, imports: [...entry.imports], importers: [...entry.importers] }
  }

  invalidate(path: string): ModuleGraphEntry[] {
    const invalidated: ModuleGraphEntry[] = []
    const queue = [path]
    const seen = new Set<string>()

    while (queue.length) {
      const currentPath = queue.shift() ?? ""
      if (seen.has(currentPath)) continue
      seen.add(currentPath)

      const entry = this.#entries.get(currentPath)
      if (!entry) continue

      entry.invalidated = true
      invalidated.push({ ...entry, imports: [...entry.imports], importers: [...entry.importers] })
      queue.push(...entry.importers)
    }

    return invalidated
  }

  get(path: string): ModuleGraphEntry | null {
    const entry = this.#entries.get(path)
    return entry ? { ...entry, imports: [...entry.imports], importers: [...entry.importers] } : null
  }
}

export function createModuleGraph(): ModuleGraph {
  return new ModuleGraph()
}