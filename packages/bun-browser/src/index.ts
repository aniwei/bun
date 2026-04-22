export { Kernel, ProcessHandle, type KernelOptions, type KernelPortEvent, type KernelPreviewMessageEvent } from './kernel'
export { WebContainer, type WebContainerBootOptions, type WebContainerProcess, type FileSystemAPI } from './webcontainer-compat'
export { JsiHost, EXCEPTION_SENTINEL, ReservedHandle } from './jsi-host'
export type { HostFnImpl, JsiHostOptions } from './jsi-host'
export { buildSnapshot, parseSnapshot, snapshotSize, type VfsFile } from './vfs-client'
export {
  PREVIEW_PATH_PREFIX,
  PreviewPortRegistry,
  parsePreviewUrl,
  buildPreviewBasePath,
  buildPreviewUrl,
  type ParsedPreviewUrl,
} from './preview-router'
export * from './protocol'
export {
  installPackages,
  chooseVersion,
  parseTar,
  gunzip,
  type InstallerOptions,
  type InstallResult,
  type InstalledPackage,
  type InstallProgress,
  type TarEntry,
} from './installer'
export { WorkerPool, type WorkerLike, type WorkerFactory, type WorkerPoolOptions } from './worker-pool'
