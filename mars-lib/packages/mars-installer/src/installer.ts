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
      if (!pkg.tarballKey) continue
      if (await this.#options.cache.getTarball(pkg.tarballKey)) continue
      if (options.offline || !this.#options.registryClient) continue

      await this.#options.cache.setTarball(pkg.tarballKey, await this.#options.registryClient.fetchTarball(pkg))
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
}

export function createMarsInstaller(options: MarsInstallerOptions): PackageInstaller {
  return new MarsInstaller(options)
}