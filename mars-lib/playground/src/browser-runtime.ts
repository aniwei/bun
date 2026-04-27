import { createMarsDevServer } from "@mars/bundler"
import { createMarsBridgeEndpoint, createMarsMemoryBridgePair, createMarsPostMessageBridgeTransport } from "@mars/bridge"
import { createMarsRuntime } from "@mars/client"
import { createHashDigest } from "@mars/crypto"
import { createMemoryPackageCacheFromFixture, createNpmRegistryClient } from "@mars/installer"
import { connectMarsKernelWorker, createKernelWorkerController, createMarsKernel, createMarsProcessWorkerFactory, installKernelWorkerBootstrap, supportsKernelWorkerClient } from "@mars/kernel"
import { createModuleLoader } from "@mars/loader"
import { resolve } from "@mars/resolver"
import { createProcessWorkerBootstrapBlobURL, createProcessWorkerBootstrapScript, installProcessWorkerRuntimeBootstrap } from "@mars/runtime"
import { createBridgeServiceWorkerKernelClient, createServiceWorkerBridgeController, createServiceWorkerRouter, installServiceWorkerBootstrap, moduleUrlFromPath } from "@mars/sw"
import { createTranspiler } from "@mars/transpiler"
import { createOPFSPersistenceAdapter, createWriteFilePatch, restoreVFSSnapshot, snapshotVFS } from "@mars/vfs"
import { createHmac } from "@mars/node"
import {
  createExpressPlaygroundApp,
  expressCreatePath,
  expressRequestBody,
  expressTraceHeader,
  expressTraceHeaderValue,
  expressUsersPath,
} from "../express/server"
import {
  createKoaPlaygroundApp,
  koaEchoPath,
  koaProfilePath,
  koaRequestBody,
  koaTraceHeader,
  koaTraceHeaderValue,
} from "../koa/server"
import {
  createNodeHttpPlaygroundServer,
  nodeHttpExpectedMethod,
  nodeHttpHeaderName,
  nodeHttpHeaderValue,
  nodeHttpRequestBody,
  nodeHttpRequestPath,
} from "../node-http/server"
import { cryptoFixtureText, cryptoHmacKey, expectedHmacSha256Hex, expectedMd5Hex, expectedSha256Hex } from "../core-modules/runtime/crypto"
import {
  processWorkerBootstrapArgv,
  processWorkerBootstrapConfigValue,
  processWorkerBootstrapCwd,
  processWorkerBootstrapEnv,
  processWorkerBootstrapRequireSpecifier,
} from "../core-modules/runtime/process-worker-bootstrap"
import {
  processWorkerScriptCwd,
  processWorkerScriptEntry,
  processWorkerBrowserSmokeSource,
  processWorkerBrowserSmokeStdout,
  processWorkerScriptSource,
  processWorkerScriptURLPrefix,
} from "../core-modules/runtime/process-worker-script"
import {
  playgroundHostRequiresCrossOriginIsolation,
  playgroundHostRequiresSharedArrayBuffer,
  playgroundHostServiceWorkerScope,
  playgroundHostServiceWorkerScriptURL,
} from "../core-modules/runtime/playground-host"
import {
  serviceWorkerScopeSmokeEntry,
  serviceWorkerScopeSmokeMessage,
  serviceWorkerScopeSmokePatchedMessage,
  serviceWorkerScopeSmokePatchMode,
  serviceWorkerScopeSmokeScope,
  serviceWorkerScopeSmokeScriptURL,
} from "../core-modules/runtime/service-worker-scope-smoke"

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
import runtimeBridgeChainSource from "../core-modules/runtime/bridge-chain.ts?raw"
import runtimeCryptoSource from "../core-modules/runtime/crypto.ts?raw"
import runtimeBunRunIndexSource from "../core-modules/runtime/bun-run-index.ts?raw"
import runtimeEntrySource from "../core-modules/runtime/run-entry.ts?raw"
import runtimeKernelWorkerBootstrapSource from "../core-modules/runtime/kernel-worker-bootstrap.ts?raw"
import runtimeOpfsSource from "../core-modules/runtime/opfs.ts?raw"
import runtimePasswordSource from "../core-modules/runtime/password.ts?raw"
import runtimePlaygroundHostSource from "../core-modules/runtime/playground-host.ts?raw"
import runtimeProcessWorkerBootstrapSource from "../core-modules/runtime/process-worker-bootstrap.ts?raw"
import runtimeProcessWorkerScriptSource from "../core-modules/runtime/process-worker-script.ts?raw"
import runtimeProcessWorkerSource from "../core-modules/runtime/process-worker.ts?raw"
import runtimeServiceWorkerModuleResponseMessageSource from "../core-modules/runtime/service-worker-module-response-message.ts?raw"
import runtimeServiceWorkerModuleResponseSource from "../core-modules/runtime/service-worker-module-response.ts?raw"
import runtimeServiceWorkerBootstrapSource from "../core-modules/runtime/service-worker-bootstrap.ts?raw"
import runtimeServiceWorkerRegistrationSource from "../core-modules/runtime/service-worker-registration.ts?raw"
import runtimeServiceWorkerScopeSmokeSource from "../core-modules/runtime/service-worker-scope-smoke.ts?raw"
import runtimeSqliteSource from "../core-modules/runtime/sqlite.ts?raw"
import runtimeSnapshotSource from "../core-modules/runtime/snapshot.ts?raw"
import runtimeStdioSource from "../core-modules/runtime/stdio.ts?raw"
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
import type { KernelWorkerMessageEvent, WorkerLike } from "@mars/kernel"
import type { MarsServiceWorkerContainer, MarsServiceWorkerController, MarsServiceWorkerFetchEvent, MarsServiceWorkerMessageEvent, MarsServiceWorkerRegistration, MarsServiceWorkerRegistrationOptions } from "@mars/sw"

export interface PlaygroundModuleCase {
  id: string
  phase: string
  module: string
  playground: string
  entry: string
  acceptance: string
  status: "covered" | "partial" | "prework" | "planned" | "smoke"
  description: string
}

export interface PlaygroundRunResult {
  id: string
  ok: boolean
  detail: string
}

export interface PlaygroundRuntimeStatus {
  secureContext: boolean
  origin: string
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  serviceWorkerAvailable: boolean
  serviceWorkerReady: boolean
  serviceWorkerControlled: boolean
  serviceWorkerScriptURL: string
  serviceWorkerScope: string
  serviceWorkerState: string
  serviceWorkerControllerURL: string | null
  serviceWorkerRequiresReload: boolean
  error?: string
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

class PlaygroundServiceWorkerController implements MarsServiceWorkerController {
  messages: unknown[] = []
  transfers: Transferable[][] = []

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push(transfer)
  }
}

class PlaygroundServiceWorkerRegistration implements MarsServiceWorkerRegistration {
  readonly active: PlaygroundServiceWorkerController
  unregistered = false

  constructor(active: PlaygroundServiceWorkerController) {
    this.active = active
  }

  async unregister(): Promise<boolean> {
    this.unregistered = true
    return true
  }
}

class PlaygroundServiceWorkerContainer implements MarsServiceWorkerContainer {
  readonly controller: PlaygroundServiceWorkerController
  readonly registration: PlaygroundServiceWorkerRegistration
  readonly ready: Promise<MarsServiceWorkerRegistration>
  registrations: Array<{ scriptURL: string | URL; options?: MarsServiceWorkerRegistrationOptions }> = []

  constructor() {
    this.controller = new PlaygroundServiceWorkerController()
    this.registration = new PlaygroundServiceWorkerRegistration(this.controller)
    this.ready = Promise.resolve(this.registration)
  }

  async register(
    scriptURL: string | URL,
    options?: MarsServiceWorkerRegistrationOptions,
  ): Promise<MarsServiceWorkerRegistration> {
    this.registrations.push({ scriptURL, options })
    return this.registration
  }
}

class PlaygroundServiceWorkerScope {
  readonly #eventTarget = new EventTarget()

  addEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
  addEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
  addEventListener(
    type: "fetch" | "message",
    listener: ((event: MarsServiceWorkerFetchEvent) => void) | ((event: MarsServiceWorkerMessageEvent) => void),
  ): void {
    this.#eventTarget.addEventListener(type, listener as unknown as EventListener)
  }

  removeEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
  removeEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
  removeEventListener(
    type: "fetch" | "message",
    listener: ((event: MarsServiceWorkerFetchEvent) => void) | ((event: MarsServiceWorkerMessageEvent) => void),
  ): void {
    this.#eventTarget.removeEventListener(type, listener as unknown as EventListener)
  }

  dispatchFetch(request: Request): Promise<Response> {
    const event = new PlaygroundFetchEvent(request)
    this.#eventTarget.dispatchEvent(event)
    return event.response
  }

  dispatchMessage(event: MarsServiceWorkerMessageEvent): void {
    this.#eventTarget.dispatchEvent(new MessageEvent("message", {
      data: event.data,
      ports: [...(event.ports ?? [])],
    }))
  }
}

class PlaygroundFetchEvent extends Event {
  readonly request: Request
  #response: Promise<Response> | null = null

  constructor(request: Request) {
    super("fetch")
    this.request = request
  }

  get response(): Promise<Response> {
    if (!this.#response) throw new Error("Fetch event was not handled")

    return this.#response
  }

  respondWith(response: Response | Promise<Response>): void {
    this.#response = Promise.resolve(response)
  }
}

class PlaygroundKernelWorkerScope {
  readonly #eventTarget = new EventTarget()

  addEventListener(type: "message", listener: (event: KernelWorkerMessageEvent) => void): void {
    this.#eventTarget.addEventListener(type, listener as unknown as EventListener)
  }

  removeEventListener(type: "message", listener: (event: KernelWorkerMessageEvent) => void): void {
    this.#eventTarget.removeEventListener(type, listener as unknown as EventListener)
  }

  dispatchMessage(event: KernelWorkerMessageEvent): void {
    this.#eventTarget.dispatchEvent(new MessageEvent("message", {
      data: event.data,
      ports: [...(event.ports ?? [])],
    }))
  }
}

class PlaygroundNativeProcessWorker implements WorkerLike {
  static instances: PlaygroundNativeProcessWorker[] = []
  readonly url: string | URL
  readonly options: WorkerOptions | undefined
  readonly messages: unknown[] = []
  terminated = false
  readonly #eventTarget = new EventTarget()

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url
    this.options = options
    PlaygroundNativeProcessWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    const payload = message as { type?: string; id?: string; argv?: string[]; data?: unknown; chunk?: string | Uint8Array; patches?: unknown[] }

    if (payload.type === "process.worker.boot") {
      this.dispatch({ type: "boot", id: payload.id, argv: payload.argv })
    } else if (payload.type === "process.worker.message") {
      this.dispatch({ type: "message", id: payload.id, data: { echoed: payload.data } })
    } else if (payload.type === "process.worker.stdin") {
      this.dispatch({ type: "process.worker.stdout", id: payload.id, chunk: `stdout:${payload.chunk}` })
      this.dispatch({ type: "process.worker.stderr", id: payload.id, chunk: `stderr:${payload.chunk}` })
    } else if (payload.type === "process.worker.vfs.patch") {
      this.dispatch({ type: "process.worker.vfs.patch", id: payload.id, ok: true, count: payload.patches?.length ?? 0 })
    } else if (payload.type === "process.worker.run") {
      this.dispatch({ type: "process.worker.stdout", id: payload.id, chunk: "bridge run stdout" })
      this.dispatch({ type: "process.worker.exit", id: payload.id, code: 0 })
    }
  }

  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.addEventListener(type, listener as EventListener)
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.removeEventListener(type, listener as EventListener)
  }

  terminate(): void {
    this.terminated = true
  }

  dispatch(data: unknown): void {
    this.#eventTarget.dispatchEvent(new MessageEvent("message", { data }))
  }
}

class PlaygroundProcessWorkerRuntimeScope {
  readonly console = console
  readonly messages: unknown[] = []
  readonly #eventTarget = new EventTarget()

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.addEventListener(type, listener as EventListener)
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.removeEventListener(type, listener as EventListener)
  }

  dispatch(data: unknown): void {
    this.#eventTarget.dispatchEvent(new MessageEvent("message", { data }))
  }
}

interface InjectedProcessWorkerRuntimeScope extends PlaygroundProcessWorkerRuntimeScope {
  process: {
    argv: string[]
    env: Record<string, string>
    cwd(): string
  }
  Bun: {
    env: Record<string, string>
    version: string
  }
  require(specifier: string): unknown
}

class PlaygroundKernelCarrierWorker implements WorkerLike {
  static instances: PlaygroundKernelCarrierWorker[] = []
  static scope: PlaygroundKernelWorkerScope | null = null
  readonly url: string | URL
  readonly options: WorkerOptions | undefined
  readonly messages: unknown[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  readonly #eventTarget = new EventTarget()

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url
    this.options = options
    PlaygroundKernelCarrierWorker.instances.push(this)
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push(transfer)
    const payload = message as { type?: string } | undefined

    if (payload?.type === "kernel.connect") {
      PlaygroundKernelCarrierWorker.scope?.dispatchMessage({
        data: message,
        ports: transfer as MessagePort[],
      })
    }
  }

  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.addEventListener(type, listener as EventListener)
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#eventTarget.removeEventListener(type, listener as EventListener)
  }

  terminate(): void {
    this.terminated = true
  }
}

export const moduleCases = moduleCasesJson as PlaygroundModuleCase[]

const runners: Record<string, () => Promise<PlaygroundRunResult>> = {
  "vfs-shell": runPhase1RuntimeVfsShellCase,
  "bun-file": runPhase1BunFileCase,
  "bun-serve": runPhase1BunServeCase,
  "phase1-node-http-core": runPhase1NodeHttpCase,
  "phase1-node-http-express": runPhase1ExpressCase,
  "phase1-node-http-koa": runPhase1KoaCase,
  "phase2-resolver-browser-map": runResolverCase,
  "phase2-transpiler-core": runTranspilerCase,
  "phase2-loader-core": runLoaderCase,
  "phase2-runtime-run-core": runRuntimeCase,
  "phase2-installer-core": () => runInstallerCase("phase2-installer-core"),
  "phase2-installer-registry-fetch": runInstallerRegistryFetchCase,
  "phase2-bundler-core": runBundlerCase,
  "phase2-tsx-loader": runTsxCase,
  "phase2-vite-dev-server": runViteDevServerCase,
  "phase2-installer-fixtures": () => runInstallerCase("phase2-installer-fixtures"),
  "phase3-bun-build-vite-entry": runBunBuildCase,
  "phase3-bun-run-index": runBunRunCase,
  "phase3-bun-spawn-run-index": runBunSpawnCase,
  "phase3-crypto-hasher": runCryptoCase,
  "phase3-password": runPasswordCase,
  "phase3-bun-sql": runSqliteCase,
  "phase3-vfs-snapshot": runSnapshotCase,
  "phase3-kernel-stdio": runStdioCase,
  "phase3-opfs-persistence": runOpfsCase,
  "phase3-process-worker-factory": runProcessWorkerCase,
  "phase3-process-worker-bootstrap": runProcessWorkerBootstrapCase,
  "phase3-process-worker-script": runProcessWorkerScriptCase,
  "phase3-real-browser-worker-smoke": runRealBrowserWorkerSmokeCase,
  "phase3-sw-kernel-process-bridge": runBridgeChainCase,
  "phase3-service-worker-registration": runServiceWorkerRegistrationCase,
  "phase3-service-worker-bootstrap": runServiceWorkerBootstrapCase,
  "phase3-service-worker-module-response": runServiceWorkerModuleResponseCase,
  "phase3-service-worker-scope-smoke": runServiceWorkerScopeSmokeCase,
  "phase3-kernel-worker-bootstrap": runKernelWorkerBootstrapCase,
  "phase3-playground-host-runtime": runPlaygroundHostRuntimeCase,
}

let playgroundRuntimePromise: Promise<Awaited<ReturnType<typeof createMarsRuntime>>> | null = null

export function isPlaygroundCaseRunnable(id: string): boolean {
  return id in runners
}

export function runPlaygroundCase(id: string): Promise<PlaygroundRunResult> {
  const runner = runners[id]
  if (!runner) return Promise.resolve(fail(id, "case is not wired to the browser runner"))

  return runner().catch(error => fail(id, error instanceof Error ? error.message : String(error)))
}

export async function ensurePlaygroundRuntimeStatus(): Promise<PlaygroundRuntimeStatus> {
  const baseStatus = readPlaygroundRuntimeStatus()
  if (!baseStatus.serviceWorkerAvailable) return baseStatus

  try {
    const runtime = await ensurePlaygroundServiceWorkerRuntime()
    const registration = runtime.serviceWorker?.registration as ServiceWorkerRegistration | null | undefined
    const activeWorker = registration?.active ?? null
    const controller = globalThis.navigator?.serviceWorker?.controller ?? null

    return {
      ...readPlaygroundRuntimeStatus(),
      serviceWorkerReady: runtime.serviceWorker?.ready === true,
      serviceWorkerControlled: Boolean(controller),
      serviceWorkerScope: registration?.scope ?? playgroundHostServiceWorkerScope,
      serviceWorkerState: activeWorker?.state ?? "ready",
      serviceWorkerControllerURL: controller?.scriptURL ?? null,
      serviceWorkerRequiresReload: runtime.serviceWorker?.ready === true && !controller,
    }
  } catch (error) {
    return {
      ...readPlaygroundRuntimeStatus(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function readPlaygroundRuntimeStatus(): PlaygroundRuntimeStatus {
  return {
    secureContext: globalThis.isSecureContext === true,
    origin: globalThis.location?.origin ?? "unknown",
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
    serviceWorkerAvailable: Boolean(globalThis.navigator?.serviceWorker),
    serviceWorkerReady: false,
    serviceWorkerControlled: Boolean(globalThis.navigator?.serviceWorker?.controller),
    serviceWorkerScriptURL: playgroundHostServiceWorkerScriptURL,
    serviceWorkerScope: playgroundHostServiceWorkerScope,
    serviceWorkerState: "not-started",
    serviceWorkerControllerURL: globalThis.navigator?.serviceWorker?.controller?.scriptURL ?? null,
    serviceWorkerRequiresReload: false,
  }
}

function ensurePlaygroundServiceWorkerRuntime(): Promise<Awaited<ReturnType<typeof createMarsRuntime>>> {
  playgroundRuntimePromise ??= createMarsRuntime({
    serviceWorkerUrl: playgroundHostServiceWorkerScriptURL,
    serviceWorkerScope: playgroundHostServiceWorkerScope,
  })

  return playgroundRuntimePromise
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

async function runPhase1NodeHttpCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const server = createNodeHttpPlaygroundServer(runtime.kernel)
    let requestEvents = 0
    let listeningEvents = 0
    let closeEvents = 0
    let listenCallbackCalled = false
    server.on("request", () => {
      requestEvents += 1
    })
    server.on("listening", () => {
      listeningEvents += 1
    })
    server.on("close", () => {
      closeEvents += 1
    })
    server.listen(0, () => {
      listenCallbackCalled = true
    })
    const address = server.address()
    if (!address || address.port <= 0) return fail("phase1-node-http-core", "server did not listen")

    const response = await runtime.fetch(`${runtime.preview(address.port)}${nodeHttpRequestPath.slice(1)}`, {
      method: nodeHttpExpectedMethod,
      headers: {
        [nodeHttpHeaderName]: nodeHttpHeaderValue,
      },
      body: nodeHttpRequestBody,
    })
    const payload = await response.json() as {
      method?: string
      url?: string
      header?: string
      body?: string
    }
    server.close()

    if (response.status !== 201) return fail("phase1-node-http-core", `status ${response.status}`)
    if (response.headers.get("x-mars-handler") !== "node-http") return fail("phase1-node-http-core", "missing handler header")
    if (payload.method !== nodeHttpExpectedMethod) return fail("phase1-node-http-core", JSON.stringify(payload))
    if (payload.url !== nodeHttpRequestPath) return fail("phase1-node-http-core", JSON.stringify(payload))
    if (payload.header !== nodeHttpHeaderValue) return fail("phase1-node-http-core", JSON.stringify(payload))
    if (payload.body !== nodeHttpRequestBody) return fail("phase1-node-http-core", JSON.stringify(payload))
    if (runtime.kernel.resolvePort(address.port) !== null) return fail("phase1-node-http-core", "port still registered after close")
    if (!listenCallbackCalled || listeningEvents !== 1 || requestEvents !== 1 || closeEvents !== 1) {
      return fail("phase1-node-http-core", `events ${listeningEvents}/${requestEvents}/${closeEvents}`)
    }

    return pass("phase1-node-http-core", `${nodeHttpExpectedMethod} ${payload.url} port=${address.port}`)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1ExpressCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const server = createExpressPlaygroundApp(runtime.kernel).listen(3001)
    const response = await runtime.fetch(runtime.preview(3001) + expressUsersPath.slice(1))
    const payload = await response.json() as { framework: string; method: string; route: string; active: string; middleware: string }
    const createResponse = await runtime.fetch(runtime.preview(3001) + expressCreatePath.slice(1), {
      method: "POST",
      body: expressRequestBody,
    })
    const createPayload = await createResponse.json() as { framework: string; route: string; method: string; body: { name: string; role: string } }
    server.close()

    if (response.headers.get(expressTraceHeader) !== expressTraceHeaderValue) return fail("phase1-node-http-express", "missing middleware header")
    if (payload.framework !== "express" || payload.route !== "users.index" || payload.active !== "1") return fail("phase1-node-http-express", JSON.stringify(payload))
    if (createResponse.status !== 201 || createPayload.route !== "users.create" || createPayload.body.name !== "Ada") return fail("phase1-node-http-express", JSON.stringify(createPayload))
    if (runtime.kernel.resolvePort(3001) !== null) return fail("phase1-node-http-express", "port still registered after close")

    return pass("phase1-node-http-express", `${payload.method} ${payload.route}; ${createPayload.method} ${createPayload.route}`)
  } finally {
    await runtime.dispose()
  }
}

async function runPhase1KoaCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const server = createKoaPlaygroundApp(runtime.kernel).listen(3002)
    const response = await runtime.fetch(runtime.preview(3002) + koaProfilePath.slice(1))
    const payload = await response.json() as { framework: string; route: string; name: string; middleware: string }
    const echoResponse = await runtime.fetch(runtime.preview(3002) + koaEchoPath.slice(1), {
      method: "POST",
      body: koaRequestBody,
    })
    const echoPayload = await echoResponse.json() as { framework: string; route: string; body: string }
    server.close()

    if (response.headers.get(koaTraceHeader) !== koaTraceHeaderValue || response.headers.get("x-mars-koa-after") !== "returned") return fail("phase1-node-http-koa", "missing middleware headers")
    if (payload.framework !== "koa" || payload.route !== "profile.show" || payload.name !== "mars") return fail("phase1-node-http-koa", JSON.stringify(payload))
    if (echoResponse.status !== 202 || echoPayload.route !== "echo.create" || echoPayload.body !== koaRequestBody) return fail("phase1-node-http-koa", JSON.stringify(echoPayload))
    if (runtime.kernel.resolvePort(3002) !== null) return fail("phase1-node-http-koa", "port still registered after close")

    return pass("phase1-node-http-koa", `${payload.route}; ${echoPayload.route}`)
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

async function runBunRunCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "index.ts": runtimeBunRunIndexSource,
    },
  })

  try {
    const result = await runtime.shell.run("bun run index.ts")
    if (result.code !== 0) return fail("phase3-bun-run-index", `exit ${result.code}`)
    if (!result.stdout.includes("bun run index")) return fail("phase3-bun-run-index", result.stdout)

    return pass("phase3-bun-run-index", `stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`)
  } finally {
    await runtime.dispose()
  }
}

async function runBunBuildCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: viteReactFiles(),
  })

  try {
    const result = await runtime.bun.build({
      entrypoints: ["src/App.tsx"],
      outfile: "dist/playground-app.js",
      sourcemap: true,
    })
    const output = String(await runtime.vfs.readFile("dist/playground-app.js", "utf8"))
    const sourceMap = String(await runtime.vfs.readFile("dist/playground-app.js.map", "utf8"))

    if (!result.success) return fail("phase3-bun-build-vite-entry", result.logs.map(log => log.message).join("\n"))
    if (!output.includes("Mars Vite React TS")) return fail("phase3-bun-build-vite-entry", "missing playground output")
    if (!sourceMap.includes("App.tsx")) return fail("phase3-bun-build-vite-entry", "missing source map")

    return pass("phase3-bun-build-vite-entry", `outputs=${result.outputs.length} map=${result.outputs[1]?.path ?? "missing"}`)
  } finally {
    await runtime.dispose()
  }
}

async function runBunSpawnCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "index.ts": runtimeBunRunIndexSource,
    },
  })

  try {
    const processHandle = await runtime.bun.spawn({ cmd: ["bun", "run", "index.ts"] })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ])

    if (exitCode !== 0) return fail("phase3-bun-spawn-run-index", `exit ${exitCode}`)
    if (!stdout.includes("bun run index")) return fail("phase3-bun-spawn-run-index", stdout)

    return pass("phase3-bun-spawn-run-index", `stdout=${stdout.trim()} stderr=${stderr.trim()}`)
  } finally {
    await runtime.dispose()
  }
}

async function runCryptoCase(): Promise<PlaygroundRunResult> {
  const sha256Digest = await createHashDigest("sha256", cryptoFixtureText)
  const md5Digest = await createHashDigest("md5", cryptoFixtureText)
  const hmacDigest = await createHmac("sha256", cryptoHmacKey).update(cryptoFixtureText).digest()

  if (sha256Digest !== expectedSha256Hex) return fail("phase3-crypto-hasher", String(sha256Digest))
  if (md5Digest !== expectedMd5Hex) return fail("phase3-crypto-hasher", String(md5Digest))
  if (hmacDigest !== expectedHmacSha256Hex) return fail("phase3-crypto-hasher", String(hmacDigest))

  return pass("phase3-crypto-hasher", `sha256=${sha256Digest} md5=${md5Digest} hmac=${hmacDigest} fixture=${runtimeCryptoSource.length}`)
}

async function runPasswordCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const hash = await runtime.bun.password.hash("mars-secret", {
      iterations: 1_000,
      salt: new Uint8Array(16).fill(7),
    })
    const verified = await runtime.bun.password.verify("mars-secret", hash)
    const rejected = await runtime.bun.password.verify("wrong-secret", hash)

    if (!verified || rejected) return fail("phase3-password", hash)

    return pass("phase3-password", `hash=${hash.slice(0, 28)} fixture=${runtimePasswordSource.length}`)
  } finally {
    await runtime.dispose()
  }
}

async function runSqliteCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()
  const db = runtime.bun.sql.db
  const databasePath = db.path

  try {
    await db.exec("create table if not exists notes (id integer primary key, title text, done integer)")
    await db.run("insert into notes (title, done) values (?, ?)", ["mars sqlite prework", 0])
    await db.run("update notes set title = ? where id = ?", ["mars sqlite updated", 1])
    const rows = await runtime.bun.sql`select title from notes where id = ${1}`
    await db.close()

    if (rows[0]?.title !== "mars sqlite updated") return fail("phase3-bun-sql", JSON.stringify(rows))
    if (!runtime.vfs.existsSync(databasePath)) return fail("phase3-bun-sql", "database file missing")

    return pass("phase3-bun-sql", `rows=${rows.length} path=${databasePath} fixture=${runtimeSqliteSource.length}`)
  } finally {
    await runtime.dispose()
  }
}

async function runSnapshotCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "snapshot.txt": "snapshot survives restore",
      },
    },
  })
  const restoredRuntime = await createMarsRuntime()

  try {
    const snapshot = await snapshotVFS(runtime.vfs, "/workspace")
    await restoreVFSSnapshot(restoredRuntime.vfs, snapshot, "/workspace/restored")
    const restoredText = await restoredRuntime.vfs.readFile("/workspace/restored/src/snapshot.txt", "utf8")

    if (restoredText !== "snapshot survives restore") {
      return fail("phase3-vfs-snapshot", String(restoredText))
    }

    return pass("phase3-vfs-snapshot", `restored=${restoredText} fixture=${runtimeSnapshotSource.length}`)
  } finally {
    await restoredRuntime.dispose()
    await runtime.dispose()
  }
}

async function runStdioCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()

  try {
    const processHandle = await runtime.kernel.spawn({ argv: ["stdio-fixture"] })
    const stdinReader = processHandle.stdin.getReader()

    await processHandle.write("stdin from playground")
    const stdinChunk = await stdinReader.read()
    runtime.kernel.writeStdio(processHandle.pid, 1, "stdout from kernel")
    runtime.kernel.writeStdio(processHandle.pid, 2, "stderr from kernel")
    await processHandle.kill(0)

    const stdinText = new TextDecoder().decode(stdinChunk.value)
    const [stdout, stderr] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ])

    stdinReader.releaseLock()
    if (stdinText !== "stdin from playground") return fail("phase3-kernel-stdio", stdinText)
    if (stdout !== "stdout from kernel" || stderr !== "stderr from kernel") {
      return fail("phase3-kernel-stdio", `${stdout}/${stderr}`)
    }

    return pass("phase3-kernel-stdio", `stdin/stdout/stderr fixture=${runtimeStdioSource.length}`)
  } finally {
    await runtime.dispose()
  }
}

async function runOpfsCase(): Promise<PlaygroundRunResult> {
  const adapter = createOPFSPersistenceAdapter({ fallback: "memory" })

  await adapter.open()
  try {
    await adapter.set("workspace-snapshot", "opfs fallback persists bytes")
    const stored = await adapter.get("workspace-snapshot")
    const storedText = new TextDecoder().decode(stored ?? new Uint8Array())

    if (storedText !== "opfs fallback persists bytes") return fail("phase3-opfs-persistence", storedText)

    return pass("phase3-opfs-persistence", `kind=${adapter.kind} fixture=${runtimeOpfsSource.length}`)
  } finally {
    await adapter.close()
  }
}

async function runProcessWorkerCase(): Promise<PlaygroundRunResult> {
  const factory = createMarsProcessWorkerFactory()
  const worker = await factory.create({
    argv: ["bun", "run", "worker-entry.ts"],
    onMessage: message => ({ echoed: message }),
  })
  const reader = worker.messages.getReader()

  try {
    await worker.boot()
    await reader.read()
    await worker.postMessage("hello process worker")
    const message = await reader.read()
    await worker.terminate()

    const payload = message.value as { data?: { echoed?: string } } | undefined
    if (payload?.data?.echoed !== "hello process worker") {
      return fail("phase3-process-worker-factory", JSON.stringify(message.value))
    }

    const nativeDetail = await runNativeProcessWorkerCarrierCase()

    return pass(
      "phase3-process-worker-factory",
      `native=${factory.supportsNativeWorker()} ${nativeDetail} fixture=${runtimeProcessWorkerSource.length}`,
    )
  } finally {
    reader.releaseLock()
    await worker.terminate()
  }
}

async function runNativeProcessWorkerCarrierCase(): Promise<string> {
  PlaygroundNativeProcessWorker.instances.length = 0
  const factory = createMarsProcessWorkerFactory({
    workerURL: "/mars-process-worker.js",
    workerOptions: { type: "module" },
    workerConstructor: PlaygroundNativeProcessWorker,
  })
  const worker = await factory.create({
    argv: ["bun", "run", "worker-entry.ts"],
    cwd: "/workspace",
  })
  const reader = worker.messages.getReader()

  try {
    await worker.boot()
    await reader.read()
    await worker.write("native worker input")
    await worker.postMessage("native worker message")
    const message = await reader.read()
    PlaygroundNativeProcessWorker.instances[0].dispatch({ type: "process.worker.exit", id: worker.id, code: 0 })
    const [stdout, stderr] = await Promise.all([
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
    ])
    await worker.terminate()

    const payload = message.value as { data?: { echoed?: string } } | undefined
    if (!factory.supportsNativeWorker()) throw new Error("native worker carrier unavailable")
    if (payload?.data?.echoed !== "native worker message") throw new Error(JSON.stringify(message.value))
    if (stdout !== "stdout:native worker input" || stderr !== "stderr:native worker input") {
      throw new Error(`${stdout}/${stderr}`)
    }
    if (!PlaygroundNativeProcessWorker.instances[0]?.terminated) throw new Error("native worker did not terminate")

    return `nativeCarrier=${PlaygroundNativeProcessWorker.instances[0].url}`
  } finally {
    reader.releaseLock()
    await worker.terminate()
  }
}

async function runProcessWorkerBootstrapCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      runtime: {
        "worker-config.cjs": `module.exports = { value: ${JSON.stringify(processWorkerBootstrapConfigValue)} }`,
      },
    },
  })
  const scope = new PlaygroundProcessWorkerRuntimeScope()
  const bootstrap = installProcessWorkerRuntimeBootstrap({
    scope: scope as unknown as PlaygroundProcessWorkerRuntimeScope & Record<string, unknown>,
    vfs: runtime.vfs,
    kernel: runtime.kernel,
    autoRun: false,
  })

  try {
    scope.dispatch({
      type: "process.worker.boot",
      id: "playground-process-worker-bootstrap",
      argv: processWorkerBootstrapArgv,
      cwd: processWorkerBootstrapCwd,
      env: processWorkerBootstrapEnv,
    })
    await bootstrap.idle()

    const injectedScope = scope as InjectedProcessWorkerRuntimeScope
    const config = injectedScope.require(processWorkerBootstrapRequireSpecifier) as { value?: string }
    const bootMessage = scope.messages[0] as { type?: string; id?: string; argv?: string[] } | undefined

    if (bootMessage?.type !== "boot") return fail("phase3-process-worker-bootstrap", JSON.stringify(bootMessage))
    if (injectedScope.process.cwd() !== processWorkerBootstrapCwd) {
      return fail("phase3-process-worker-bootstrap", injectedScope.process.cwd())
    }
    if (injectedScope.process.env.MARS_WORKER_CONTEXT !== processWorkerBootstrapEnv.MARS_WORKER_CONTEXT) {
      return fail("phase3-process-worker-bootstrap", JSON.stringify(injectedScope.process.env))
    }
    if (injectedScope.Bun.env.MARS_WORKER_CONTEXT !== processWorkerBootstrapEnv.MARS_WORKER_CONTEXT) {
      return fail("phase3-process-worker-bootstrap", JSON.stringify(injectedScope.Bun.env))
    }
    if (config.value !== processWorkerBootstrapConfigValue) {
      return fail("phase3-process-worker-bootstrap", JSON.stringify(config))
    }

    return pass(
      "phase3-process-worker-bootstrap",
      `argv=${injectedScope.process.argv.join(" ")} config=${config.value} fixture=${runtimeProcessWorkerBootstrapSource.length}`,
    )
  } finally {
    bootstrap.dispose()
    await runtime.dispose()
  }
}

async function runProcessWorkerScriptCase(): Promise<PlaygroundRunResult> {
  const objectURLs: string[] = []
  const script = createProcessWorkerBootstrapScript({
    cwd: processWorkerScriptCwd,
    initialFiles: {
      [processWorkerScriptEntry]: processWorkerScriptSource,
    },
  })
  const workerURL = createProcessWorkerBootstrapBlobURL({
    cwd: processWorkerScriptCwd,
    initialFiles: {
      [processWorkerScriptEntry]: processWorkerScriptSource,
    },
    scope: {
      Blob,
      URL: {
        createObjectURL: blob => {
          if (!blob.type.includes("text/javascript")) throw new Error(blob.type)
          const objectURL = `${processWorkerScriptURLPrefix}-${objectURLs.length + 1}`
          objectURLs.push(objectURL)
          return objectURL
        },
      },
    },
  })

  if (!script.includes("installProcessWorkerRuntimeBootstrap")) {
    return fail("phase3-process-worker-script", script)
  }
  if (!script.includes(processWorkerScriptEntry) || !script.includes(processWorkerScriptSource)) {
    return fail("phase3-process-worker-script", script)
  }
  if (!workerURL.startsWith(processWorkerScriptURLPrefix)) {
    return fail("phase3-process-worker-script", workerURL)
  }

  return pass(
    "phase3-process-worker-script",
    `workerURL=${workerURL} scriptBytes=${script.length} fixture=${runtimeProcessWorkerScriptSource.length}`,
  )
}

async function runRealBrowserWorkerSmokeCase(): Promise<PlaygroundRunResult> {
  if (typeof Worker !== "function") return fail("phase3-real-browser-worker-smoke", "Worker is not available")
  if (typeof Blob !== "function" || typeof URL.createObjectURL !== "function") {
    return fail("phase3-real-browser-worker-smoke", "Blob URL is not available")
  }

  const sourceRuntime = await createMarsRuntime({
    initialFiles: {
      app: {
        "placeholder.txt": "snapshot base",
      },
    },
  })
  const initialSnapshot = await snapshotVFS(sourceRuntime.vfs, processWorkerScriptCwd)

  const workerURL = createProcessWorkerBootstrapBlobURL({
    cwd: processWorkerScriptCwd,
    runtimeImport: marsPackageImportURL("mars-runtime"),
    vfsImport: marsPackageImportURL("mars-vfs"),
    kernelImport: marsPackageImportURL("mars-kernel"),
    initialSnapshot,
    snapshotRoot: processWorkerScriptCwd,
    autoRun: false,
  })
  const factory = createMarsProcessWorkerFactory({
    workerURL,
    workerOptions: { type: "module" },
    vfs: sourceRuntime.vfs,
    syncRoot: processWorkerScriptCwd,
  })
  const worker = await factory.create({
    argv: ["bun", "run", processWorkerScriptEntry],
    cwd: processWorkerScriptCwd,
  })
  const reader = worker.messages.getReader()

  try {
    await worker.boot()
    const bootMessage = await reader.read()
    await sourceRuntime.bun.write(`${processWorkerScriptCwd}/${processWorkerScriptEntry}`, processWorkerBrowserSmokeSource)
    const patchMessage = await reader.read()
    await worker.run()
    const stdout = await new Response(worker.stdout).text()

    if ((bootMessage.value as { type?: string } | undefined)?.type !== "boot") {
      return fail("phase3-real-browser-worker-smoke", JSON.stringify(bootMessage.value))
    }
    if ((patchMessage.value as { type?: string; ok?: boolean } | undefined)?.ok !== true) {
      return fail("phase3-real-browser-worker-smoke", JSON.stringify(patchMessage.value))
    }
    if (!stdout.includes(processWorkerBrowserSmokeStdout)) {
      return fail("phase3-real-browser-worker-smoke", stdout)
    }
    if (worker.status() !== "stopped") {
      return fail("phase3-real-browser-worker-smoke", `status=${worker.status()}`)
    }

    return pass("phase3-real-browser-worker-smoke", `autoPatch=ok stdout=${stdout.trim()} workerURL=${workerURL.slice(0, 16)}`)
  } finally {
    reader.releaseLock()
    await worker.terminate()
    URL.revokeObjectURL(workerURL)
    await sourceRuntime.dispose()
  }
}

function marsPackageImportURL(packageName: "mars-runtime" | "mars-vfs" | "mars-kernel"): string {
  return `/@fs${__MARS_WORKSPACE_ROOT__}packages/${packageName}/src/index.ts`
}

async function runBridgeChainCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()
  const serviceWorkerBridgePair = createMarsMemoryBridgePair()
  const serviceWorkerClientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: serviceWorkerBridgePair.left,
  })
  const serviceWorkerEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "client",
    transport: serviceWorkerBridgePair.right,
  })
  const serviceWorkerKernelBridgePair = createMarsMemoryBridgePair()
  const serviceWorkerKernelEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "kernel",
    transport: serviceWorkerKernelBridgePair.left,
  })
  const serviceWorkerKernelHostEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "sw",
    transport: serviceWorkerKernelBridgePair.right,
  })
  const serviceWorkerKernelController = createKernelWorkerController({
    endpoint: serviceWorkerKernelHostEndpoint,
    kernel: runtime.kernel,
  })
  const serviceWorkerController = createServiceWorkerBridgeController({
    endpoint: serviceWorkerEndpoint,
    router: createServiceWorkerRouter({
      kernelClient: createBridgeServiceWorkerKernelClient({
        endpoint: serviceWorkerKernelEndpoint,
      }),
      vfsClient: {
        readFile: async path => {
          if (!runtime.vfs.existsSync(path)) return null
          const data = await runtime.vfs.readFile(path)
          return typeof data === "string" ? new TextEncoder().encode(data) : data
        },
        stat: async path => runtime.vfs.existsSync(path) ? runtime.vfs.stat(path) : null,
        contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      },
      moduleClient: {
        vfs: runtime.vfs,
      },
    }),
  })
  const server = runtime.bun.serve({
    port: 0,
    fetch: request => new Response(`bridge:${new URL(request.url).pathname}`),
  })

  const kernelBridgePair = createMarsMemoryBridgePair()
  const kernelClientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: kernelBridgePair.left,
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "client",
    transport: kernelBridgePair.right,
  })
  const kernel = createMarsKernel()
  const workerStdout: string[] = []
  const stdioSubscription = kernel.on("stdio", payload => {
    if (payload.fd === 1) workerStdout.push(new TextDecoder().decode(payload.chunk))
  })
  const kernelController = createKernelWorkerController({
    endpoint: kernelEndpoint,
    kernel,
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: PlaygroundNativeProcessWorker,
    }),
  })

  try {
    await kernelClientEndpoint.request("kernel.boot", {}, { target: "kernel" })
    const fetchResponse = await serviceWorkerClientEndpoint.request(
      "sw.fetch",
      { url: `${runtime.preview(server.port)}bridge-chain` },
      { target: "sw" },
    ) as { status: number; body: string }
    const processWorker = await kernelClientEndpoint.request(
      "process.worker.create",
      { argv: ["bun", "run", "worker-entry.ts"] },
      { target: "kernel" },
    ) as { id: string; status: string }
    const processMessage = await kernelClientEndpoint.request(
      "process.worker.message",
      { id: processWorker.id, message: "bridge process" },
      { target: "kernel" },
    ) as { event?: { data?: { echoed?: string } } }
    const patchResponse = await kernelClientEndpoint.request(
      "process.worker.vfs.patch",
      { id: processWorker.id, patches: [createWriteFilePatch("/workspace/worker-entry.ts", "console.log('bridge run')")] },
      { target: "kernel" },
    ) as { event?: { ok?: boolean; count?: number } }
    const runResponse = await kernelClientEndpoint.request(
      "process.worker.run",
      { id: processWorker.id },
      { target: "kernel" },
    ) as { event?: { type?: string; code?: number } }
    const spawnedWorker = await kernelClientEndpoint.request(
      "kernel.spawn",
      { argv: ["bun", "run", "worker-entry.ts"], cwd: "/workspace", kind: "worker" },
      { target: "kernel" },
    ) as { pid: number; workerId: string; status: string }
    const spawnedNativeWorker = PlaygroundNativeProcessWorker.instances[PlaygroundNativeProcessWorker.instances.length - 1]
    spawnedNativeWorker.dispatch({
      type: "process.worker.stdout",
      id: spawnedWorker.workerId,
      chunk: "spawn worker stdout",
    })
    spawnedNativeWorker.dispatch({
      type: "process.worker.exit",
      id: spawnedWorker.workerId,
      code: 0,
    })
    const spawnedExit = await kernelClientEndpoint.request(
      "kernel.waitpid",
      { pid: spawnedWorker.pid },
      { target: "kernel" },
    ) as { exitCode: number }

    if (fetchResponse.status !== 200 || fetchResponse.body !== "bridge:/bridge-chain") {
      return fail("phase3-sw-kernel-process-bridge", `${fetchResponse.status} ${fetchResponse.body}`)
    }
    if (processWorker.status !== "running" || processMessage.event?.data?.echoed !== "bridge process") {
      return fail("phase3-sw-kernel-process-bridge", JSON.stringify(processMessage))
    }
    if (patchResponse.event?.ok !== true || patchResponse.event?.count !== 1 || runResponse.event?.type !== "process.worker.exit" || runResponse.event?.code !== 0) {
      return fail("phase3-sw-kernel-process-bridge", JSON.stringify({ patchResponse, runResponse }))
    }
    if (spawnedWorker.status !== "running" || spawnedExit.exitCode !== 0 || workerStdout.join("") !== "spawn worker stdout") {
      return fail("phase3-sw-kernel-process-bridge", JSON.stringify({ spawnedWorker, spawnedExit, workerStdout }))
    }

    return pass("phase3-sw-kernel-process-bridge", `bridge+patch+run+spawn fixture=${runtimeBridgeChainSource.length}`)
  } finally {
    server.stop()
    stdioSubscription.dispose()
    serviceWorkerController.dispose()
    serviceWorkerKernelController.dispose()
    kernelController.dispose()
    serviceWorkerClientEndpoint.close()
    serviceWorkerEndpoint.close()
    serviceWorkerKernelEndpoint.close()
    serviceWorkerKernelHostEndpoint.close()
    kernelClientEndpoint.close()
    kernelEndpoint.close()
    await runtime.dispose()
  }
}

async function runServiceWorkerRegistrationCase(): Promise<PlaygroundRunResult> {
  const container = new PlaygroundServiceWorkerContainer()
  const runtime = await createMarsRuntime({
    serviceWorkerUrl: "/mars-sw.js",
    serviceWorkerScope: "/mars/",
    serviceWorkerContainer: container,
    unregisterServiceWorkerOnDispose: true,
  })

  try {
    const connectMessage = container.controller.messages[0] as { type?: string } | undefined
    const transferCount = container.controller.transfers[0]?.length ?? 0

    if (container.registrations[0]?.scriptURL !== "/mars-sw.js") return fail("phase3-service-worker-registration", "registration missing")
    if (runtime.serviceWorker?.ready !== true) return fail("phase3-service-worker-registration", "service worker not ready")
    if (connectMessage?.type !== "sw.connect" || transferCount !== 1) {
      return fail("phase3-service-worker-registration", JSON.stringify(connectMessage))
    }

    return pass("phase3-service-worker-registration", `registered=${container.registrations.length} fixture=${runtimeServiceWorkerRegistrationSource.length}`)
  } finally {
    await runtime.dispose()
  }
}

async function runServiceWorkerBootstrapCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime()
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const scope = new PlaygroundServiceWorkerScope()
  const bridgePair = createMarsMemoryBridgePair()
  const serviceWorkerKernelEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "kernel",
    transport: bridgePair.left,
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "sw",
    transport: bridgePair.right,
  })
  const kernelController = createKernelWorkerController({ endpoint: kernelEndpoint, kernel: runtime.kernel })
  const bootstrap = installServiceWorkerBootstrap({
    scope,
    router: createServiceWorkerRouter({
      kernelClient: createBridgeServiceWorkerKernelClient({ endpoint: serviceWorkerKernelEndpoint }),
      vfsClient: {
        readFile: async path => {
          if (!runtime.vfs.existsSync(path)) return null
          const data = await runtime.vfs.readFile(path)
          return typeof data === "string" ? new TextEncoder().encode(data) : data
        },
        stat: async path => runtime.vfs.existsSync(path) ? runtime.vfs.stat(path) : null,
        contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      },
      moduleClient: {
        vfs: runtime.vfs,
      },
    }),
  })
  const server = runtime.bun.serve({
    port: 0,
    fetch: request => new Response(`bootstrap:${new URL(request.url).pathname}`),
  })

  try {
    scope.dispatchMessage({
      data: {
        id: "mars-sw-connect-playground",
        type: "sw.connect",
        source: "client",
        target: "sw",
        payload: { scriptURL: "/mars-sw.js" },
      },
      ports: [channel.port2],
    })
    const response = await clientEndpoint.request(
      "sw.fetch",
      { url: `${runtime.preview(server.port)}bootstrap` },
      { target: "sw" },
    ) as { status: number; body: string }
    const eventResponse = await scope.dispatchFetch(new Request(`${runtime.preview(server.port)}event-bootstrap`))

    if (response.body !== "bootstrap:/bootstrap") return fail("phase3-service-worker-bootstrap", response.body)
    if (await eventResponse.text() !== "bootstrap:/event-bootstrap") return fail("phase3-service-worker-bootstrap", "fetch event missing")

    return pass("phase3-service-worker-bootstrap", `clients=${bootstrap.clients.length} fixture=${runtimeServiceWorkerBootstrapSource.length}`)
  } finally {
    server.stop()
    bootstrap.dispose()
    kernelController.dispose()
    clientEndpoint.close()
    serviceWorkerKernelEndpoint.close()
    kernelEndpoint.close()
    channel.port1.close()
    await runtime.dispose()
  }
}

async function runServiceWorkerModuleResponseCase(): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "service-worker-module-response.ts": [
          runtimeServiceWorkerModuleResponseSource,
          "import { packageMessage } from 'mars-sw-package'",
          "export const serviceWorkerPackageEntry = `pkg:${packageMessage}`",
        ].join("\n"),
        "service-worker-module-response-message.ts": runtimeServiceWorkerModuleResponseMessageSource,
      },
      node_modules: {
        "mars-sw-package": {
          "package.json": JSON.stringify({ name: "mars-sw-package", module: "index.ts" }),
          "index.ts": "export const packageMessage = 'playground bare package'",
        },
      },
    },
  })
  const router = createServiceWorkerRouter({
    kernelClient: {
      resolvePort: async () => null,
      dispatchToKernel: async () => new Response("unexpected kernel dispatch", { status: 500 }),
    },
    vfsClient: {
      readFile: async path => {
        if (!runtime.vfs.existsSync(path)) return null
        const data = await runtime.vfs.readFile(path)
        return typeof data === "string" ? new TextEncoder().encode(data) : data
      },
      stat: async path => runtime.vfs.existsSync(path) ? runtime.vfs.stat(path) : null,
      contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    },
    moduleClient: {
      vfs: runtime.vfs,
    },
  })

  try {
    const entryUrl = "/src/service-worker-module-response.ts"
    const entryResponse = await router.fetch(new Request(`https://app.localhost${entryUrl}`))
    const entryCode = await entryResponse.text()
    const moduleUrls = JSON.parse(entryResponse.headers.get("x-mars-module-urls") ?? "[]") as string[]
    const dependencyUrl = moduleUrls.find(url => url.includes("service-worker-module-response-message.ts"))
    const packageUrl = moduleUrls.find(url => url.includes("node_modules%2Fmars-sw-package%2Findex.ts"))

    if (entryResponse.status !== 200) return fail("phase3-service-worker-module-response", `entry ${entryResponse.status}`)
    if (!entryCode.includes("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fservice-worker-module-response-message.ts")) {
      return fail("phase3-service-worker-module-response", entryCode)
    }
    if (!dependencyUrl) return fail("phase3-service-worker-module-response", JSON.stringify(moduleUrls))
    if (!packageUrl) return fail("phase3-service-worker-module-response", JSON.stringify(moduleUrls))

    const dependencyResponse = await router.fetch(new Request(`https://app.localhost${dependencyUrl}`))
    const dependencyCode = await dependencyResponse.text()
    const packageResponse = await router.fetch(new Request(`https://app.localhost${packageUrl}`))
    const packageCode = await packageResponse.text()

    if (dependencyResponse.status !== 200 || !dependencyCode.includes("moduleMessage")) {
      return fail("phase3-service-worker-module-response", `${dependencyResponse.status} ${dependencyCode}`)
    }
    if (packageResponse.status !== 200 || !packageCode.includes("packageMessage")) {
      return fail("phase3-service-worker-module-response", `${packageResponse.status} ${packageCode}`)
    }

    return pass("phase3-service-worker-module-response", `native=${entryUrl} modules=${moduleUrls.length} bare=ok fixture=${runtimeServiceWorkerModuleResponseSource.length}`)
  } finally {
    await runtime.dispose()
  }
}

async function runServiceWorkerScopeSmokeCase(): Promise<PlaygroundRunResult> {
  if (!globalThis.navigator?.serviceWorker) {
    return fail("phase3-service-worker-scope-smoke", "navigator.serviceWorker is not available")
  }

  const runtime = await createMarsRuntime({
    serviceWorkerUrl: serviceWorkerScopeSmokeScriptURL,
    serviceWorkerScope: serviceWorkerScopeSmokeScope,
  })

  try {
    const serviceWorker = runtime.serviceWorker
    if (!serviceWorker?.ready) return fail("phase3-service-worker-scope-smoke", "service worker not ready")

    await runtime.bun.write(
      serviceWorkerScopeSmokeEntry,
      `export const serviceWorkerScopeSmokeEntry = 'scope:${serviceWorkerScopeSmokePatchedMessage}'`,
    )
    await runtime.flushServiceWorkerVFS()

    const response = await serviceWorker.endpoint.request(
      "sw.fetch",
      { url: `${globalThis.location.origin}${moduleUrlFromPath(serviceWorkerScopeSmokeEntry)}` },
      { target: "sw" },
    ) as { status: number; headers: Record<string, string>; body: string }

    if (response.status !== 200) return fail("phase3-service-worker-scope-smoke", `status=${response.status}`)
    if (response.headers["x-mars-module-path"] !== serviceWorkerScopeSmokeEntry) {
      return fail("phase3-service-worker-scope-smoke", JSON.stringify(response.headers))
    }
    if (!response.body.includes(serviceWorkerScopeSmokePatchedMessage)) {
      return fail("phase3-service-worker-scope-smoke", response.body)
    }

    return pass(
      "phase3-service-worker-scope-smoke",
      `module=${response.headers["x-mars-module-path"]} mode=auto-${serviceWorkerScopeSmokePatchMode} fixture=${runtimeServiceWorkerScopeSmokeSource.length}`,
    )
  } finally {
    await runtime.dispose()
  }
}

async function runPlaygroundHostRuntimeCase(): Promise<PlaygroundRunResult> {
  const status = await ensurePlaygroundRuntimeStatus()

  if (!status.secureContext) {
    return fail("phase3-playground-host-runtime", JSON.stringify(status))
  }
  if (playgroundHostRequiresCrossOriginIsolation && !status.crossOriginIsolated) {
    return fail("phase3-playground-host-runtime", JSON.stringify(status))
  }
  if (playgroundHostRequiresSharedArrayBuffer && !status.sharedArrayBuffer) {
    return fail("phase3-playground-host-runtime", JSON.stringify(status))
  }
  if (!status.serviceWorkerReady) {
    return fail("phase3-playground-host-runtime", JSON.stringify(status))
  }

  return pass(
    "phase3-playground-host-runtime",
    `sab=${status.sharedArrayBuffer} isolated=${status.crossOriginIsolated} sw=${status.serviceWorkerReady} controlled=${status.serviceWorkerControlled} fixture=${runtimePlaygroundHostSource.length}`,
  )
}

async function runKernelWorkerBootstrapCase(): Promise<PlaygroundRunResult> {
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const scope = new PlaygroundKernelWorkerScope()
  const kernel = createMarsKernel()
  const bootstrap = installKernelWorkerBootstrap({ scope, kernel })

  try {
    scope.dispatchMessage({
      data: {
        id: "mars-kernel-connect-playground",
        type: "kernel.connect",
        source: "client",
        target: "kernel",
        payload: { workerURL: "/mars-kernel-worker.js" },
      },
      ports: [channel.port2],
    })
    const booted = await clientEndpoint.request("kernel.boot", {}, { target: "kernel" }) as { booted: boolean }
    const processWorker = await clientEndpoint.request(
      "process.worker.create",
      { argv: ["bun", "run", "worker-entry.ts"] },
      { target: "kernel" },
    ) as { id: string; status: string }

    if (!booted.booted) return fail("phase3-kernel-worker-bootstrap", "kernel did not boot")
    if (processWorker.status !== "running") return fail("phase3-kernel-worker-bootstrap", JSON.stringify(processWorker))

    await clientEndpoint.request(
      "process.worker.terminate",
      { id: processWorker.id },
      { target: "kernel" },
    )

    const nativeDetail = await runNativeKernelWorkerCarrierCase()

    return pass("phase3-kernel-worker-bootstrap", `clients=${bootstrap.clients.length} ${nativeDetail} fixture=${runtimeKernelWorkerBootstrapSource.length}`)
  } finally {
    bootstrap.dispose()
    clientEndpoint.close()
    channel.port1.close()
  }
}

async function runNativeKernelWorkerCarrierCase(): Promise<string> {
  PlaygroundKernelCarrierWorker.instances.length = 0
  const scope = new PlaygroundKernelWorkerScope()
  const kernel = createMarsKernel()
  const bootstrap = installKernelWorkerBootstrap({ scope, kernel })
  PlaygroundKernelCarrierWorker.scope = scope
  const client = connectMarsKernelWorker({
    workerURL: "/mars-kernel-worker.js",
    workerOptions: { type: "module" },
    workerConstructor: PlaygroundKernelCarrierWorker,
  })

  try {
    const booted = await client.endpoint.request("kernel.boot", {}, { target: "kernel" }) as { booted: boolean }
    const processWorker = await client.endpoint.request(
      "process.worker.create",
      { argv: ["bun", "run", "worker-entry.ts"] },
      { target: "kernel" },
    ) as { id: string; status: string }

    if (!supportsKernelWorkerClient({ workerConstructor: PlaygroundKernelCarrierWorker })) throw new Error("kernel worker carrier unavailable")
    if (!booted.booted) throw new Error("native kernel worker did not boot")
    if (processWorker.status !== "running") throw new Error(JSON.stringify(processWorker))

    await client.endpoint.request(
      "process.worker.terminate",
      { id: processWorker.id },
      { target: "kernel" },
    )
    client.close()

    if (!PlaygroundKernelCarrierWorker.instances[0]?.terminated) throw new Error("native kernel worker did not terminate")

    return `nativeCarrier=${PlaygroundKernelCarrierWorker.instances[0].url}`
  } finally {
    client.close()
    bootstrap.dispose()
    PlaygroundKernelCarrierWorker.scope = null
  }
}

async function runInstallerCase(id: string): Promise<PlaygroundRunResult> {
  const runtime = await createMarsRuntime({
    packageCache: createPlaygroundPackageCache(),
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
    await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
      dependencies: moduleNamespace.dependencies,
    }))
    const result = await runtime.shell.run("bun install")
    if (result.code !== 0) return fail(id, result.stderr)

    return pass(id, result.stdout.trim())
  } finally {
    await runtime.dispose()
  }
}

async function runInstallerRegistryFetchCase(): Promise<PlaygroundRunResult> {
  const fetchedUrls: string[] = []
  const runtime = await createMarsRuntime({
    packageRegistryClient: createNpmRegistryClient({
      registry: "https://registry.mars.test",
      fetch: async input => {
        const url = String(input)
        fetchedUrls.push(url)
        if (url === "https://registry.mars.test/playground-registry-demo") {
          return Response.json({
            name: "playground-registry-demo",
            "dist-tags": { latest: "0.2.0" },
            versions: {
              "0.2.0": {
                version: "0.2.0",
                files: {
                  "index.js": "module.exports = { playground: true }",
                },
              },
            },
          })
        }

        return new Response("not found", { status: 404 })
      },
    }),
  })

  try {
    await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
      dependencies: {
        "playground-registry-demo": "latest",
      },
    }))
    const result = await runtime.shell.run("bun install")
    if (result.code !== 0) return fail("phase2-installer-registry-fetch", result.stderr)

    const installed = await runtime.vfs.readFile("/workspace/node_modules/playground-registry-demo/index.js", "utf8")
    if (!String(installed).includes("playground: true")) return fail("phase2-installer-registry-fetch", String(installed))
    if (fetchedUrls.join(",") !== "https://registry.mars.test/playground-registry-demo") {
      return fail("phase2-installer-registry-fetch", fetchedUrls.join(","))
    }

    return pass("phase2-installer-registry-fetch", result.stdout.trim())
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
