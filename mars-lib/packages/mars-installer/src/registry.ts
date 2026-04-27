import type { PackageMetadata, PackageMetadataVersion, PackageRegistryClient } from "./types"

export interface NpmRegistryClientOptions {
  registry?: string
  fetch?: typeof fetch
}

export function createNpmRegistryClient(options: NpmRegistryClientOptions = {}): PackageRegistryClient {
  const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    async fetchMetadata(name) {
      const response = await fetchImpl(`${registry}/${encodePackageName(name)}`)
      if (!response.ok) throw new Error(`Registry metadata fetch failed: ${name} (${response.status})`)

      return normalizeRegistryMetadata(await response.json())
    },
    async fetchTarball(pkg) {
      if (!pkg.tarballKey) return new Uint8Array()

      const tarballUrl = pkg.tarballKey.startsWith("http://") || pkg.tarballKey.startsWith("https://")
        ? pkg.tarballKey
        : `${registry}/${pkg.tarballKey.replace(/^\/+/, "")}`
      const response = await fetchImpl(tarballUrl)
      if (!response.ok) throw new Error(`Registry tarball fetch failed: ${pkg.name}@${pkg.version} (${response.status})`)

      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

function encodePackageName(name: string): string {
  if (!name.startsWith("@")) return encodeURIComponent(name)

  const [scope = "", packageName = ""] = name.split("/")
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`
}

function normalizeRegistryMetadata(input: unknown): PackageMetadata {
  if (!isRecord(input) || typeof input.name !== "string" || !isRecord(input.versions)) {
    throw new Error("Invalid registry package metadata")
  }

  const versions: Record<string, PackageMetadataVersion> = {}
  for (const [version, value] of Object.entries(input.versions)) {
    if (!isRecord(value)) continue
    versions[version] = {
      version: typeof value.version === "string" ? value.version : version,
      dependencies: isStringRecord(value.dependencies) ? value.dependencies : {},
      files: isRecord(value.files) ? value.files as PackageMetadataVersion["files"] : {},
      ...(isRecord(value.dist) && typeof value.dist.tarball === "string" ? { tarballKey: value.dist.tarball } : {}),
      ...(typeof value.tarballKey === "string" ? { tarballKey: value.tarballKey } : {}),
    }
  }

  return {
    name: input.name,
    versions,
    ...(isStringRecord(input["dist-tags"]) ? { distTags: input["dist-tags"] } : {}),
    ...(isStringRecord(input.distTags) ? { distTags: input.distTags } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "string")
}
