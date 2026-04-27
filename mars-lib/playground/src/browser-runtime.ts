import { createMarsDevServer } from "@mars/bundler"
import { createMarsRuntime } from "@mars/client"
import { createMarsInstaller, createMemoryPackageCacheFromFixture } from "@mars/installer"
import { createModuleLoader } from "@mars/loader"
import { resolve } from "@mars/resolver"
import { createTranspiler } from "@mars/transpiler"
import { createExpressHelloWorldServer } from "../express/server"
import { createKoaHelloWorldServer } from "../koa/server"

import moduleCasesJson from "../module-cases.json"

import phase1BunFileSource from "../core-modules/bun/bun-file.ts?raw"
import phase1BunServeSource from "../core-modules/bun/bun-serve.ts?raw"
import phase1RuntimeVfsShellSource from "../core-modules/bun/vfs-shell.ts?raw"
import resolverManifestText from "../core-modules/resolver/browser-map.json?raw"
import transpilerAppSource from "../core-modules/transpiler/app.tsx?raw"
import transpilerMessageSource from "../core-modules/transpiler/message.ts?raw"
import transpilerTitleSource from "../core-modules/transpiler/title.ts?raw"
import loaderConfigSource from "../core-modules/loader/config.json?raw"
import loaderEntrySource from "../core-modules/loader/entry.tsx?raw"
import loaderFeatureSource from "../core-modules/loader/feature.cjs?raw"
import loaderMessageSource from "../core-modules/loader/message.ts?raw"
import loaderTitleSource from "../core-modules/loader/title.ts?raw"
import runtimeEntrySource from "../core-modules/runtime/run-entry.ts?raw"
import installerDependenciesSource from "../core-modules/installer/dependencies.ts?raw"
import bundlerAppSource from "../core-modules/bundler/src/App.tsx?raw"
import bundlerMessageSource from "../core-modules/bundler/src/message.ts?raw"
import bundlerConfigSource from "../core-modules/bundler/vite.config.ts?raw"
import npmCacheMetadataText from "../fixtures/npm-cache/metadata.json?raw"
import reactTarballText from "../fixtures/npm-cache/react-0.0.0-mars.tgz?raw"
import typescriptTarballText from "../fixtures/npm-cache/typescript-0.0.0-mars.tgz?raw"
import viteTarballText from "../fixtures/npm-cache/vite-0.0.0-mars.tgz?raw"
import tsxAppSource from "../tsx/app.tsx?raw"
import viteReactAppSource from "../vite-react-ts/src/App.tsx?raw"
import viteReactIndexSource from "../vite-react-ts/index.html?raw"
import viteReactPackageSource from "../vite-react-ts/package.json?raw"
import viteReactConfigSource from "../vite-react-ts/vite.config.ts?raw"

import type { FileTree } from "@mars/vfs"
import type { PackageCacheFixtureManifest } from "@mars/installer"

export interface PlaygroundModuleCase {
  id: string
  phase: string
  module: string
  playground: string
  entry: string
  acceptance: string
  status: "covered" | "partial" | "prework" | "planned"
  description: string
}

export interface PlaygroundRunResult {
  id: string
  ok: boolean
  detail: string
}

interface ResolverPlaygroundManifest {
  importer: string
  files: Record<string, string>
  expected: Record<string, string | null>
}

interface RuntimeVfsShellPlayground {
  readmePath: string
  readmeText: string
  sourceDir: string
  sourcePath: string
  sourceCode: string
  shellScript: string
  grepFile: string
  grepText: string
}

interface BunFilePlayground {
  filePath: string
  payloadText: string
  expectedBytes: number
}

interface BunServePlayground {
  port: number
  requestPath: string
  responsePrefix: string
}

interface GrepJsonResult {
  matches: Array<{ file: string; line: number; text: string }>
}

export const moduleCases = moduleCasesJson as PlaygroundModuleCase[]

const runners: Record<string, () => Promise<PlaygroundRunResult>> = {
  "vfs-shell": runPhase1RuntimeVfsShellCase,
  "bun-file": runPhase1BunFileCase,
  "bun-serve": runPhase1BunServeCase,
  "phase1-node-http-express": runPhase1ExpressCase,
  "phase1-node-http-koa": runPhase1KoaCase,
  "phase2-resolver-browser-map": runResolverCase,
  "phase2-transpiler-core": runTranspilerCase,
  "phase2-loader-core": runLoaderCase,
  "phase2-runtime-run-core": runRuntimeCase,
  "phase2-installer-core": () => runInstallerCase("phase2-installer-core"),
  "phase2-bundler-core": runBundlerCase,
  "phase2-tsx-loader": runTsxCase,
  "phase2-vite-dev-server": runViteDevServerCase,
  "phase2-installer-fixtures": () => runInstallerCase("phase2-installer-fixtures"),
}

export function isPlaygroundCaseRunnable(id: string): boolean {
  return id in runners
}

export function runPlaygroundCase(id: string): Promise<PlaygroundRunResult> {
  const runner = runners[id]
  if (!runner) return Promise.resolve(fail(id, "case is not wired to the browser runner"))

  return runner().catch(error => fail(id, error instanceof Error ? error.message : String(error)))
}

export async function runPhase1Cases(): Promise<PlaygroundRunResult[]> {
  return runRunnableCasesForPhase("Phase 1")
}

export async function runPhase2Cases(): Promise<PlaygroundRunResult[]> {
  return runRunnableCasesForPhase("Phase 2")
}

export async function runRunnablePlaygroundCases(): Promise<PlaygroundRunResult[]> {
  const runnableCases = moduleCases.filter(playgroundCase => isPlaygroundCaseRunnable(playgroundCase.id))

  const results: PlaygroundRunResult[] = []
  for (const playgroundCase of runnableCases) {
    results.push(await runPlaygroundCase(playgroundCase.id))
  }

  return results
}

async function runRunnableCasesForPhase(phase: string): Promise<PlaygroundRunResult[]> {
  const phaseCases = moduleCases
    .filter(playgroundCase => playgroundCase.phase === phase)
    .filter(playgroundCase => isPlaygroundCaseRunnable(playgroundCase.id))

  const results: PlaygroundRunResult[] = []
  for (const playgroundCase of phaseCases) {
    results.push(await runPlaygroundCase(playgroundCase.id))
  }

  return results
}

async function runPhase1RuntimeVfsShellCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "runtime-vfs-shell.ts": phase1RuntimeVfsShellSource,
      },
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const playground = await moduleLoader.import(
      "./runtime-vfs-shell",
      "/workspace/src/index.ts",
    ) as RuntimeVfsShellPlayground

    await runtime.vfs.writeFile(playground.readmePath, playground.readmeText)
    await runtime.vfs.mkdir(playground.sourceDir, { recursive: true })
    await runtime.vfs.writeFile(playground.sourcePath, playground.sourceCode)
    const shellResult = await runtime.shell.run(playground.shellScript)

    await runtime.shell.run("mkdir -p tmp && cd tmp")
    await runtime.vfs.writeFile(playground.grepFile, playground.grepText)
    const grepResult = await runtime.shell.run("grep -R hello /workspace")
    const grepJson = grepResult.json as GrepJsonResult | undefined

    if (shellResult.code !== 0 || grepResult.code !== 0) return fail("vfs-shell", "shell command failed")
    if (!runtime.vfs.statSync(playground.sourceDir).isDirectory()) return fail("vfs-shell", "src is not a directory")

    return pass("vfs-shell", `shell=${shellResult.stdout.trim()} grep=${grepJson?.matches.length ?? 0}`)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1BunFileCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "bun-file.ts": phase1BunFileSource,
      },
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const playground = await moduleLoader.import("./bun-file", "/workspace/src/index.ts") as BunFilePlayground
    const written = await runtime.bun.write(playground.filePath, playground.payloadText)
    const file = runtime.bun.file(playground.filePath)
    const payload = await file.json() as { ok: boolean; phase: number }

    if (written !== playground.expectedBytes || file.size !== playground.expectedBytes) return fail("bun-file", "byte count mismatch")
    if (!payload.ok || payload.phase !== 1) return fail("bun-file", JSON.stringify(payload))

    return pass("bun-file", `${playground.filePath} ${file.size} bytes`)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1BunServeCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "bun-serve.ts": phase1BunServeSource,
      },
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const playground = await moduleLoader.import("./bun-serve", "/workspace/src/index.ts") as BunServePlayground
    const server = runtime.bun.serve({
      port: playground.port,
      fetch: request => new Response(`${playground.responsePrefix} ${new URL(request.url).pathname}`),
    })
    const response = await runtime.fetch(runtime.preview(playground.port) + playground.requestPath)
    const body = await response.text()

    server.stop()

    if (response.status !== 200 || body !== "served /hello") return fail("bun-serve", `${response.status} ${body}`)

    return pass("bun-serve", runtime.preview(playground.port) + playground.requestPath)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1ExpressCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const server = createExpressHelloWorldServer(runtime.kernel)
    server.listen(3001)
    const response = await runtime.fetch(runtime.preview(3001) + "users")
    const payload = await response.json() as { framework: string; method: string; url: string }
    server.close()

    if (payload.framework !== "express" || payload.url !== "/users") return fail("phase1-node-http-express", JSON.stringify(payload))

    return pass("phase1-node-http-express", `${payload.method} ${payload.url}`)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1KoaCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const server = createKoaHelloWorldServer(runtime.kernel)
    server.listen(3002)
    const response = await runtime.fetch(runtime.preview(3002))
    const payload = await response.json() as { framework: string; body: string }
    server.close()

    if (payload.framework !== "koa" || payload.body !== "hello mars") return fail("phase1-node-http-koa", JSON.stringify(payload))

    return pass("phase1-node-http-koa", payload.body)
  } finally {
    await runtime.dispose()
  }
}

async function runResolverCase(): Promise<PlaygroundRunResult> {
  const manifest = JSON.parse(resolverManifestText) as ResolverPlaygroundManifest
  const files = new Map(Object.entries(manifest.files))
  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  for (const [specifier, expectedPath] of Object.entries(manifest.expected)) {
    const resolvedPath = resolve(specifier, manifest.importer, { fileSystem })
    if (resolvedPath !== expectedPath) return fail("phase2-resolver-browser-map", `${specifier} -> ${resolvedPath}`)
  }

  return pass("phase2-resolver-browser-map", "browser map and imports resolved")
}

async function runTranspilerCase(): Promise<PlaygroundRunResult> {
  const transpiler = createTranspiler()
  const result = await transpiler.transform({
    path: "/workspace/src/app.tsx",
    code: transpilerAppSource,
    loader: "tsx",
  })

  if (!result.imports.some(importRecord => importRecord.path === "./message" && importRecord.kind === "dynamic-import")) {
    return fail("phase2-transpiler-core", "dynamic import was not tracked")
  }

  return pass("phase2-transpiler-core", `${result.imports.length} imports scanned`)
}

async function runLoaderCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: coreLoaderFiles(),
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const moduleNamespace = await moduleLoader.import("./entry", "/workspace/src/index.tsx") as {
      loadMessage(): Promise<string>
      loadCommonJsValue(): number
    }
    const message = await moduleNamespace.loadMessage()
    const value = moduleNamespace.loadCommonJsValue()

    if (message !== "loader dynamic import:json" || value !== 42) return fail("phase2-loader-core", `${message}, ${value}`)

    return pass("phase2-loader-core", "TSX, dynamic import, JSON and CJS executed")
  } finally {
    await runtime.dispose()
  }
}

async function runRuntimeCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "run-entry.ts": runtimeEntrySource,
      },
    },
  })

  try {
    const processHandle = await runtime.run("/workspace/src/run-entry.ts")
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ])

    if (exitCode !== 0) return fail("phase2-runtime-run-core", `exit ${exitCode}`)

    return pass("phase2-runtime-run-core", `stdout=${stdout.trim()} stderr=${stderr.trim()}`)
  } finally {
    await runtime.dispose()
  }
}

async function runInstallerCase(id: string): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "dependencies.ts": installerDependenciesSource,
      },
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const moduleNamespace = await moduleLoader.import("./dependencies", "/workspace/src/index.ts") as {
      dependencies: Record<string, string>
    }
    const installer = createMarsInstaller({
      vfs: runtime.vfs,
      cache: createPlaygroundPackageCache(),
    })
    const result = await installer.install({
      cwd: "/workspace",
      dependencies: moduleNamespace.dependencies,
      offline: true,
    })

    return pass(id, result.packages.map(pkg => pkg.name).join(", "))
  } finally {
    await runtime.dispose()
  }
}

async function runBundlerCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: coreBundlerFiles(),
  })

  try {
    const devServer = createMarsDevServer({ vfs: runtime.vfs })
    const response = await devServer.loadModule("/src/App.tsx")
    const code = await response.text()

    if (response.status !== 200 || !code.includes("Core Module Bundler")) return fail("phase2-bundler-core", `status ${response.status}`)

    return pass("phase2-bundler-core", response.headers.get("x-mars-module-path") ?? "loaded")
  } finally {
    await runtime.dispose()
  }
}

async function runTsxCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "app.tsx": tsxAppSource,
      },
    },
  })

  try {
    const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
    const moduleNamespace = await moduleLoader.import("./app", "/workspace/src/index.tsx") as {
      renderMessage(): unknown
    }

    return pass("phase2-tsx-loader", JSON.stringify(moduleNamespace.renderMessage()))
  } finally {
    await runtime.dispose()
  }
}

async function runViteDevServerCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: viteReactFiles(),
  })

  try {
    const devServer = createMarsDevServer({ vfs: runtime.vfs })
    const response = await devServer.loadModule("/src/App.tsx")
    const code = await response.text()

    if (response.status !== 200 || !code.includes("Mars Vite React TS")) return fail("phase2-vite-dev-server", `status ${response.status}`)

    return pass("phase2-vite-dev-server", response.headers.get("x-mars-module-path") ?? "loaded")
  } finally {
    await runtime.dispose()
  }
}

function coreLoaderFiles(): FileTree {
  return {
    "entry.tsx": loaderEntrySource,
    "title.ts": loaderTitleSource,
    "message.ts": loaderMessageSource,
    "config.json": loaderConfigSource,
    "feature.cjs": loaderFeatureSource,
  }
}

function coreBundlerFiles(): FileTree {
  return {
    "vite.config.ts": bundlerConfigSource,
    app: {
      src: {
        "App.tsx": bundlerAppSource,
        "message.ts": bundlerMessageSource,
      },
    },
  }
}

function viteReactFiles(): FileTree {
  return {
    "package.json": viteReactPackageSource,
    "index.html": viteReactIndexSource,
    "vite.config.ts": viteReactConfigSource,
    src: {
      "App.tsx": viteReactAppSource,
    },
  }
}

function createPlaygroundPackageCache() {
  return createMemoryPackageCacheFromFixture(
    JSON.parse(npmCacheMetadataText) as PackageCacheFixtureManifest,
    {
      "react-0.0.0-mars.tgz": reactTarballText,
      "typescript-0.0.0-mars.tgz": typescriptTarballText,
      "vite-0.0.0-mars.tgz": viteTarballText,
    },
  )
}

function pass(id: string, detail: string): PlaygroundRunResult {
  return { id, ok: true, detail }
}

function fail(id: string, detail: string): PlaygroundRunResult {
  return { id, ok: false, detail }
}
