/**
 * bun-web-resolver: tsconfig-paths.ts
 *
 * Resolves TypeScript `paths` / `baseUrl` mappings.
 * Compatible with tsconfig.json `compilerOptions.paths` and `compilerOptions.baseUrl`.
 */

export interface TsconfigPaths {
  /** tsconfig `compilerOptions.paths` — pattern → array of replacement templates */
  paths?: Record<string, string[]>
  /** tsconfig `compilerOptions.baseUrl` — absolute base directory */
  baseUrl?: string
}

// POSIX path helpers (duplicated locally to avoid cross-file import)
function posixJoin(...parts: string[]): string {
  return posixNormalize(parts.join('/'))
}

function posixNormalize(p: string): string {
  const abs = p.startsWith('/')
  const segments = p.split('/').filter(Boolean)
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop()
    } else if (seg !== '.') {
      resolved.push(seg)
    }
  }
  return (abs ? '/' : '') + resolved.join('/') || '/'
}

export interface TsconfigPathResolver {
  /**
   * Attempt to resolve `specifier` using configured `paths` / `baseUrl`.
   * Returns one or more candidate absolute paths to try, or an empty array if
   * none of the configured patterns match.
   */
  resolve(specifier: string): string[]
}

/**
 * Create a resolver from tsconfig `paths` / `baseUrl` configuration.
 *
 * @param config - The tsconfig paths / baseUrl settings
 * @returns A resolver whose `resolve()` returns candidate paths (not verified for existence)
 */
export function createTsconfigPathResolver(config: TsconfigPaths): TsconfigPathResolver {
  const { paths = {}, baseUrl } = config

  return {
    resolve(specifier: string): string[] {
      // Skip relative / absolute specifiers — they don't use path mappings
      if (
        specifier.startsWith('/') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../')
      ) {
        return []
      }

      const candidates: string[] = []

      // 1. Try `paths` patterns (exact match before wildcard)
      // Collect exact matches first for priority
      const exactPaths = paths[specifier]
      if (exactPaths) {
        for (const template of exactPaths) {
          const resolved = baseUrl ? posixJoin(baseUrl, template) : template
          candidates.push(resolved)
        }
        return candidates
      }

      // Pattern match with '*'
      for (const [pattern, templates] of Object.entries(paths)) {
        if (!pattern.includes('*')) continue
        const starIdx = pattern.indexOf('*')
        const prefix = pattern.slice(0, starIdx)
        const suffix = pattern.slice(starIdx + 1)

        if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
          const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
          for (const template of templates) {
            const replaced = template.replace(/\*/g, captured)
            const resolved = baseUrl ? posixJoin(baseUrl, replaced) : replaced
            candidates.push(resolved)
          }
        }
      }

      if (candidates.length > 0) return candidates

      // 2. Try baseUrl resolution (bare specifiers)
      if (baseUrl) {
        candidates.push(posixJoin(baseUrl, specifier))
      }

      return candidates
    },
  }
}
