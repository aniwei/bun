import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url"

import { createWasmLoader } from "@mars/shared"
import { initialize, transform } from "esbuild-wasm"
import { basename, normalizePath } from "@mars/vfs"

import { writeBuildOutputs } from "./output-writer"

import type { Loader } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"
import type { Format, Message, TransformFailure, TransformOptions } from "esbuild-wasm"
import type { BuildOptions, BuildResult } from "./types"
import type { PendingBuildOutput } from "./output-writer"

export interface MarsBuildOptions extends BuildOptions {
  vfs: MarsVFS
}

const esbuildWasmLoader = createWasmLoader("esbuild-wasm", () => {
  return initialize({
    worker: false,
    ...(isHostRuntime() ? {} : { wasmURL: esbuildWasmUrl }),
  })
})

export async function preloadEsbuildWasm(): Promise<void> {
  await esbuildWasmLoader.load()
}

export async function buildProject(options: MarsBuildOptions): Promise<BuildResult> {
  const cwd = options.cwd ?? "/workspace"
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
    const transformed = await transformWithEsbuild(sourceCode, entrypointPath, loader, options)
    const outputPath = outputPathFor(entrypointPath, options, cwd)

    logs.push(...messagesToLogs(transformed.warnings, "warning"))
    if (transformed.success) {
      const mapPath = transformed.map ? `${outputPath}.map` : undefined
      outputs.push({
        path: outputPath,
        code: finalizeOutputCode(transformed.code, loader, mapPath),
        loader,
        ...(transformed.map && mapPath ? { map: transformed.map, mapPath } : {}),
      })
    } else {
      logs.push(...messagesToLogs(transformed.errors, "error"))
    }
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

function inferLoader(path: string): Loader {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".jsx")) return "jsx"
  if (path.endsWith(".json")) return "json"

  return "js"
}

async function transformWithEsbuild(
  sourceCode: string,
  path: string,
  loader: Loader,
  options: BuildOptions,
): Promise<
  | { success: true; code: string; map?: string; warnings: Message[] }
  | { success: false; errors: Message[]; warnings: Message[] }
> {
  try {
    await esbuildWasmLoader.load()
    const output = await transform(sourceCode, createEsbuildOptions(path, loader, options))

    return {
      success: true,
      code: output.code,
      ...(output.map ? { map: output.map } : {}),
      warnings: output.warnings,
    }
  } catch (error) {
    const failure = error as Partial<TransformFailure>

    return {
      success: false,
      errors: failure.errors ?? [{
        id: "",
        pluginName: "esbuild-wasm",
        text: error instanceof Error ? error.message : String(error),
        location: null,
        notes: [],
        detail: error,
      }],
      warnings: failure.warnings ?? [],
    }
  }
}

function createEsbuildOptions(
  path: string,
  loader: Loader,
  options: BuildOptions,
): TransformOptions {
  return {
    sourcefile: path,
    loader,
    format: options.format ?? "esm" satisfies Format,
    target: "es2022",
    platform: options.target === "node" ? "node" : "browser",
    define: options.define,
    sourcemap: options.sourcemap ? "external" : false,
    jsx: "transform",
    jsxFactory: "__mars_jsx",
    jsxFragment: "__mars_jsx_fragment",
  }
}

function injectMarsJsxHelper(sourceCode: string, loader: Loader): string {
  if (loader !== "tsx" && loader !== "jsx") return sourceCode
  if (!sourceCode.includes("__mars_jsx(")) return sourceCode
  if (sourceCode.includes("const __mars_jsx =")) return sourceCode

  return [
    "const __mars_jsx = (tag, props, ...children) => ({ tag, props: props ?? {}, children })",
    sourceCode,
  ].join("\n")
}

function finalizeOutputCode(sourceCode: string, loader: Loader, mapPath?: string): string {
  const code = injectMarsJsxHelper(sourceCode, loader)
  if (!mapPath || code.includes("sourceMappingURL=")) return code

  return `${code.trimEnd()}\n//# sourceMappingURL=${basename(mapPath)}\n`
}

function messagesToLogs(
  messages: Message[],
  level: BuildResult["logs"][number]["level"],
): BuildResult["logs"] {
  return messages.map(message => ({
    level,
    message: message.location
      ? `${message.location.file}:${message.location.line}:${message.location.column}: ${message.text}`
      : message.text,
  }))
}

function isHostRuntime(): boolean {
  const processLike = (globalThis as { process?: { versions?: Record<string, string> } }).process
  return Boolean(processLike?.versions?.node || processLike?.versions?.bun)
}