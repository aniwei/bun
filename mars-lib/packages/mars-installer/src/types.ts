import type { FileTree, MarsVFS } from "@mars/vfs"

export interface InstallOptions {
  cwd: string
  rootName?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: WorkspacePackage[]
  lockfile?: boolean
  preferLockfile?: boolean
  registry?: string
  offline?: boolean
}

export interface InstallResult {
  packages: ResolvedPackage[]
  lockfile?: InstallLockfile
}

export interface InstallLockfile {
  packages: Record<string, string>
  root: {
    name?: string
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    optionalDependencies: Record<string, string>
    peerDependencies: Record<string, string>
  }
  entries: Record<string, InstallLockfileEntry>
}

export interface InstallLockfileEntry {
  version: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  tarball?: string
  workspace?: string
}

export interface ResolvedPackage {
  name: string
  version: string
  installPath?: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, PeerDependencyMeta>
  scripts: PackageLifecycleScripts
  bin: PackageBin
  workspacePath?: string
  files: FileTree
  tarballKey?: string
}

export interface PeerDependencyMeta {
  optional?: boolean
}

export interface PackageLifecycleScripts {
  preinstall?: string
  install?: string
  postinstall?: string
}

export type PackageBin = Record<string, string>

export interface WorkspacePackage {
  name: string
  version: string
  path: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, PeerDependencyMeta>
  scripts?: PackageLifecycleScripts
  bin?: string | PackageBin
  files: FileTree
}

export interface PackageMetadataVersion {
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, PeerDependencyMeta>
  scripts?: PackageLifecycleScripts
  bin?: PackageBin
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