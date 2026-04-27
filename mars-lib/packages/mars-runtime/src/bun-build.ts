import { buildProject } from "@mars/bundler"

import type { BuildOptions, BuildResult } from "@mars/bundler"
import type { RuntimeContext } from "./types"

export async function bunBuild(
  context: RuntimeContext,
  options: BuildOptions,
): Promise<BuildResult> {
  return buildProject({
    ...options,
    cwd: options.cwd ?? context.vfs.cwd(),
    vfs: context.vfs,
  })
}