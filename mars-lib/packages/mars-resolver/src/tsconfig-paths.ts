import { normalizePath } from "@mars/vfs"

import type { TsconfigPathResolver, TsconfigPaths } from "./types"

class DefaultTsconfigPathResolver implements TsconfigPathResolver {
  readonly #baseUrl: string
  readonly #paths: Record<string, string[]>

  constructor(configuration: TsconfigPaths) {
    this.#baseUrl = configuration.baseUrl ?? "/workspace"
    this.#paths = configuration.paths ?? {}
  }

  resolve(specifier: string): string[] {
    const matches: string[] = []

    for (const [pattern, replacements] of Object.entries(this.#paths)) {
      const wildcardIndex = pattern.indexOf("*")

      if (wildcardIndex < 0) {
        if (pattern !== specifier) continue
        for (const replacement of replacements) {
          matches.push(normalizePath(replacement, this.#baseUrl))
        }
        continue
      }

      const prefix = pattern.slice(0, wildcardIndex)
      const suffix = pattern.slice(wildcardIndex + 1)
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue

      const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length)
      for (const replacement of replacements) {
        matches.push(normalizePath(replacement.replace("*", wildcardValue), this.#baseUrl))
      }
    }

    return matches
  }
}

export function createTsconfigPathResolver(configuration: TsconfigPaths): TsconfigPathResolver {
  return new DefaultTsconfigPathResolver(configuration)
}
