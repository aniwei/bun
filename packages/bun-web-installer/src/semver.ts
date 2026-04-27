/**
 * Minimal semver implementation for @mars/web-installer.
 * Covers the range syntaxes used by npm package.json:
 *   - Exact:  "1.2.3", "v1.2.3"
 *   - Caret:  "^1.2.3", "^0.1.2", "^0.0.3", "^1.2", "^1"
 *   - Tilde:  "~1.2.3", "~1.2", "~1"
 *   - Ops:    ">=1.0.0", ">1.0.0", "<=1.0.0", "<1.0.0", "=1.0.0"
 *   - AND:    ">=1.0.0 <2.0.0"
 *   - OR:     "^1.0.0 || ^2.0.0"
 *   - Wildcard: "*", "x", "1.x", "1.2.x"
 */

type ParsedVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string // empty = stable release
}

function parseVersion(v: string): ParsedVersion | null {
  // trim whitespace and optional leading 'v'
  const s = (v ?? '').trim().replace(/^v/i, '')
  // ignore build metadata (+...) but capture prerelease (-...)
  const match = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^\s+]*))?(?:\+.*)?$/)
  if (!match) return null
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ?? '',
  }
}

/** Pad a partial version string ("1", "1.2") to a full "major.minor.patch" form. */
/** Pad a partial version string ("1", "1.2") to a full "major.minor.patch" form. Preserves prerelease. */
function padVersion(v: string): string {
  const bare = v.replace(/^v/i, '')
  // Split off prerelease suffix before splitting on dots
  const dashIdx = bare.indexOf('-')
  const vBase = dashIdx >= 0 ? bare.slice(0, dashIdx) : bare
  const pre = dashIdx >= 0 ? bare.slice(dashIdx) : ''
  const parts = vBase.split('.')
  while (parts.length < 3) parts.push('0')
  return parts.slice(0, 3).join('.') + pre
}

function comparePrereleaseId(a: string, b: string): number {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) {
    const diff = parseInt(a, 10) - parseInt(b, 10)
    return diff < 0 ? -1 : diff > 0 ? 1 : 0
  }
  if (an) return -1 // numeric < alphanumeric
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePrereleases(a: string, b: string): number {
  if (a === b) return 0
  if (a === '') return 1 // stable > prerelease
  if (b === '') return -1
  const ap = a.split('.')
  const bp = b.split('.')
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i++) {
    const ai = ap[i]
    const bi = bp[i]
    if (ai === undefined) return -1 // fewer identifiers → lower
    if (bi === undefined) return 1
    const cmp = comparePrereleaseId(ai, bi)
    if (cmp !== 0) return cmp
  }
  return 0
}

/** Compare two version strings. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  if (!av && !bv) return 0
  if (!av) return -1
  if (!bv) return 1
  if (av.major !== bv.major) return av.major < bv.major ? -1 : 1
  if (av.minor !== bv.minor) return av.minor < bv.minor ? -1 : 1
  if (av.patch !== bv.patch) return av.patch < bv.patch ? -1 : 1
  return comparePrereleases(av.prerelease, bv.prerelease)
}

/**
 * Test a single comparator clause against a version.
 * The comparator has already been trimmed and operator-normalised.
 */
function satisfiesComparator(version: string, comparator: string): boolean {
  // Normalize whitespace + strip leading 'v'/'=' prefix handled below
  const raw = comparator.trim().replace(/(>=?|<=?|={1,2})\s+/g, '$1')

  if (raw === '' || raw === '*' || raw.toLowerCase() === 'x') return true

  // Wildcard patterns: 1.x, 1.x.x, 1.*, 1.2.x, 1.2.*
  const wildcardMajorMinor = raw.match(/^(\d+)\.(\d+)\.[xX*]$/)
  if (wildcardMajorMinor) {
    const pv = parseVersion(version)
    return (
      pv !== null &&
      pv.prerelease === '' &&
      pv.major === parseInt(wildcardMajorMinor[1], 10) &&
      pv.minor === parseInt(wildcardMajorMinor[2], 10)
    )
  }
  const wildcardMajor = raw.match(/^(\d+)(?:\.(?:[xX*])(?:\.(?:[xX*]))?)?$/)
  if (wildcardMajor && /[xX*]/.test(raw)) {
    const pv = parseVersion(version)
    return pv !== null && pv.prerelease === '' && pv.major === parseInt(wildcardMajor[1], 10)
  }

  // Caret: ^1.2.3 | ^0.1.2 | ^0.0.3
  const caretFull = raw.match(/^\^(\d+)\.(\d+)\.(\d+)(?:-([^\s]*))?$/)
  if (caretFull) {
    const major = parseInt(caretFull[1], 10)
    const minor = parseInt(caretFull[2], 10)
    const patch = parseInt(caretFull[3], 10)
    const pre = caretFull[4] ?? ''
    const lo = `${major}.${minor}.${patch}${pre ? '-' + pre : ''}`
    if (major > 0) {
      return compareVersions(version, lo) >= 0 && compareVersions(version, `${major + 1}.0.0-0`) < 0
    } else if (minor > 0) {
      return compareVersions(version, lo) >= 0 && compareVersions(version, `0.${minor + 1}.0-0`) < 0
    } else {
      return compareVersions(version, lo) >= 0 && compareVersions(version, `0.0.${patch + 1}-0`) < 0
    }
  }

  // Caret: ^1.2 (no patch)
  const caretMinor = raw.match(/^\^(\d+)\.(\d+)$/)
  if (caretMinor) {
    const major = parseInt(caretMinor[1], 10)
    const minor = parseInt(caretMinor[2], 10)
    if (major > 0) {
      return (
        compareVersions(version, `${major}.${minor}.0`) >= 0 &&
        compareVersions(version, `${major + 1}.0.0-0`) < 0
      )
    } else {
      return (
        compareVersions(version, `0.${minor}.0`) >= 0 &&
        compareVersions(version, `0.${minor + 1}.0-0`) < 0
      )
    }
  }

  // Caret: ^1 (major only)
  const caretMajor = raw.match(/^\^(\d+)$/)
  if (caretMajor) {
    const major = parseInt(caretMajor[1], 10)
    return (
      compareVersions(version, `${major}.0.0`) >= 0 &&
      compareVersions(version, `${major + 1}.0.0-0`) < 0
    )
  }

  // Tilde: ~1.2.3
  const tildeFull = raw.match(/^~(\d+)\.(\d+)\.(\d+)(?:-([^\s]*))?$/)
  if (tildeFull) {
    const major = parseInt(tildeFull[1], 10)
    const minor = parseInt(tildeFull[2], 10)
    const patch = parseInt(tildeFull[3], 10)
    const pre = tildeFull[4] ?? ''
    const lo = `${major}.${minor}.${patch}${pre ? '-' + pre : ''}`
    return (
      compareVersions(version, lo) >= 0 &&
      compareVersions(version, `${major}.${minor + 1}.0-0`) < 0
    )
  }

  // Tilde: ~1.2 (no patch)
  const tildeMinor = raw.match(/^~(\d+)\.(\d+)$/)
  if (tildeMinor) {
    const major = parseInt(tildeMinor[1], 10)
    const minor = parseInt(tildeMinor[2], 10)
    return (
      compareVersions(version, `${major}.${minor}.0`) >= 0 &&
      compareVersions(version, `${major}.${minor + 1}.0-0`) < 0
    )
  }

  // Tilde: ~1 (major only)
  const tildeMajor = raw.match(/^~(\d+)$/)
  if (tildeMajor) {
    const major = parseInt(tildeMajor[1], 10)
    return (
      compareVersions(version, `${major}.0.0`) >= 0 &&
      compareVersions(version, `${major + 1}.0.0-0`) < 0
    )
  }

  // Comparison operators with full or partial version
  const cmpOp = raw.match(/^(>=?|<=?|={1,2})\s*(.+)$/)
  if (cmpOp) {
    const op = cmpOp[1]
    const target = padVersion(cmpOp[2].trim().replace(/^v/i, ''))
    const cmp = compareVersions(version, target)
    switch (op) {
      case '>=':
        return cmp >= 0
      case '>':
        return cmp > 0
      case '<=':
        return cmp <= 0
      case '<':
        return cmp < 0
      case '=':
      case '==':
        return cmp === 0
    }
  }

  // Exact version (possibly with leading 'v' or '=')
  // Exact version (possibly with leading 'v' or '=') — do NOT pad, require valid semver
  const stripped = raw.replace(/^[=v]+\s*/i, '')
  const pv = parseVersion(stripped)
  if (pv !== null) {
    return compareVersions(version, stripped) === 0
  }

  return false
}

/** AND range: space-separated comparators, all must be satisfied. */
function satisfiesAndRange(version: string, range: string): boolean {
  // Normalise spaces inside operators (">= 1.0.0" → ">=1.0.0")
  const normalized = range.trim().replace(/(>=?|<=?|={1,2})\s+/g, '$1')
  const comparators = normalized.split(/\s+/).filter(p => p.length > 0)
  return comparators.every(c => satisfiesComparator(version, c))
}

/** Test whether a version string satisfies a semver range (supports ||). */
export function satisfiesRange(version: string, range: string): boolean {
  const pv = parseVersion(version)
  if (!pv) return false
  const orParts = range.split('||')
  return orParts.some(part => satisfiesAndRange(version, part.trim()))
}

/** Return the highest version from `versions` that satisfies `range`, or null. */
export function maxSatisfying(versions: string[], range: string): string | null {
  const hasPreInRange = range.includes('-')
  const matching = versions.filter(v => {
    const pv = parseVersion(v)
    if (!pv) return false
    // Exclude prereleases unless the range explicitly targets a prerelease
    if (pv.prerelease !== '' && !hasPreInRange) return false
    return satisfiesRange(v, range)
  })
  if (matching.length === 0) return null
  return matching.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best))
}
