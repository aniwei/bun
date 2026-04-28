export type ExportsField =
  | string
  | null
  | ConditionalTarget[]
  | Record<string, ConditionalTarget>
  | undefined

export function resolveExports(
  exportsField: ExportsField,
  subpath: string,
  conditions: string[],
): string | null {
  return resolveExportsTarget(exportsField, subpath, conditions) ?? null
}

export function resolveExportsTarget(
  exportsField: ExportsField,
  subpath: string,
  conditions: string[],
): ResolvedTarget {
  if (exportsField === undefined) return undefined
  if (exportsField === null) return null
  if (typeof exportsField === "string") return subpath === "." ? exportsField : undefined
  if (Array.isArray(exportsField)) return subpath === "." ? resolveConditionalTarget(exportsField, conditions) : undefined

  if (subpath === "." && isConditionalExportsObject(exportsField)) {
    return resolveConditionalTarget(exportsField, conditions)
  }

  if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
    return resolveConditionalTarget(exportsField[subpath], conditions)
  }

  return resolvePatternTarget(exportsField, subpath, conditions)
}

export function hasExports(exportsField: ExportsField): boolean {
  return exportsField !== undefined
}

export function blocksSubpathFallback(exportsField: ExportsField, subpath: string): boolean {
  return subpath !== "." && hasExports(exportsField)
}

export function resolveImports(
  importsField: Record<string, ConditionalTarget> | undefined,
  specifier: string,
  conditions: string[],
): string | null {
  if (!importsField) return null

  if (Object.prototype.hasOwnProperty.call(importsField, specifier)) {
    return resolveConditionalTarget(importsField[specifier], conditions) ?? null
  }

  return resolvePatternTarget(importsField, specifier, conditions) ?? null
}

interface ConditionalTargetObject {
  [key: string]: ConditionalTarget
}
type ConditionalTarget = string | null | ConditionalTarget[] | ConditionalTargetObject | undefined
type ResolvedTarget = string | null | undefined

function resolveConditionalTarget(
  target: ConditionalTarget,
  conditions: string[],
): ResolvedTarget {
  if (target === undefined) return undefined
  if (target === null) return null
  if (typeof target === "string") return target
  if (Array.isArray(target)) return resolveFallbackTargets(target, conditions)

  for (const condition of conditions) {
    if (!Object.prototype.hasOwnProperty.call(target, condition)) continue
    const value = resolveConditionalTarget(target[condition], conditions)
    if (value !== undefined) return value
  }

  if (!Object.prototype.hasOwnProperty.call(target, "default")) return undefined
  return resolveConditionalTarget(target.default, conditions) ?? null
}

function resolveFallbackTargets(
  targets: ConditionalTarget[],
  conditions: string[],
): ResolvedTarget {
  for (const target of targets) {
    const resolvedTarget = resolveConditionalTarget(target, conditions)
    if (resolvedTarget === undefined) continue

    return resolvedTarget
  }

  return undefined
}

function resolvePatternTarget(
  entries: Record<string, ConditionalTarget>,
  subpath: string,
  conditions: string[],
): ResolvedTarget {
  const patternEntries = Object.entries(entries)
    .filter(([pattern]) => pattern.includes("*"))
    .sort(([left], [right]) => patternPrefixLength(right) - patternPrefixLength(left))

  for (const [pattern, target] of patternEntries) {
    const wildcardValue = matchPattern(pattern, subpath)
    if (wildcardValue === null) continue

    const resolvedTarget = resolveConditionalTarget(target, conditions)
    if (resolvedTarget === null) return null
    if (resolvedTarget === undefined) continue

    return resolvedTarget.replace("*", wildcardValue)
  }

  return undefined
}

function isConditionalExportsObject(entries: Record<string, ConditionalTarget>): boolean {
  return Object.keys(entries).every(key => !key.startsWith("."))
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
