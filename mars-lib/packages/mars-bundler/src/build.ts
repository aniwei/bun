import { createTranspiler } from "@mars/transpiler"
import { basename, normalizePath } from "@mars/vfs"

import { writeBuildOutputs } from "./output-writer"

import type { Loader, Transpiler } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"
import type { BuildOptions, BuildResult } from "./types"
import type { PendingBuildOutput } from "./output-writer"

export interface MarsBuildOptions extends BuildOptions {
  vfs: MarsVFS
  transpiler?: Transpiler
}

export async function buildProject(options: MarsBuildOptions): Promise<BuildResult> {
  const cwd = options.cwd ?? "/workspace"
  const transpiler = options.transpiler ?? createTranspiler()
  const logs: BuildResult["logs"] = []
  const outputs: PendingBuildOutput[] = []

  if (!options.entrypoints.length) {
    return {
      success: false,
      outputs: [],
      logs: [{ level: "error", message: "Bun.build requires at least one entrypoint" }],
    }
  }

  for (const entrypoint of options.entrypoints) {
    const entrypointPath = normalizePath(entrypoint, cwd)
    if (!options.vfs.existsSync(entrypointPath)) {
      logs.push({ level: "error", message: `Entrypoint not found: ${entrypointPath}` })
      continue
    }

    const loader = inferLoader(entrypointPath)
    const sourceCode = String(await options.vfs.readFile(entrypointPath, "utf8"))
    const transformed = await transpiler.transform({
      path: entrypointPath,
      code: sourceCode,
      loader,
      target: options.target ?? "browser",
      define: options.define,
      sourcemap: options.sourcemap,
    })

    logs.push(...transformed.diagnostics)
    outputs.push({
      path: outputPathFor(entrypointPath, options, cwd),
      code: formatBuildOutput(transformed.code, options),
      loader,
    })
  }

  if (logs.some(log => log.level === "error")) {
    return { success: false, outputs: [], logs }
  }

  return {
    success: true,
    outputs: await writeBuildOutputs(options.vfs, outputs),
    logs,
  }
}

function outputPathFor(entrypointPath: string, options: BuildOptions, cwd: string): string {
  if (options.outfile) return normalizePath(options.outfile, cwd)

  const outdir = normalizePath(options.outdir ?? "dist", cwd)
  const filename = basename(entrypointPath).replace(/\.[^.]+$/, ".js")

  return normalizePath(filename, outdir)
}

function formatBuildOutput(code: string, options: BuildOptions): string {
  const format = options.format ?? "esm"
  const normalizedCode = code.endsWith("\n") ? code : `${code}\n`

  if (format !== "iife") return normalizedCode

  return `(function(){\n${normalizedCode}\n})();\n`
}

function inferLoader(path: string): Loader {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".jsx")) return "jsx"
  if (path.endsWith(".json")) return "json"

  return "js"
}