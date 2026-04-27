import type { FileTree } from "@mars/vfs"
import type { PackageCache, PackageMetadata } from "./types"

export interface MemoryPackageCacheOptions {
  metadata?: PackageMetadata[]
  tarballs?: Record<string, Uint8Array | string>
}

export interface PackageCacheFixturePackage {
  name: string
  version?: string
  dependencies?: Record<string, string>
  files?: FileTree
  tarballKey?: string
  distTags?: Record<string, string>
}

export interface PackageCacheFixtureManifest {
  packages?: Array<string | PackageCacheFixturePackage>
  metadata?: PackageMetadata[]
}

export class MemoryPackageCache implements PackageCache {
  readonly #metadata = new Map<string, PackageMetadata>()
  readonly #tarballs = new Map<string, Uint8Array>()

  constructor(options: MemoryPackageCacheOptions = {}) {
    for (const metadata of options.metadata ?? []) {
      this.#metadata.set(metadata.name, metadata)
    }

    for (const [key, value] of Object.entries(options.tarballs ?? {})) {
      this.#tarballs.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value)
    }
  }

  async getTarball(key: string): Promise<Uint8Array | null> {
    return this.#tarballs.get(key)?.slice() ?? null
  }

  async setTarball(key: string, data: Uint8Array): Promise<void> {
    this.#tarballs.set(key, data.slice())
  }

  async getMetadata(name: string): Promise<PackageMetadata | null> {
    return this.#metadata.get(name) ?? null
  }

  async setMetadata(name: string, metadata: PackageMetadata): Promise<void> {
    this.#metadata.set(name, metadata)
  }
}

export function createMemoryPackageCache(options?: MemoryPackageCacheOptions): PackageCache {
  return new MemoryPackageCache(options)
}

export function createMemoryPackageCacheFromFixture(
  manifest: PackageCacheFixtureManifest,
  tarballs: Record<string, Uint8Array | string> = {},
): PackageCache {
  return createMemoryPackageCache({
    metadata: [
      ...(manifest.metadata ?? []),
      ...(manifest.packages ?? []).map(packageMetadataFromFixture),
    ],
    tarballs,
  })
}

function packageMetadataFromFixture(fixture: string | PackageCacheFixturePackage): PackageMetadata {
  const packageName = typeof fixture === "string" ? fixture : fixture.name
  const version = typeof fixture === "string" ? "0.0.0-mars" : fixture.version ?? "0.0.0-mars"
  const tarballKey = typeof fixture === "string"
    ? `${packageName}-${version}.tgz`
    : fixture.tarballKey ?? `${packageName}-${version}.tgz`
  const files = typeof fixture === "string"
    ? { "index.js": `module.exports = { name: ${JSON.stringify(packageName)} }` }
    : fixture.files ?? { "index.js": `module.exports = { name: ${JSON.stringify(packageName)} }` }

  return {
    name: packageName,
    distTags: typeof fixture === "string" ? { latest: version } : fixture.distTags ?? { latest: version },
    versions: {
      [version]: {
        version,
        dependencies: typeof fixture === "string" ? {} : fixture.dependencies ?? {},
        files,
        tarballKey,
      },
    },
  }
}