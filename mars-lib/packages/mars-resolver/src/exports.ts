export type ExportsField =
  | string
  | Record<string, string | Record<string, string | undefined> | undefined>
  | undefined

export function resolveExports(
  exportsField: ExportsField,
  subpath: string,
  conditions: string[],
): string | null {
  if (!exportsField) return null
  if (typeof exportsField === "string") return subpath === "." ? exportsField : null

  const direct = exportsField[subpath]
  if (direct) return resolveConditionalTarget(direct, conditions)

  return resolvePatternTarget(exportsField, subpath, conditions)
}

export function resolveImports(
  importsField: Record<string, string | Record<string, string | undefined>> | undefined,
  specifier: string,
  conditions: string[],
): string | null {
  if (!importsField) return null

  const entry = importsField[specifier]
  if (entry) return resolveConditionalTarget(entry, conditions)

  return resolvePatternTarget(importsField, specifier, conditions)
}

type ConditionalTarget = string | Record<string, string | undefined> | undefined

function resolveConditionalTarget(
  target: ConditionalTarget,
  conditions: string[],
): string | null {
  if (!target) return null
  if (typeof target === "string") return target

  for (const condition of conditions) {
    const value = target[condition]
    if (typeof value === "string") return value
  }

  return typeof target.default === "string" ? target.default : null
}

function resolvePatternTarget(
  entries: Record<string, ConditionalTarget>,
  subpath: string,
  conditions: string[],
): string | null {
  const patternEntries = Object.entries(entries)
    .filter(([pattern]) => pattern.includes("*"))
    .sort(([left], [right]) => patternPrefixLength(right) - patternPrefixLength(left))

  for (const [pattern, target] of patternEntries) {
    const wildcardValue = matchPattern(pattern, subpath)
    if (wildcardValue === null) continue

    const resolvedTarget = resolveConditionalTarget(target, conditions)
    if (!resolvedTarget) continue

    return resolvedTarget.replace("*", wildcardValue)
  }

  return null
}

function matchPattern(pattern: string, value: string): string | null {
  const wildcardIndex = pattern.indexOf("*")
  const prefix = pattern.slice(0, wildcardIndex)
  const suffix = pattern.slice(wildcardIndex + 1)

  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null

  return value.slice(prefix.length, value.length - suffix.length)
}

function patternPrefixLength(pattern: string): number {
  const wildcardIndex = pattern.indexOf("*")
  return wildcardIndex < 0 ? pattern.length : wildcardIndex
}
