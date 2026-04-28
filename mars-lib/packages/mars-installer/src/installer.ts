import { extractPackageTarball } from "./extract-tarball"
import { createInstallPlan, resolvePackage } from "./plan"
import { writeNodeModules } from "./write-node-modules"

import type {
  InstallOptions,
  InstallPlan,
  InstallResult,
  MarsInstallerOptions,
  PackageInstaller,
  ResolvedPackage,
} from "./types"

export class MarsInstaller implements PackageInstaller {
  readonly #options: MarsInstallerOptions

  constructor(options: MarsInstallerOptions) {
    this.#options = options
  }

  async install(options: InstallOptions): Promise<InstallResult> {
    const plan = await createInstallPlan(options, this.#options.cache, this.#options.registryClient)
    for (const pkg of plan.packages) {
      await this.#hydratePackageFiles(pkg, options)
    }
    await this.writeNodeModules(plan)

    return {
      packages: plan.packages,
      ...(plan.lockfile ? { lockfile: plan.lockfile } : {}),
    }
  }

  async resolvePackage(specifier: string, range: string): Promise<ResolvedPackage> {
    return resolvePackage(this.#options.cache, specifier, range, {}, this.#options.registryClient)
  }

  async fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array> {
    if (!pkg.tarballKey) return new Uint8Array()

    const cached = await this.#options.cache.getTarball(pkg.tarballKey)
    if (cached) return cached
    if (!this.#options.registryClient) return new Uint8Array()

    const tarball = await this.#options.registryClient.fetchTarball(pkg)
    await this.#options.cache.setTarball(pkg.tarballKey, tarball)
    return tarball
  }

  async writeNodeModules(plan: InstallPlan): Promise<void> {
    await writeNodeModules(this.#options.vfs, plan)
  }

  async #hydratePackageFiles(pkg: ResolvedPackage, options: InstallOptions): Promise<void> {
    if (!pkg.tarballKey) return

    let tarball = await this.#options.cache.getTarball(pkg.tarballKey)
    if (!tarball && !options.offline && this.#options.registryClient) {
      tarball = await this.#options.registryClient.fetchTarball(pkg)
      await this.#options.cache.setTarball(pkg.tarballKey, tarball)
    }
    if (!tarball || hasPackageFiles(pkg)) return

    pkg.files = await extractPackageTarball(tarball)
  }
}

function hasPackageFiles(pkg: ResolvedPackage): boolean {
  return Object.keys(pkg.files).length > 0
}

export function createMarsInstaller(options: MarsInstallerOptions): PackageInstaller {
  return new MarsInstaller(options)
}