interface ParsedVersion {
  raw: string
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

interface VersionBounds {
  lower?: ParsedVersion
  lowerInclusive?: boolean
  upper?: ParsedVersion
  upperInclusive?: boolean
  exact?: ParsedVersion
}

export function pickPackageVersion(
  distTags: Record<string, string> | undefined,
  versions: string[],
  range: string,
): string {
  const requestedRange = normalizeWorkspaceRange(range.trim())
  if (requestedRange in (distTags ?? {})) return distTags?.[requestedRange] ?? requestedRange
  if (versions.includes(requestedRange)) return requestedRange

  const parsedVersions = versions
    .map(parseVersion)
    .filter(version => version !== null)

  const matchingVersion = parsedVersions
    .filter(version => satisfiesRange(version, requestedRange))
    .sort(compareParsedVersions)
    .at(-1)

  if (matchingVersion) return matchingVersion.raw

  throw new Error(`No package version satisfies range: ${requestedRange || "*"}`)
}

export function packageVersionSatisfies(version: string, range: string): boolean {
  const requestedRange = normalizeWorkspaceRange(range.trim())
  if (!requestedRange || requestedRange === "latest") return true

  try {
    return pickPackageVersion(undefined, [version], requestedRange) === version
  } catch {
    return false
  }
}

function normalizeWorkspaceRange(range: string): string {
  if (!range.startsWith("workspace:")) return range

  const workspaceRange = range.slice("workspace:".length).trim()
  if (!workspaceRange || workspaceRange === "^" || workspaceRange === "~") return "*"

  return workspaceRange
}

function satisfiesRange(version: ParsedVersion, range: string): boolean {
  if (!range || range === "*" || range.toLowerCase() === "x") return true

  return range
    .split(/\s*\|\|\s*/)
    .some(rangePart => satisfiesRangePart(version, rangePart.trim()))
}

function satisfiesRangePart(version: ParsedVersion, range: string): boolean {
  const bounds = parseRangePartBounds(range)

  if (bounds.length === 0) return true
  if (bounds.some(bound => bound === null)) return false
  if (!prereleaseIsAllowed(version, bounds)) return false

  return bounds.every(bound => satisfiesBounds(version, bound!))
}

function parseRangePartBounds(range: string): Array<VersionBounds | null> {
  const hyphenBounds = parseHyphenRange(range)
  if (hyphenBounds) return hyphenBounds

  return normalizeComparatorTokens(
    range
    .replaceAll(",", " ")
    .split(/\s+/)
    .filter(Boolean),
  )
    .map(parseRangeToken)
}

function normalizeComparatorTokens(tokens: string[]): string[] {
  const normalized: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (/^(<=|>=|<|>|=)$/.test(token) && tokens[index + 1]) {
      normalized.push(`${token}${tokens[index + 1]}`)
      index += 1
      continue
    }

    normalized.push(token)
  }

  return normalized
}

function parseHyphenRange(range: string): Array<VersionBounds | null> | null {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(range)
  if (!match) return null

  return [
    createComparatorBounds(">=", match[1]),
    createHyphenUpperBound(match[2]),
  ]
}

function parseRangeToken(token: string): VersionBounds | null {
  if (token === "*" || token.toLowerCase() === "x") return {}
  if (token.startsWith("^")) return createCaretBounds(token.slice(1))
  if (token.startsWith("~")) return createTildeBounds(token.slice(1))

  const comparatorMatch = /^(<=|>=|<|>|=)?(.+)$/.exec(token)
  if (!comparatorMatch) return null

  const operator = comparatorMatch[1] ?? "="
  const versionPattern = comparatorMatch[2]
  if (operator === "=") return createPartialVersionBounds(versionPattern)

  return createComparatorBounds(operator, versionPattern)
}

function createComparatorBounds(operator: string, pattern: string): VersionBounds | null {
  const version = parseVersion(pattern)
  if (version) {
    if (operator === ">") return { lower: version, lowerInclusive: false }
    if (operator === ">=") return { lower: version, lowerInclusive: true }
    if (operator === "<") return { upper: version, upperInclusive: false }
    if (operator === "<=") return { upper: version, upperInclusive: true }
  }

  const partial = parsePartialVersionParts(pattern)
  if (!partial) return null
  const { major, minor, patch } = partial
  if (major === "wildcard") return {}

  if (operator === ">=") {
    return {
      lower: createVersion(major, minor === "wildcard" ? 0 : minor, patch === "wildcard" ? 0 : patch),
      lowerInclusive: true,
    }
  }

  if (operator === ">") {
    if (minor === "wildcard") return { lower: createVersion(major + 1, 0, 0), lowerInclusive: true }
    if (patch === "wildcard") return { lower: createVersion(major, minor + 1, 0), lowerInclusive: true }
    return { lower: createVersion(major, minor, patch), lowerInclusive: false }
  }

  if (operator === "<") {
    return {
      upper: createVersion(major, minor === "wildcard" ? 0 : minor, patch === "wildcard" ? 0 : patch),
      upperInclusive: false,
    }
  }

  if (operator === "<=") return createHyphenUpperBound(pattern)

  return null
}

function createHyphenUpperBound(pattern: string): VersionBounds | null {
  const version = parseVersion(pattern)
  if (version) return { upper: version, upperInclusive: true }

  const partial = parsePartialVersionParts(pattern)
  if (!partial) return null
  const { major, minor, patch } = partial
  if (major === "wildcard") return {}
  if (minor === "wildcard") return { upper: createVersion(major + 1, 0, 0), upperInclusive: false }
  if (patch === "wildcard") return { upper: createVersion(major, minor + 1, 0), upperInclusive: false }

  return { upper: createVersion(major, minor, patch), upperInclusive: true }
}

function createPartialVersionBounds(pattern: string): VersionBounds | null {
  const exactVersion = parseVersion(pattern)
  if (exactVersion) return { exact: exactVersion }

  const partial = parsePartialVersionParts(pattern)
  if (!partial) return null
  const { major, minor, patch } = partial

  if (major === "wildcard") return {}

  if (minor === "wildcard") {
    return {
      lower: createVersion(major, 0, 0),
      lowerInclusive: true,
      upper: createVersion(major + 1, 0, 0),
      upperInclusive: false,
    }
  }

  if (patch === "wildcard") {
    return {
      lower: createVersion(major, minor, 0),
      lowerInclusive: true,
      upper: createVersion(major, minor + 1, 0),
      upperInclusive: false,
    }
  }

  return null
}

function parsePartialVersionParts(pattern: string): {
  major: number | "wildcard"
  minor: number | "wildcard"
  patch: number | "wildcard"
} | null {
  const parts = pattern.replace(/^v/i, "").split(".")
  if (parts.length > 3) return null

  const major = parseVersionPart(parts[0])
  const minor = parseVersionPart(parts[1])
  const patch = parseVersionPart(parts[2])
  if (major === null || minor === null || patch === null) return null

  return { major, minor, patch }
}

function createCaretBounds(pattern: string): VersionBounds | null {
  const lower = parseVersion(pattern)
  if (lower) {
    const upper = lower.major > 0
      ? createVersion(lower.major + 1, 0, 0)
      : lower.minor > 0
        ? createVersion(0, lower.minor + 1, 0)
        : createVersion(0, 0, lower.patch + 1)

    return {
      lower,
      lowerInclusive: true,
      upper,
      upperInclusive: false,
    }
  }

  const partial = parsePartialVersionParts(pattern)
  if (!partial || partial.major === "wildcard") return null

  const lowerFromPartial = createVersion(
    partial.major,
    partial.minor === "wildcard" ? 0 : partial.minor,
    partial.patch === "wildcard" ? 0 : partial.patch,
  )
  const upper = partial.major > 0
    ? createVersion(partial.major + 1, 0, 0)
    : partial.minor === "wildcard"
      ? createVersion(1, 0, 0)
      : partial.minor > 0
        ? createVersion(0, partial.minor + 1, 0)
        : partial.patch === "wildcard"
          ? createVersion(0, 1, 0)
          : createVersion(0, 0, partial.patch + 1)

  return {
    lower: lowerFromPartial,
    lowerInclusive: true,
    upper,
    upperInclusive: false,
  }
}

function createTildeBounds(pattern: string): VersionBounds | null {
  const partialBounds = createPartialVersionBounds(pattern)
  if (!partialBounds?.lower && !partialBounds?.exact) {
    const partial = parsePartialVersionParts(pattern)
    if (!partial || partial.major === "wildcard") return partialBounds

    const lowerFromPartial = createVersion(
      partial.major,
      partial.minor === "wildcard" ? 0 : partial.minor,
      partial.patch === "wildcard" ? 0 : partial.patch,
    )
    const upperFromPartial = partial.minor === "wildcard"
      ? createVersion(partial.major + 1, 0, 0)
      : createVersion(partial.major, partial.minor + 1, 0)

    return {
      lower: lowerFromPartial,
      lowerInclusive: true,
      upper: upperFromPartial,
      upperInclusive: false,
    }
  }

  const lower = partialBounds.exact ?? partialBounds.lower
  if (!lower) return null

  const upper = pattern.split(".").length <= 1
    ? createVersion(lower.major + 1, 0, 0)
    : createVersion(lower.major, lower.minor + 1, 0)

  return {
    lower,
    lowerInclusive: true,
    upper,
    upperInclusive: false,
  }
}

function satisfiesBounds(version: ParsedVersion, bounds: VersionBounds): boolean {
  if (bounds.exact && compareParsedVersions(version, bounds.exact) !== 0) return false
  if (bounds.lower) {
    const comparison = compareParsedVersions(version, bounds.lower)
    if (comparison < 0 || (!bounds.lowerInclusive && comparison === 0)) return false
  }
  if (bounds.upper) {
    const comparison = compareParsedVersions(version, bounds.upper)
    if (comparison > 0 || (!bounds.upperInclusive && comparison === 0)) return false
  }

  return true
}

function prereleaseIsAllowed(version: ParsedVersion, bounds: Array<VersionBounds | null>): boolean {
  if (version.prerelease.length === 0) return true

  return bounds.some(bound => {
    if (!bound) return false

    return versionTupleMatchesPrereleaseBound(version, bound.exact)
      || versionTupleMatchesPrereleaseBound(version, bound.lower)
      || versionTupleMatchesPrereleaseBound(version, bound.upper)
  })
}

function versionTupleMatchesPrereleaseBound(version: ParsedVersion, bound: ParsedVersion | undefined): boolean {
  return !!bound
    && bound.prerelease.length > 0
    && version.major === bound.major
    && version.minor === bound.minor
    && version.patch === bound.patch
}

function parseVersionPart(part: string | undefined): number | "wildcard" | null {
  if (!part || part === "*" || part.toLowerCase() === "x") return "wildcard"
  return /^\d+$/.test(part) ? Number(part) : null
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(version)
  if (!match) return null

  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  }
}

function createVersion(major: number, minor: number, patch: number): ParsedVersion {
  return {
    raw: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
    prerelease: [],
  }
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major
    || left.minor - right.minor
    || left.patch - right.patch
    || comparePrerelease(left.prerelease, right.prerelease)
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const segmentCount = Math.max(left.length, right.length)
  for (let index = 0; index < segmentCount; index += 1) {
    const leftSegment = left[index]
    const rightSegment = right[index]
    if (leftSegment === undefined) return -1
    if (rightSegment === undefined) return 1
    if (leftSegment === rightSegment) continue

    const leftNumber = /^\d+$/.test(leftSegment) ? Number(leftSegment) : null
    const rightNumber = /^\d+$/.test(rightSegment) ? Number(rightSegment) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1

    return leftSegment.localeCompare(rightSegment)
  }

  return 0
}