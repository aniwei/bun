import type { FileTree, MarsVFS } from "@mars/vfs"

export interface InstallOptions {
  cwd: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  lockfile?: boolean
  registry?: string
  offline?: boolean
}

export interface InstallResult {
  packages: ResolvedPackage[]
  lockfile?: InstallLockfile
}

export interface InstallLockfile {
  packages: Record<string, string>
}

export interface ResolvedPackage {
  name: string
  version: string
  dependencies: Record<string, string>
  files: FileTree
  tarballKey?: string
}

export interface PackageMetadataVersion {
  version: string
  dependencies?: Record<string, string>
  files?: FileTree
  tarballKey?: string
}

export interface PackageMetadata {
  name: string
  versions: Record<string, PackageMetadataVersion>
  distTags?: Record<string, string>
}

export interface InstallPlan {
  cwd: string
  packages: ResolvedPackage[]
  lockfile?: InstallLockfile
}

export interface PackageCache {
  getTarball(key: string): Promise<Uint8Array | null>
  setTarball(key: string, data: Uint8Array): Promise<void>
  getMetadata(name: string): Promise<PackageMetadata | null>
  setMetadata(name: string, metadata: PackageMetadata): Promise<void>
}

export interface PackageInstaller {
  install(options: InstallOptions): Promise<InstallResult>
  resolvePackage(specifier: string, range: string): Promise<ResolvedPackage>
  fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array>
  writeNodeModules(plan: InstallPlan): Promise<void>
}

export interface PackageRegistryClient {
  fetchMetadata(name: string): Promise<PackageMetadata>
  fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array>
}

export interface MarsInstallerOptions {
  vfs: MarsVFS
  cache: PackageCache
  registryClient?: PackageRegistryClient
}