function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sortedObject<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(input).sort()) {
    out[key] = input[key]
  }
  return out
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new TypeError('Invalid lockfile: expected valid JSON')
  }
}

function toText(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

export type LockfilePackageEntry = {
  name: string
  version: string
  resolved?: string
  integrity?: string
  dependencies?: Record<string, string>
}

export type BunWebLockfile = {
  lockfileVersion: 1
  packages: Record<string, LockfilePackageEntry>
}

function validatePackageEntry(value: unknown): asserts value is LockfilePackageEntry {
  if (!isRecord(value)) {
    throw new TypeError('Invalid lockfile: package entry must be an object')
  }

  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new TypeError('Invalid lockfile: package entry missing name')
  }

  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new TypeError('Invalid lockfile: package entry missing version')
  }

  if (value.dependencies !== undefined) {
    if (!isRecord(value.dependencies)) {
      throw new TypeError('Invalid lockfile: dependencies must be an object')
    }
    for (const [depName, depVersion] of Object.entries(value.dependencies)) {
      if (typeof depName !== 'string' || depName.length === 0) {
        throw new TypeError('Invalid lockfile: dependency name must be a non-empty string')
      }
      if (typeof depVersion !== 'string' || depVersion.length === 0) {
        throw new TypeError('Invalid lockfile: dependency version must be a non-empty string')
      }
    }
  }
}

function normalizePackageEntry(entry: LockfilePackageEntry): LockfilePackageEntry {
  const normalized: LockfilePackageEntry = {
    name: entry.name,
    version: entry.version,
  }

  if (entry.resolved) {
    normalized.resolved = entry.resolved
  }

  if (entry.integrity) {
    normalized.integrity = entry.integrity
  }

  if (entry.dependencies) {
    normalized.dependencies = sortedObject(entry.dependencies)
  }

  return normalized
}

export function normalizeLockfile(lockfile: BunWebLockfile): BunWebLockfile {
  const normalizedPackages: Record<string, LockfilePackageEntry> = {}
  for (const key of Object.keys(lockfile.packages).sort()) {
    normalizedPackages[key] = normalizePackageEntry(lockfile.packages[key])
  }

  return {
    lockfileVersion: 1,
    packages: normalizedPackages,
  }
}

export function readLockfile(content: string | Uint8Array): BunWebLockfile {
  const parsed = parseJsonContent(toText(content))
  if (!isRecord(parsed)) {
    throw new TypeError('Invalid lockfile: expected root object')
  }

  if (parsed.lockfileVersion !== 1) {
    throw new TypeError('Invalid lockfile: unsupported lockfileVersion')
  }

  if (!isRecord(parsed.packages)) {
    throw new TypeError('Invalid lockfile: missing packages object')
  }

  const packages: Record<string, LockfilePackageEntry> = {}
  for (const [key, value] of Object.entries(parsed.packages)) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('Invalid lockfile: package key must be a non-empty string')
    }
    validatePackageEntry(value)
    packages[key] = normalizePackageEntry(value)
  }

  return normalizeLockfile({
    lockfileVersion: 1,
    packages,
  })
}

export function createEmptyLockfile(): BunWebLockfile {
  return {
    lockfileVersion: 1,
    packages: {},
  }
}

export function upsertLockfilePackage(
  lockfile: BunWebLockfile,
  packageKey: string,
  entry: LockfilePackageEntry,
): BunWebLockfile {
  if (!packageKey || packageKey.trim().length === 0) {
    throw new TypeError('packageKey must be a non-empty string')
  }

  validatePackageEntry(entry)

  const next: BunWebLockfile = {
    lockfileVersion: 1,
    packages: {
      ...lockfile.packages,
      [packageKey]: normalizePackageEntry(entry),
    },
  }

  return normalizeLockfile(next)
}

export function writeLockfile(lockfile: BunWebLockfile): string {
  const normalized = normalizeLockfile(lockfile)
  return `${JSON.stringify(normalized, null, 2)}\n`
}