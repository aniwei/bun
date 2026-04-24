import { maxSatisfying } from './semver'

export type DistTags = Record<string, string>

export type NpmPackageMetadata = {
  name: string
  'dist-tags': DistTags
  versions: Record<string, unknown>
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export type FetchPackageMetadataOptions = {
  registryUrl?: string
  fetchFn?: FetchLike
}

function normalizeRegistryUrl(registryUrl: string): string {
  return registryUrl.replace(/\/+$/, '')
}

function encodePackageName(packageName: string): string {
  return encodeURIComponent(packageName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateMetadata(value: unknown): asserts value is NpmPackageMetadata {
  if (!isRecord(value)) {
    throw new TypeError('Invalid package metadata: expected object')
  }

  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new TypeError('Invalid package metadata: missing name')
  }

  const distTags = value['dist-tags']
  if (!isRecord(distTags)) {
    throw new TypeError('Invalid package metadata: missing dist-tags')
  }

  const versions = value.versions
  if (!isRecord(versions)) {
    throw new TypeError('Invalid package metadata: missing versions')
  }
}

export async function fetchPackageMetadata(
  packageName: string,
  options: FetchPackageMetadataOptions = {},
): Promise<NpmPackageMetadata> {
  if (!packageName || packageName.trim().length === 0) {
    throw new TypeError('packageName must be a non-empty string')
  }

  const registryUrl = normalizeRegistryUrl(options.registryUrl ?? 'https://registry.npmjs.org')
  const fetchFn = options.fetchFn ?? fetch
  const metadataUrl = `${registryUrl}/${encodePackageName(packageName)}`

  const response = await fetchFn(metadataUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch package metadata: ${response.status} ${response.statusText}`)
  }

  const data: unknown = await response.json()
  validateMetadata(data)
  return data
}

export function resolveVersion(metadata: NpmPackageMetadata, spec = 'latest'): string {
  // 1. Dist-tag match (e.g. "latest", "beta")
  const distTagResolved = metadata['dist-tags'][spec]
  if (distTagResolved) return distTagResolved

  // 2. Exact version match
  if (spec in metadata.versions) return spec

  // 3. Semver range resolution (^1.0.0, ~2.0, >=1.0.0 <2.0.0, etc.)
  const allVersions = Object.keys(metadata.versions)
  const best = maxSatisfying(allVersions, spec)
  if (best) return best

  throw new Error(`No version matching '${spec}' found for package '${metadata.name}'`)
}
