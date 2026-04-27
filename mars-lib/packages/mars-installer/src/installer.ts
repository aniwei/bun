import { createInstallPlan, resolveCachedPackage } from "./plan"
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
    const plan = await createInstallPlan(options, this.#options.cache)
    await this.writeNodeModules(plan)

    return {
      packages: plan.packages,
      ...(plan.lockfile ? { lockfile: plan.lockfile } : {}),
    }
  }

  async resolvePackage(specifier: string, range: string): Promise<ResolvedPackage> {
    return resolveCachedPackage(this.#options.cache, specifier, range)
  }

  async fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array> {
    if (!pkg.tarballKey) return new Uint8Array()

    return await this.#options.cache.getTarball(pkg.tarballKey) ?? new Uint8Array()
  }

  async writeNodeModules(plan: InstallPlan): Promise<void> {
    await writeNodeModules(this.#options.vfs, plan)
  }
}

export function createMarsInstaller(options: MarsInstallerOptions): PackageInstaller {
  return new MarsInstaller(options)
}