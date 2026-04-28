import { expect, test } from "bun:test"

import { buildProject } from "@mars/bundler"
import { createMarsBridgeEndpoint, createMarsMemoryBridgePair, createMarsPostMessageBridgeTransport } from "@mars/bridge"
import { createMarsRuntime } from "@mars/client"
import { MarsCryptoHasher, createHashDigest, marsPassword } from "@mars/crypto"
import { connectMarsKernelWorker, createKernelWorkerController, createMarsKernel, createMarsProcessWorkerFactory, detectMarsCapabilities, installKernelWorkerBootstrap, supportsKernelWorkerClient } from "@mars/kernel"
import type { KernelWorkerMessageEvent, ProcessHandle, WorkerLike } from "@mars/kernel"
import { createHash, createHmac, createCipheriv, createDecipheriv, createSign, createVerify, getCiphers, getCurves, getHashes, hkdfAsync, pbkdf2Async, randomBytes, randomUUID, timingSafeEqual } from "@mars/node"
import { createMarsBun, createProcessWorkerBootstrapBlobURL, createProcessWorkerBootstrapScript, getBunApiCompat, installProcessWorkerRuntimeBootstrap } from "@mars/runtime"
import { createWebSocketPair, upgradeToWebSocket } from "@mars/runtime"
import { classifyRequest, createBridgeServiceWorkerKernelClient, createServiceWorkerBridgeController, createServiceWorkerRouter, handleWebSocketRoute, installServiceWorkerBootstrap, installServiceWorkerFetchHandler, moduleUrlFromPath } from "@mars/sw"
import type { MarsServiceWorkerContainer, MarsServiceWorkerController, MarsServiceWorkerMessageEvent, MarsServiceWorkerRegistration, MarsServiceWorkerRegistrationOptions } from "@mars/sw"
import { createBrowserAutomationProfiles, createBrowserAutomationRunPlan, createBrowserTestProfiles, createBunSpawnBrowserAutomationExecutor, runBrowserAutomationPlan } from "@mars/test"
import type { ShellCommand } from "@mars/shell"
import { createMarsVFS, createOPFSPersistenceAdapter, createWriteFilePatch, restoreVFSSnapshot, snapshotVFS } from "@mars/vfs"
import {
  loadPlaygroundFiles,
  loadPlaygroundModuleCases,
  readPlaygroundCaseEntry,
  readPlaygroundText,
} from "../../../playground/src/node-runtime"
import packageJson from "../../../package.json"

class MarsTestFetchEvent extends Event {
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

class MarsTestServiceWorkerController implements MarsServiceWorkerController {
  messages: unknown[] = []
  transfers: Transferable[][] = []

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push(transfer)
  }
}

class MarsTestServiceWorkerRegistration implements MarsServiceWorkerRegistration {
  readonly active: MarsTestServiceWorkerController
  unregistered = false

  constructor(active: MarsTestServiceWorkerController) {
    this.active = active
  }

  async unregister(): Promise<boolean> {
    this.unregistered = true
    return true
  }
}

class MarsTestServiceWorkerContainer implements MarsServiceWorkerContainer {
  readonly controller: MarsTestServiceWorkerController
  readonly registration: MarsTestServiceWorkerRegistration
  registrations: Array<{ scriptURL: string | URL; options?: MarsServiceWorkerRegistrationOptions }> = []
  readonly ready: Promise<MarsServiceWorkerRegistration>

  constructor() {
    this.controller = new MarsTestServiceWorkerController()
    this.registration = new MarsTestServiceWorkerRegistration(this.controller)
    this.ready = Promise.resolve(this.registration)
  }

  async register(scriptURL: string | URL, options?: MarsServiceWorkerRegistrationOptions): Promise<MarsServiceWorkerRegistration> {
    this.registrations.push({ scriptURL, options })
    return this.registration
  }
}

class MarsTestServiceWorkerScope {
  readonly #eventTarget = new EventTarget()

  addEventListener(type: "fetch", listener: (event: MarsTestFetchEvent) => void): void
  addEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
  addEventListener(
    type: "fetch" | "message",
    listener: ((event: MarsTestFetchEvent) => void) | ((event: MarsServiceWorkerMessageEvent) => void),
  ): void {
    this.#eventTarget.addEventListener(type, listener as unknown as EventListener)
  }

  removeEventListener(type: "fetch", listener: (event: MarsTestFetchEvent) => void): void
  removeEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
  removeEventListener(
    type: "fetch" | "message",
    listener: ((event: MarsTestFetchEvent) => void) | ((event: MarsServiceWorkerMessageEvent) => void),
  ): void {
    this.#eventTarget.removeEventListener(type, listener as unknown as EventListener)
  }

  dispatchFetch(event: MarsTestFetchEvent): boolean {
    return this.#eventTarget.dispatchEvent(event)
  }

  dispatchMessage(event: MarsServiceWorkerMessageEvent): void {
    this.#eventTarget.dispatchEvent(new MessageEvent("message", {
      data: event.data,
      ports: [...(event.ports ?? [])],
    }))
  }
}

class MarsTestKernelWorkerScope {
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

class MarsTestNativeWorker implements WorkerLike {
  static instances: MarsTestNativeWorker[] = []
  readonly url: string | URL
  readonly options: WorkerOptions | undefined
  readonly messages: unknown[] = []
  terminated = false
  readonly #eventTarget = new EventTarget()

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url
    this.options = options
    MarsTestNativeWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    const payload = message as { type?: string; id?: string; argv?: string[]; data?: unknown; chunk?: string | Uint8Array; patches?: unknown[] }

    if (payload.type === "process.worker.boot") {
      this.dispatch({ type: "boot", id: payload.id, argv: payload.argv })
    } else if (payload.type === "process.worker.message") {
      this.dispatch({ type: "message", id: payload.id, data: { echoed: payload.data } })
    } else if (payload.type === "process.worker.stdin") {
      const stdinText = payload.chunk instanceof Uint8Array
        ? new TextDecoder().decode(payload.chunk)
        : payload.chunk ?? ""
      this.dispatch({ type: "process.worker.stdout", id: payload.id, chunk: `stdout:${stdinText}` })
      this.dispatch({ type: "process.worker.stderr", id: payload.id, chunk: `stderr:${stdinText}` })
    } else if (payload.type === "process.worker.vfs.patch") {
      this.dispatch({ type: "process.worker.vfs.patch", id: payload.id, ok: true, count: payload.patches?.length ?? 0 })
    } else if (payload.type === "process.worker.run") {
      this.dispatch({ type: "process.worker.stdout", id: payload.id, chunk: "run worker stdout" })
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

async function waitForMarsTestNativeWorker(): Promise<MarsTestNativeWorker> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const worker = MarsTestNativeWorker.instances[0]
    if (worker) return worker

    await Promise.resolve()
  }

  throw new Error("Expected MarsTestNativeWorker to be created")
}

async function waitForMarsTestNativeWorkerMessages(
  worker: MarsTestNativeWorker,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (worker.messages.length >= count) return

    await Promise.resolve()
  }

  throw new Error(`Expected ${count} worker messages, received ${worker.messages.length}`)
}

class MarsTestKernelCarrierWorker implements WorkerLike {
  static instances: MarsTestKernelCarrierWorker[] = []
  static scope: MarsTestKernelWorkerScope | null = null
  readonly url: string | URL
  readonly options: WorkerOptions | undefined
  readonly messages: unknown[] = []
  readonly transfers: Transferable[][] = []
  terminated = false
  readonly #eventTarget = new EventTarget()

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url
    this.options = options
    MarsTestKernelCarrierWorker.instances.push(this)
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push(transfer)
    const payload = message as { type?: string } | undefined

    if (payload?.type === "kernel.connect") {
      MarsTestKernelCarrierWorker.scope?.dispatchMessage({
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

class MarsTestProcessWorkerRuntimeScope {
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

interface MarsTestInjectedProcessWorkerRuntimeScope extends MarsTestProcessWorkerRuntimeScope {
  process: {
    argv: string[]
    env: Record<string, string>
    cwd(): string
  }
  Bun: {
    env: Record<string, string>
  }
  require(specifier: string): unknown
}

test("Phase 3 Bun.build writes transformed output to MarsVFS", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "app.ts": "export const label: string = __MARS_LABEL__",
      },
    },
  })

  const result = await buildProject({
    vfs: runtime.vfs,
    entrypoints: ["src/app.ts"],
    outdir: "dist",
    define: {
      __MARS_LABEL__: '"phase3"',
    },
  })

  expect(result.success).toBe(true)
  expect(result.outputs.map(output => output.path)).toEqual(["/workspace/dist/app.js"])
  expect(await result.outputs[0].text()).toContain('"phase3"')
  expect(await runtime.vfs.readFile("/workspace/dist/app.js", "utf8")).toContain('"phase3"')

  await runtime.dispose()
})

test("Phase 3 Bun.build writes external source map output to MarsVFS", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "mapped.ts": "export const mapped: string = 'source map'",
      },
    },
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/mapped.ts"],
    outfile: "dist/mapped.js",
    sourcemap: true,
  })
  const output = String(await runtime.vfs.readFile("dist/mapped.js", "utf8"))
  const sourceMap = JSON.parse(String(await runtime.vfs.readFile("dist/mapped.js.map", "utf8"))) as {
    version?: number
    sources?: string[]
  }

  expect(result.success).toBe(true)
  expect(result.outputs.map(artifact => artifact.path)).toEqual([
    "/workspace/dist/mapped.js",
    "/workspace/dist/mapped.js.map",
  ])
  expect(result.outputs[1].kind).toBe("source-map")
  expect(await result.outputs[1].text()).toContain("mapped.ts")
  expect(output).toContain("sourceMappingURL=mapped.js.map")
  expect(sourceMap.version).toBe(3)
  expect(sourceMap.sources?.some(source => source.includes("mapped.ts"))).toBe(true)

  await runtime.dispose()
})

test("Phase 3 Bun.build minifies output when requested", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "minify.ts": [
          "const label: string = 'phase3 minify'",
          "const value: number = 1 + 2",
          "console.log(label, value)",
        ].join("\n"),
      },
    },
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/minify.ts"],
    outfile: "dist/minify.js",
    minify: true,
  })
  const output = String(await runtime.vfs.readFile("dist/minify.js", "utf8"))

  expect(result.success).toBe(true)
  expect(result.outputs[0].path).toBe("/workspace/dist/minify.js")
  expect(output).toContain("phase3 minify")
  expect(output).toContain("console.log")
  expect(output.length < 80).toBe(true)
  expect(output).not.toContain("const label")

  await runtime.dispose()
})

test("Phase 3 Bun facade version follows package version", async () => {
  const runtime = await createMarsRuntime()

  expect(runtime.bun.version).toBe(packageJson.version)

  await runtime.dispose()
})

test("Phase 3 runtime Bun.build facade builds TSX entry", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "main.tsx": "export const view = <main>{'runtime build'}</main>",
      },
    },
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/main.tsx"],
    outfile: "build/main.js",
    format: "iife",
  })
  const output = String(await runtime.vfs.readFile("/workspace/build/main.js", "utf8"))

  expect(result.success).toBe(true)
  expect(result.outputs[0].path).toBe("/workspace/build/main.js")
  expect(output).toContain("(() => {")
  expect(output).toContain("__mars_jsx")
  expect(output).toContain("runtime build")

  await runtime.dispose()
})

test("Phase 3 compatibility matrix tracks Bun.build", () => {
  expect(getBunApiCompat("Bun.build")).toEqual({
    api: "Bun.build",
    status: "partial",
    phase: "M3",
    notes: "Single or multi-entry esbuild-wasm transform output, minify output, external source map artifacts and SHA-256 artifact hash metadata can be written to MarsVFS; full dependency bundling and splitting are pending.",
    tests: [
      "Phase 3 Bun.build writes transformed output to MarsVFS",
      "Phase 3 Bun.build writes external source map output to MarsVFS",
      "Phase 3 Bun.build minifies output when requested",
      "Phase 3 Bun.build output artifacts include hash field",
    ],
  })
})

test("Phase 3 compatibility matrix tracks bun run", () => {
  expect(getBunApiCompat("bun run")).toEqual({
    api: "bun run",
    status: "partial",
    phase: "M3",
    notes: "MarsShell, runtime.spawn and Bun.spawn can dispatch bun run <entry> through the current in-memory Kernel pid fallback or a configured native Process Worker factory, and bun run <script> can execute package.json scripts through MarsShell with pre<script>/post<script> lifecycle hooks, forwarded arguments, npm_lifecycle_* / npm_package_* env, and node_modules/.bin PATH lookup; real ServiceWorker module interception is pending.",
    tests: [
      "Phase 3 shell bun run executes index.ts through kernel stdio",
      "Phase 3 shell bun run can execute through configured Process Worker",
      "Phase 3 runtime.spawn can execute bun run through configured Process Worker",
      "Phase 3 bun run package scripts execute through shell and spawn entrypoints",
    ],
  })
})

test("Phase 3 compatibility matrix tracks Bun.spawn", () => {
  expect(getBunApiCompat("Bun.spawn")).toEqual({
    api: "Bun.spawn",
    status: "partial",
    phase: "M3",
    notes: "Bun.spawn({ cmd }) and runtime.spawn() can execute bun run <entry> through the current in-memory Kernel pid fallback or a configured native Process Worker factory, can forward ProcessHandle stdin writes and explicit close to the worker carrier, close initial stdin streams, execute generic shell commands through the shell dispatch path, and pipe initial stdin into shell built-ins such as cat; full streaming backpressure parity is pending.",
    tests: [
      "Phase 3 Bun.spawn executes bun run index.ts through kernel stdio",
      "Phase 3 runtime.spawn can execute bun run through configured Process Worker",
      "Phase 3 Bun.spawn can execute bun run through configured Process Worker",
      "Phase 3 configured Process Worker spawn forwards ProcessHandle stdin",
      "Phase 3 configured Process Worker spawn forwards ProcessHandle closeStdin",
      "Phase 3 configured Process Worker spawn forwards initial stdin",
      "Phase 3 configured Process Worker spawn forwards initial stdin stream",
      "Phase 3 configured Process Worker spawn closes initial stdin stream",
      "Phase 3 Bun.spawn executes general shell command through kernel stdio",
      "Phase 3 runtime.spawn executes general shell command through kernel stdio",
      "Phase 3 Bun.spawn and runtime.spawn pipe initial stdin into shell command",
    ],
  })
})

test("Phase 3 compatibility matrix tracks spawnSync and crypto prework", () => {
  expect(getBunApiCompat("Bun.spawnSync")?.status).toBe("partial")
  expect(getBunApiCompat("Bun.CryptoHasher")?.status).toBe("partial")
  expect(getBunApiCompat("Bun.password")?.status).toBe("partial")
  expect(getBunApiCompat("node:crypto")?.status).toBe("partial")
  expect(getBunApiCompat("Bun.sql")?.status).toBe("partial")
})

test("Phase 3 kernel stdio bridge supports stdin writes and mirrored output", async () => {
  const runtime = await createMarsRuntime()
  const mirroredStdout: string[] = []
  const stdoutMirror = new WritableStream<Uint8Array>({
    write: chunk => {
      mirroredStdout.push(new TextDecoder().decode(chunk))
    },
  })

  const processHandle = await runtime.kernel.spawn({
    argv: ["stdio-fixture"],
    stdout: stdoutMirror,
  })
  const stdinReader = processHandle.stdin.getReader()

  await processHandle.write("stdin chunk")
  const stdinChunk = await stdinReader.read()
  runtime.kernel.writeStdio(processHandle.pid, 1, "stdout chunk")
  runtime.kernel.writeStdio(processHandle.pid, 2, "stderr chunk")
  await processHandle.kill(0)

  expect(new TextDecoder().decode(stdinChunk.value)).toBe("stdin chunk")
  expect(await new Response(processHandle.stdout).text()).toBe("stdout chunk")
  expect(await new Response(processHandle.stderr).text()).toBe("stderr chunk")
  expect(mirroredStdout.join("")).toBe("stdout chunk")
  expect(await processHandle.exited).toBe(0)

  stdinReader.releaseLock()
  await runtime.dispose()
})

test("Phase 3 process worker factory provides controlled in-memory worker prework", async () => {
  const factory = createMarsProcessWorkerFactory()
  const worker = await factory.create({
    argv: ["bun", "run", "worker-entry.ts"],
    onMessage: message => ({ echoed: message }),
  })
  const reader = worker.messages.getReader()

  await worker.boot()
  const bootMessage = await reader.read()
  await worker.postMessage("hello worker")
  const workerMessage = await reader.read()
  await worker.terminate()
  const stoppedMessage = await reader.read()

  expect(factory.supportsNativeWorker()).toBe(false)
  expect(worker.status()).toBe("stopped")
  expect(bootMessage.value).toEqual({
    type: "boot",
    id: "process-worker-1",
    argv: ["bun", "run", "worker-entry.ts"],
  })
  expect(workerMessage.value).toEqual({
    type: "message",
    id: "process-worker-1",
    data: { echoed: "hello worker" },
  })
  expect(stoppedMessage.done).toBe(true)

  reader.releaseLock()
})

test("Phase 3 process worker factory can carry lifecycle over native Worker", async () => {
  MarsTestNativeWorker.instances.length = 0
  const factory = createMarsProcessWorkerFactory({
    workerURL: "/mars-process-worker.js",
    workerOptions: { type: "module" },
    workerConstructor: MarsTestNativeWorker,
  })
  const worker = await factory.create({
    argv: ["bun", "run", "worker-entry.ts"],
    cwd: "/workspace",
    env: { MARS: "1" },
  })
  const reader = worker.messages.getReader()

  await worker.boot()
  const bootMessage = await reader.read()
  await worker.write("native input")
  await worker.postMessage("native worker message")
  const workerMessage = await reader.read()
  MarsTestNativeWorker.instances[0].dispatch({ type: "process.worker.exit", id: worker.id, code: 0 })
  const [stdout, stderr] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ])
  await worker.terminate()

  expect(factory.supportsNativeWorker()).toBe(true)
  expect(MarsTestNativeWorker.instances[0].url).toBe("/mars-process-worker.js")
  expect(MarsTestNativeWorker.instances[0].options).toEqual({ type: "module" })
  expect(MarsTestNativeWorker.instances[0].messages[0]).toEqual({
    type: "process.worker.boot",
    id: worker.id,
    argv: ["bun", "run", "worker-entry.ts"],
    cwd: "/workspace",
    env: { MARS: "1" },
  })
  expect(bootMessage.value).toEqual({
    type: "boot",
    id: worker.id,
    argv: ["bun", "run", "worker-entry.ts"],
  })
  expect(workerMessage.value).toEqual({
    type: "message",
    id: worker.id,
    data: { echoed: "native worker message" },
  })
  expect(stdout).toBe("stdout:native input")
  expect(stderr).toBe("stderr:native input")
  expect(MarsTestNativeWorker.instances[0].terminated).toBe(true)

  reader.releaseLock()
})

test("Phase 3 process worker factory auto-fans out VFS writes", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime()
  const factory = createMarsProcessWorkerFactory({
    workerURL: "/mars-process-worker.js",
    workerOptions: { type: "module" },
    workerConstructor: MarsTestNativeWorker,
    vfs: runtime.vfs,
  })
  const worker = await factory.create({
    argv: ["bun", "run", "worker-entry.ts"],
    cwd: "/workspace",
  })
  const reader = worker.messages.getReader()

  await worker.boot()
  await reader.read()
  await runtime.bun.write("/workspace/worker-entry.ts", "console.log('auto worker fanout')")
  const patchMessage = await reader.read()
  await worker.terminate()

  const workerPatchMessage = MarsTestNativeWorker.instances[0].messages.find(message => {
    const payload = message as { type?: string; patches?: unknown[] } | undefined
    return payload?.type === "process.worker.vfs.patch" && payload.patches?.length === 1
  }) as { patches: Array<{ op?: string; path?: string }> } | undefined

  expect(patchMessage.value).toEqual({
    type: "process.worker.vfs.patch",
    id: worker.id,
    ok: true,
    count: 1,
  })
  expect(workerPatchMessage?.patches[0]).toEqual({
    op: "writeFile",
    path: "/workspace/worker-entry.ts",
    data: {
      data: "Y29uc29sZS5sb2coJ2F1dG8gd29ya2VyIGZhbm91dCcp",
      encoding: "base64",
    },
  })

  reader.releaseLock()
  await runtime.dispose()
})

test("Phase 3 bridge carries client fetch requests through ServiceWorker and Kernel", async () => {
  const runtime = await createMarsRuntime()
  const clientServiceWorkerBridgePair = createMarsMemoryBridgePair()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: clientServiceWorkerBridgePair.left,
  })
  const serviceWorkerEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "client",
    transport: clientServiceWorkerBridgePair.right,
  })
  const serviceWorkerKernelBridgePair = createMarsMemoryBridgePair()
  const serviceWorkerKernelEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "kernel",
    transport: serviceWorkerKernelBridgePair.left,
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "sw",
    transport: serviceWorkerKernelBridgePair.right,
  })
  const kernelController = createKernelWorkerController({
    endpoint: kernelEndpoint,
    kernel: runtime.kernel,
  })
  const controller = createServiceWorkerBridgeController({
    endpoint: serviceWorkerEndpoint,
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
    fetch: request => new Response(`bridge:${new URL(request.url).pathname}`),
  })

  const response = await clientEndpoint.request(
    "sw.fetch",
    { url: `${runtime.preview(server.port)}bridge` },
    { target: "sw" },
  ) as { status: number; body: string }

  expect(response.status).toBe(200)
  expect(response.body).toBe("bridge:/bridge")

  server.stop()
  controller.dispose()
  kernelController.dispose()
  clientEndpoint.close()
  serviceWorkerEndpoint.close()
  serviceWorkerKernelEndpoint.close()
  kernelEndpoint.close()
  await runtime.dispose()
})

test("Phase 3 postMessage transport carries Kernel Worker RPC over MessageChannel", async () => {
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "client",
    transport: createMarsPostMessageBridgeTransport(channel.port2),
  })
  const kernel = createMarsKernel()
  const controller = createKernelWorkerController({ endpoint: kernelEndpoint, kernel })

  expect(await clientEndpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })

  controller.dispose()
  clientEndpoint.close()
  kernelEndpoint.close()
  channel.port1.close()
  channel.port2.close()
})

test("Phase 3 ServiceWorker fetch event dispatches through Kernel bridge", async () => {
  const runtime = await createMarsRuntime()
  const bridgePair = createMarsMemoryBridgePair()
  const serviceWorkerEndpoint = createMarsBridgeEndpoint({
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
  const router = createServiceWorkerRouter({
    kernelClient: createBridgeServiceWorkerKernelClient({ endpoint: serviceWorkerEndpoint }),
    vfsClient: {
      readFile: async path => {
        if (!runtime.vfs.existsSync(path)) return null
        const data = await runtime.vfs.readFile(path)
        return typeof data === "string" ? new TextEncoder().encode(data) : data
      },
      stat: async path => runtime.vfs.existsSync(path) ? runtime.vfs.stat(path) : null,
      contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    },
  })
  const eventTarget = new EventTarget()
  const scope = {
    addEventListener: (type: "fetch", listener: (event: MarsTestFetchEvent) => void) => {
      eventTarget.addEventListener(type, listener as EventListener)
    },
    removeEventListener: (type: "fetch", listener: (event: MarsTestFetchEvent) => void) => {
      eventTarget.removeEventListener(type, listener as EventListener)
    },
  }
  const fetchHandler = installServiceWorkerFetchHandler(scope, router)
  const server = runtime.bun.serve({
    port: 0,
    fetch: request => new Response(`fetch-event:${new URL(request.url).pathname}`),
  })
  const fetchEvent = new MarsTestFetchEvent(new Request(`${runtime.preview(server.port)}event`))

  eventTarget.dispatchEvent(fetchEvent)
  const response = await fetchEvent.response

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("fetch-event:/event")

  server.stop()
  fetchHandler.dispose()
  kernelController.dispose()
  serviceWorkerEndpoint.close()
  kernelEndpoint.close()
  await runtime.dispose()
})

test("Phase 3 ServiceWorker module response serves ESM module graph", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.ts": [
          "import { message } from './message'",
          "import { packageMessage } from 'mars-sw-package'",
          "import { exportsPackageMessage } from 'mars-sw-exports-package/subpath'",
          "import { scopedExportsPackageMessage } from '@mars/sw-scoped-package/feature'",
          "export const entryMessage: string = `entry:${message}`",
          "export const entryPackageMessage: string = `pkg:${packageMessage}`",
          "export const entryExportsPackageMessage: string = `exports:${exportsPackageMessage}`",
          "export const entryScopedExportsPackageMessage: string = `scoped:${scopedExportsPackageMessage}`",
          "export async function loadValue() { return (await import('./dynamic')).dynamicMessage }",
        ].join("\n"),
        "message.ts": "export const message: string = 'service-worker-module'",
        "dynamic.ts": "export const dynamicMessage: string = 'dynamic-service-worker-module'",
      },
      node_modules: {
        "mars-sw-package": {
          "package.json": JSON.stringify({ name: "mars-sw-package", module: "index.ts" }),
          "index.ts": [
            "import { nestedPackageMessage } from 'mars-sw-nested-package'",
            "export const packageMessage: string = `bare-package-module:${nestedPackageMessage}`",
          ].join("\n"),
        },
        "mars-sw-nested-package": {
          "package.json": JSON.stringify({ name: "mars-sw-nested-package", module: "index.ts" }),
          "index.ts": "export const nestedPackageMessage: string = 'nested-bare-package-module'",
        },
        "mars-sw-exports-package": {
          "package.json": JSON.stringify({
            name: "mars-sw-exports-package",
            exports: {
              "./subpath": "./subpath.ts",
            },
          }),
          "subpath.ts": [
            "import { nestedPackageMessage } from 'mars-sw-nested-package'",
            "export const exportsPackageMessage: string = `exports-subpath:${nestedPackageMessage}`",
          ].join("\n"),
        },
        "@mars": {
          "sw-scoped-package": {
            "package.json": JSON.stringify({
              name: "@mars/sw-scoped-package",
              exports: {
                "./feature": "./feature.ts",
              },
            }),
            "feature.ts": [
              "import { nestedPackageMessage } from 'mars-sw-nested-package'",
              "export const scopedExportsPackageMessage: string = `scoped-exports-subpath:${nestedPackageMessage}`",
            ].join("\n"),
          },
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

  const entryResponse = await router.fetch(new Request(`https://app.localhost${moduleUrlFromPath("/workspace/src/entry.ts")}`))
  const entryCode = await entryResponse.text()
  const moduleUrls = JSON.parse(entryResponse.headers.get("x-mars-module-urls") ?? "[]") as string[]
  const messageUrl = moduleUrls.find(url => url.includes("message.ts"))
  const dynamicUrl = moduleUrls.find(url => url.includes("dynamic.ts"))
  const packageUrl = moduleUrls.find(url => url.includes("node_modules%2Fmars-sw-package%2Findex.ts"))
  const exportsPackageUrl = moduleUrls.find(url => url.includes("node_modules%2Fmars-sw-exports-package%2Fsubpath.ts"))
  const scopedExportsPackageUrl = moduleUrls.find(url => url.includes("node_modules%2F%40mars%2Fsw-scoped-package%2Ffeature.ts"))

  expect(entryResponse.status).toBe(200)
  expect(entryResponse.headers.get("content-type")).toContain("text/javascript")
  expect(entryResponse.headers.get("x-mars-module-path")).toBe("/workspace/src/entry.ts")
  expect(entryCode).toContain("export const entryMessage")
  expect(entryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fmessage.ts")
  expect(entryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fdynamic.ts")
  expect(entryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-package%2Findex.ts")
  expect(entryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-exports-package%2Fsubpath.ts")
  expect(entryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2F%40mars%2Fsw-scoped-package%2Ffeature.ts")
  expect(messageUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fmessage.ts")
  expect(dynamicUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fdynamic.ts")
  expect(packageUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-package%2Findex.ts")
  expect(exportsPackageUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-exports-package%2Fsubpath.ts")
  expect(scopedExportsPackageUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2F%40mars%2Fsw-scoped-package%2Ffeature.ts")

  const messageResponse = await router.fetch(new Request(`https://app.localhost${messageUrl}`))
  const messageCode = await messageResponse.text()
  const nativeEntryResponse = await router.fetch(new Request("https://app.localhost/src/entry.ts"))
  const nativeEntryCode = await nativeEntryResponse.text()
  const packageResponse = await router.fetch(new Request(`https://app.localhost${packageUrl}`))
  const packageCode = await packageResponse.text()
  const packageModuleUrls = JSON.parse(packageResponse.headers.get("x-mars-module-urls") ?? "[]") as string[]
  const nestedPackageUrl = packageModuleUrls.find(url => url.includes("node_modules%2Fmars-sw-nested-package%2Findex.ts"))

  expect(messageResponse.status).toBe(200)
  expect(messageResponse.headers.get("x-mars-module-path")).toBe("/workspace/src/message.ts")
  expect(messageCode).toContain("export const message")
  expect(classifyRequest(new URL("https://app.localhost/src/entry.ts"))).toBe("module")
  expect(nativeEntryResponse.status).toBe(200)
  expect(nativeEntryResponse.headers.get("x-mars-module-path")).toBe("/workspace/src/entry.ts")
  expect(nativeEntryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fsrc%2Fmessage.ts")
  expect(nativeEntryCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-package%2Findex.ts")
  expect(packageResponse.status).toBe(200)
  expect(packageResponse.headers.get("x-mars-module-path")).toBe("/workspace/node_modules/mars-sw-package/index.ts")
  expect(packageCode).toContain("export const packageMessage")
  expect(packageCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-nested-package%2Findex.ts")
  expect(nestedPackageUrl).toBe("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-nested-package%2Findex.ts")

  const nestedPackageResponse = await router.fetch(new Request(`https://app.localhost${nestedPackageUrl}`))
  const nestedPackageCode = await nestedPackageResponse.text()
  const exportsPackageResponse = await router.fetch(new Request(`https://app.localhost${exportsPackageUrl}`))
  const exportsPackageCode = await exportsPackageResponse.text()
  const scopedExportsPackageResponse = await router.fetch(new Request(`https://app.localhost${scopedExportsPackageUrl}`))
  const scopedExportsPackageCode = await scopedExportsPackageResponse.text()

  expect(nestedPackageResponse.status).toBe(200)
  expect(nestedPackageResponse.headers.get("x-mars-module-path")).toBe("/workspace/node_modules/mars-sw-nested-package/index.ts")
  expect(nestedPackageCode).toContain("export const nestedPackageMessage")
  expect(exportsPackageResponse.status).toBe(200)
  expect(exportsPackageResponse.headers.get("x-mars-module-path")).toBe("/workspace/node_modules/mars-sw-exports-package/subpath.ts")
  expect(exportsPackageCode).toContain("export const exportsPackageMessage")
  expect(exportsPackageCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-nested-package%2Findex.ts")
  expect(scopedExportsPackageResponse.status).toBe(200)
  expect(scopedExportsPackageResponse.headers.get("x-mars-module-path")).toBe("/workspace/node_modules/@mars/sw-scoped-package/feature.ts")
  expect(scopedExportsPackageCode).toContain("export const scopedExportsPackageMessage")
  expect(scopedExportsPackageCode).toContain("/__mars__/module?path=%2Fworkspace%2Fnode_modules%2Fmars-sw-nested-package%2Findex.ts")

  await runtime.dispose()
})

test("Phase 3 ServiceWorker router falls back to network for Vite host modules", async () => {
  const runtime = await createMarsRuntime()
  const bunServer = (globalThis as unknown as { Bun: {
    serve(options: { port: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(closeActiveConnections?: boolean): void }
  } }).Bun
  const server = bunServer.serve({
    port: 0,
    fetch: request => new Response(`network:${new URL(request.url).pathname}`),
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
    fallback: "network",
  })

  try {
    const viteClientResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/@vite/client`))
    const viteEnvResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/@vite/env`))
    const reactRefreshResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/@react-refresh`))
    const virtualModuleResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/@id/__x00__virtual:mars-runtime`))
    const fsPathResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/@fs/Users/aniwei/Desktop/workspaces/bun/mars-lib/playground/src/main.tsx`))
    const hostSourceResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/src/main.tsx?t=1777319900061`))
    const hostImportResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/src/main.tsx?import`))
    const hostRawResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/src/main.tsx?raw`))
    const hostUrlResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/src/main.tsx?url`))
    const optimizedDependencyResponse = await router.fetch(new Request(`http://127.0.0.1:${server.port}/node_modules/.vite/deps/react.js?v=1777319900061`))

    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/@vite/client`))).toBe("external")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/@vite/env`))).toBe("external")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/@react-refresh`))).toBe("external")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/@id/__x00__virtual:mars-runtime`))).toBe("external")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/@fs/Users/aniwei/Desktop/workspaces/bun/mars-lib/playground/src/main.tsx`))).toBe("external")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/src/main.tsx?t=1777319900061`))).toBe("module")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/src/main.tsx?import`))).toBe("module")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/src/main.tsx?raw`))).toBe("module")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/src/main.tsx?url`))).toBe("module")
    expect(classifyRequest(new URL(`http://127.0.0.1:${server.port}/node_modules/.vite/deps/react.js?v=1777319900061`))).toBe("module")
    expect(viteClientResponse.status).toBe(200)
    expect(await viteClientResponse.text()).toBe("network:/@vite/client")
    expect(viteEnvResponse.status).toBe(200)
    expect(await viteEnvResponse.text()).toBe("network:/@vite/env")
    expect(reactRefreshResponse.status).toBe(200)
    expect(await reactRefreshResponse.text()).toBe("network:/@react-refresh")
    expect(virtualModuleResponse.status).toBe(200)
    expect(await virtualModuleResponse.text()).toBe("network:/@id/__x00__virtual:mars-runtime")
    expect(fsPathResponse.status).toBe(200)
    expect(await fsPathResponse.text()).toBe("network:/@fs/Users/aniwei/Desktop/workspaces/bun/mars-lib/playground/src/main.tsx")
    expect(hostSourceResponse.status).toBe(200)
    expect(await hostSourceResponse.text()).toBe("network:/src/main.tsx")
    expect(hostImportResponse.status).toBe(200)
    expect(await hostImportResponse.text()).toBe("network:/src/main.tsx")
    expect(hostRawResponse.status).toBe(200)
    expect(await hostRawResponse.text()).toBe("network:/src/main.tsx")
    expect(hostUrlResponse.status).toBe(200)
    expect(await hostUrlResponse.text()).toBe("network:/src/main.tsx")
    expect(optimizedDependencyResponse.status).toBe(200)
    expect(await optimizedDependencyResponse.text()).toBe("network:/node_modules/.vite/deps/react.js")
  } finally {
    server.stop(true)
    await runtime.dispose()
  }
})

test("Phase 3 ServiceWorker bridge applies incremental VFS patches before module fetch", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "sw-entry.ts": [
          "import { message } from './sw-message'",
          "export const swEntryMessage = `sw:${message}`",
        ].join("\n"),
        "sw-message.ts": "export const message = 'before-sw-patch'",
      },
    },
  })
  const pair = createMarsMemoryBridgePair()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: pair.left,
  })
  const serviceWorkerEndpoint = createMarsBridgeEndpoint({
    source: "sw",
    target: "client",
    transport: pair.right,
  })
  const controller = createServiceWorkerBridgeController({
    endpoint: serviceWorkerEndpoint,
    router: createServiceWorkerRouter({
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
    }),
  })

  const patchResult = await clientEndpoint.request(
    "sw.vfs.patch",
    { patches: [createWriteFilePatch("/workspace/src/sw-entry.ts", "export const swEntryMessage = 'after-sw-patch'")] },
    { target: "sw" },
  ) as { ok: boolean; count: number }
  const response = await clientEndpoint.request(
    "sw.fetch",
    { url: `https://app.localhost${moduleUrlFromPath("/workspace/src/sw-entry.ts")}` },
    { target: "sw" },
  ) as { status: number; headers: Record<string, string>; body: string }

  expect(patchResult).toEqual({ ok: true, count: 1 })
  expect(response.status).toBe(200)
  expect(response.headers["x-mars-module-path"]).toBe("/workspace/src/sw-entry.ts")
  expect(response.body).toContain("after-sw-patch")

  controller.dispose()
  clientEndpoint.close()
  serviceWorkerEndpoint.close()
  await runtime.dispose()
})

test("Phase 3 runtime auto-fans out VFS writes to the ServiceWorker bridge", async () => {
  const container = new MarsTestServiceWorkerContainer()
  const runtime = await createMarsRuntime({
    serviceWorkerUrl: "/mars-sw.js",
    serviceWorkerScope: "/",
    serviceWorkerContainer: container,
  })
  const scope = new MarsTestServiceWorkerScope()
  const serviceWorkerVFS = createMarsVFS({ cwd: "/workspace" })
  const bootstrap = installServiceWorkerBootstrap({
    scope,
    router: createServiceWorkerRouter({
      kernelClient: {
        resolvePort: async () => null,
        dispatchToKernel: async () => new Response("unexpected kernel dispatch", { status: 500 }),
      },
      vfsClient: {
        readFile: async path => {
          if (!serviceWorkerVFS.existsSync(path)) return null
          const data = await serviceWorkerVFS.readFile(path)
          return typeof data === "string" ? new TextEncoder().encode(data) : data
        },
        stat: async path => serviceWorkerVFS.existsSync(path) ? serviceWorkerVFS.stat(path) : null,
        contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      },
      moduleClient: {
        vfs: serviceWorkerVFS,
      },
    }),
  })

  scope.dispatchMessage({
    data: container.controller.messages[0],
    ports: (container.controller.transfers[0] ?? []) as MessagePort[],
  })
  await runtime.bun.write(
    "/workspace/src/auto-sw-entry.ts",
    "export const autoServiceWorkerFanout = 'from-runtime-write'",
  )
  await runtime.flushServiceWorkerVFS()
  const response = await runtime.serviceWorker?.endpoint.request(
    "sw.fetch",
    { url: `https://app.localhost${moduleUrlFromPath("/workspace/src/auto-sw-entry.ts")}` },
    { target: "sw" },
  ) as { status: number; headers: Record<string, string>; body: string } | undefined

  expect(response?.status).toBe(200)
  expect(response?.headers["x-mars-module-path"]).toBe("/workspace/src/auto-sw-entry.ts")
  expect(response?.body).toContain("from-runtime-write")

  bootstrap.dispose()
  await runtime.dispose()
})

test("Phase 3 runtime boot registers a real ServiceWorker client bridge", async () => {
  const container = new MarsTestServiceWorkerContainer()
  const runtime = await createMarsRuntime({
    serviceWorkerUrl: "/mars-sw.js",
    serviceWorkerScope: "/mars/",
    serviceWorkerContainer: container,
    unregisterServiceWorkerOnDispose: true,
  })

  expect(container.registrations).toEqual([{
    scriptURL: "/mars-sw.js",
    options: {
      scope: "/mars/",
      type: "module",
    },
  }])
  expect(runtime.serviceWorker?.ready).toBe(true)
  const connectMessage = container.controller.messages[0] as { id: string; type: string; source: string; target: string; payload: { scriptURL: string } }

  expect(connectMessage.id.startsWith("mars-sw-connect-")).toBe(true)
  expect(connectMessage).toEqual({
    id: connectMessage.id,
    type: "sw.connect",
    source: "client",
    target: "sw",
    payload: {
      scriptURL: "/mars-sw.js",
    },
  })
  expect(container.controller.transfers[0]?.length).toBe(1)

  await runtime.dispose()

  expect(container.registration.unregistered).toBe(true)
  expect(runtime.serviceWorker).toBe(null)
})

test("Phase 3 ServiceWorker bootstrap accepts client connect and serves bridge fetch", async () => {
  const runtime = await createMarsRuntime()
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const scope = new MarsTestServiceWorkerScope()
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

  scope.dispatchMessage({
    data: {
      id: "mars-sw-connect-test",
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
  const fetchEvent = new MarsTestFetchEvent(new Request(`${runtime.preview(server.port)}event-bootstrap`))
  scope.dispatchFetch(fetchEvent)
  const eventResponse = await fetchEvent.response

  expect(bootstrap.clients.length).toBe(1)
  expect(response.status).toBe(200)
  expect(response.body).toBe("bootstrap:/bootstrap")
  expect(await eventResponse.text()).toBe("bootstrap:/event-bootstrap")

  server.stop()
  bootstrap.dispose()
  kernelController.dispose()
  clientEndpoint.close()
  serviceWorkerKernelEndpoint.close()
  kernelEndpoint.close()
  channel.port1.close()
  await runtime.dispose()
})

test("Phase 3 bridge carries Kernel Worker and Process Worker lifecycle messages", async () => {
  const bridgePair = createMarsMemoryBridgePair()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: bridgePair.left,
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "client",
    transport: bridgePair.right,
  })
  const kernel = createMarsKernel()
  const controller = createKernelWorkerController({ endpoint: kernelEndpoint, kernel })

  expect(await clientEndpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })

  const spawned = await clientEndpoint.request(
    "kernel.spawn",
    { argv: ["worker-entry.ts"], kind: "worker" },
    { target: "kernel" },
  ) as { pid: number; argv: string[] }
  expect(spawned.argv).toEqual(["worker-entry.ts"])

  await clientEndpoint.request("kernel.kill", { pid: spawned.pid, signal: 0 }, { target: "kernel" })
  expect(await clientEndpoint.request("kernel.waitpid", { pid: spawned.pid }, { target: "kernel" })).toEqual({
    pid: spawned.pid,
    exitCode: 0,
  })

  const processWorker = await clientEndpoint.request(
    "process.worker.create",
    { argv: ["bun", "run", "worker-entry.ts"] },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }
  expect(processWorker.status).toBe("running")
  expect(processWorker.event).toEqual({
    type: "boot",
    id: processWorker.id,
    argv: ["bun", "run", "worker-entry.ts"],
  })

  const processMessage = await clientEndpoint.request(
    "process.worker.message",
    { id: processWorker.id, message: "bridge process" },
    { target: "kernel" },
  ) as { event: unknown }
  expect(processMessage.event).toEqual({
    type: "message",
    id: processWorker.id,
    data: { echoed: "bridge process" },
  })

  expect(await clientEndpoint.request(
    "process.worker.terminate",
    { id: processWorker.id },
    { target: "kernel" },
  )).toEqual({ id: processWorker.id, status: "stopped" })

  controller.dispose()
  clientEndpoint.close()
  kernelEndpoint.close()
})

test("Phase 3 Kernel Worker bridge patches and runs Process Worker modules", async () => {
  MarsTestNativeWorker.instances.length = 0
  const bridgePair = createMarsMemoryBridgePair()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: bridgePair.left,
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "client",
    transport: bridgePair.right,
  })
  const kernel = createMarsKernel()
  const controller = createKernelWorkerController({
    endpoint: kernelEndpoint,
    kernel,
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  expect(await clientEndpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })
  const processWorker = await clientEndpoint.request(
    "process.worker.create",
    { argv: ["bun", "run", "worker-entry.ts"], cwd: "/workspace" },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }
  const patchResponse = await clientEndpoint.request(
    "process.worker.vfs.patch",
    { id: processWorker.id, patches: [createWriteFilePatch("/workspace/worker-entry.ts", "console.log('bridge run')")] },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }
  const runResponse = await clientEndpoint.request(
    "process.worker.run",
    { id: processWorker.id },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }

  expect(processWorker.status).toBe("running")
  expect(patchResponse.event).toEqual({
    type: "process.worker.vfs.patch",
    id: processWorker.id,
    ok: true,
    count: 1,
  })
  expect(runResponse.event).toEqual({
    type: "process.worker.exit",
    id: processWorker.id,
    code: 0,
  })

  controller.dispose()
  clientEndpoint.close()
  kernelEndpoint.close()
})

test("Phase 3 Kernel Worker bootstrap accepts client connect and serves lifecycle RPC", async () => {
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const scope = new MarsTestKernelWorkerScope()
  const kernel = createMarsKernel()
  const bootstrap = installKernelWorkerBootstrap({ scope, kernel })

  scope.dispatchMessage({
    data: {
      id: "mars-kernel-connect-test",
      type: "kernel.connect",
      source: "client",
      target: "kernel",
      payload: { workerURL: "/mars-kernel-worker.js" },
    },
    ports: [channel.port2],
  })

  expect(bootstrap.clients.length).toBe(1)
  expect(await clientEndpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })

  const processWorker = await clientEndpoint.request(
    "process.worker.create",
    { argv: ["bun", "run", "worker-entry.ts"] },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }
  expect(processWorker.status).toBe("running")
  expect(processWorker.event).toEqual({
    type: "boot",
    id: processWorker.id,
    argv: ["bun", "run", "worker-entry.ts"],
  })

  expect(await clientEndpoint.request(
    "process.worker.terminate",
    { id: processWorker.id },
    { target: "kernel" },
  )).toEqual({ id: processWorker.id, status: "stopped" })

  bootstrap.dispose()
  clientEndpoint.close()
  channel.port1.close()
})

test("Phase 3 Kernel Worker client can carry RPC over native Worker", async () => {
  MarsTestKernelCarrierWorker.instances.length = 0
  const scope = new MarsTestKernelWorkerScope()
  const kernel = createMarsKernel()
  const bootstrap = installKernelWorkerBootstrap({ scope, kernel })
  MarsTestKernelCarrierWorker.scope = scope
  const client = connectMarsKernelWorker({
    workerURL: "/mars-kernel-worker.js",
    workerOptions: { type: "module" },
    workerConstructor: MarsTestKernelCarrierWorker,
  })

  expect(supportsKernelWorkerClient({ workerConstructor: MarsTestKernelCarrierWorker })).toBe(true)
  expect(client.connected).toBe(true)
  expect(MarsTestKernelCarrierWorker.instances[0].url).toBe("/mars-kernel-worker.js")
  expect(MarsTestKernelCarrierWorker.instances[0].options).toEqual({ type: "module" })
  expect((MarsTestKernelCarrierWorker.instances[0].messages[0] as { type?: string }).type).toBe("kernel.connect")
  expect(MarsTestKernelCarrierWorker.instances[0].transfers[0]?.length).toBe(1)
  expect(bootstrap.clients.length).toBe(1)
  expect(await client.endpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })

  const processWorker = await client.endpoint.request(
    "process.worker.create",
    { argv: ["bun", "run", "worker-entry.ts"] },
    { target: "kernel" },
  ) as { id: string; status: string; event: unknown }
  expect(processWorker.status).toBe("running")
  expect(processWorker.event).toEqual({
    type: "boot",
    id: processWorker.id,
    argv: ["bun", "run", "worker-entry.ts"],
  })

  expect(await client.endpoint.request(
    "process.worker.terminate",
    { id: processWorker.id },
    { target: "kernel" },
  )).toEqual({ id: processWorker.id, status: "stopped" })

  client.close()
  bootstrap.dispose()
  MarsTestKernelCarrierWorker.scope = null
  expect(MarsTestKernelCarrierWorker.instances[0].terminated).toBe(true)
})

test("Phase 3 kernel.spawn can auto-create a Process Worker through Kernel Worker RPC", async () => {
  MarsTestNativeWorker.instances.length = 0
  const channel = new MessageChannel()
  const clientEndpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const kernelEndpoint = createMarsBridgeEndpoint({
    source: "kernel",
    target: "client",
    transport: createMarsPostMessageBridgeTransport(channel.port2),
  })
  const kernel = createMarsKernel()
  const stdio: string[] = []
  const stdioSubscription = kernel.on("stdio", payload => {
    stdio.push(`${payload.fd}:${new TextDecoder().decode(payload.chunk)}`)
  })
  const controller = createKernelWorkerController({
    endpoint: kernelEndpoint,
    kernel,
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  expect(await clientEndpoint.request("kernel.boot", {}, { target: "kernel" })).toEqual({ booted: true })
  const spawned = await clientEndpoint.request(
    "kernel.spawn",
    {
      argv: ["bun", "run", "worker-entry.ts"],
      cwd: "/workspace",
      env: { MARS: "1" },
      kind: "worker",
      stdin: "kernel worker stdin",
    },
    { target: "kernel" },
  ) as { pid: number; workerId: string; status: string; event: unknown }
  await waitForMarsTestNativeWorkerMessages(MarsTestNativeWorker.instances[0], 3)
  MarsTestNativeWorker.instances[0].dispatch({
    type: "process.worker.stdout",
    id: spawned.workerId,
    chunk: "auto worker stdout",
  })
  MarsTestNativeWorker.instances[0].dispatch({
    type: "process.worker.exit",
    id: spawned.workerId,
    code: 0,
  })
  const waited = await clientEndpoint.request(
    "kernel.waitpid",
    { pid: spawned.pid },
    { target: "kernel" },
  ) as { pid: number; exitCode: number }

  expect(spawned.status).toBe("running")
  expect(spawned.event).toEqual({
    type: "boot",
    id: spawned.workerId,
    argv: ["bun", "run", "worker-entry.ts"],
  })
  expect(MarsTestNativeWorker.instances[0].messages[0]).toEqual({
    type: "process.worker.boot",
    id: spawned.workerId,
    argv: ["bun", "run", "worker-entry.ts"],
    cwd: "/workspace",
    env: { MARS: "1" },
  })
  expect(MarsTestNativeWorker.instances[0].messages[1]).toEqual({
    type: "process.worker.stdin",
    id: spawned.workerId,
    chunk: new TextEncoder().encode("kernel worker stdin"),
  })
  expect(MarsTestNativeWorker.instances[0].messages[2]).toEqual({
    type: "process.worker.stdin.close",
    id: spawned.workerId,
  })
  expect(stdio).toEqual([
    "1:stdout:kernel worker stdin",
    "2:stderr:kernel worker stdin",
    "1:auto worker stdout",
  ])
  expect(waited).toEqual({ pid: spawned.pid, exitCode: 0 })

  stdioSubscription.dispose()
  controller.dispose()
  clientEndpoint.close()
  kernelEndpoint.close()
  channel.port1.close()
})

test("Phase 3 Process Worker runtime bootstrap injects Bun-compatible context", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      lib: {
        "answer.cjs": "module.exports = { value: 42 }",
      },
    },
  })
  const scope = new MarsTestProcessWorkerRuntimeScope()
  const bootstrap = installProcessWorkerRuntimeBootstrap({
    scope: scope as unknown as MarsTestProcessWorkerRuntimeScope & Record<string, unknown>,
    vfs: runtime.vfs,
    kernel: runtime.kernel,
    autoRun: false,
  })

  try {
    scope.dispatch({
      type: "process.worker.boot",
      id: "process-worker-context",
      argv: ["bun", "run", "worker-entry.ts", "--flag"],
      cwd: "/workspace/lib",
      env: { MARS_WORKER: "1" },
    })
    await bootstrap.idle()

    expect(scope.messages[0]).toEqual({
      type: "boot",
      id: "process-worker-context",
      argv: ["bun", "run", "worker-entry.ts", "--flag"],
    })
    const injectedScope = scope as MarsTestInjectedProcessWorkerRuntimeScope
    expect(injectedScope.process.argv).toEqual(["bun", "run", "worker-entry.ts", "--flag"])
    expect(injectedScope.process.env).toEqual({ MARS_WORKER: "1" })
    expect(injectedScope.process.cwd()).toBe("/workspace/lib")
    expect(injectedScope.Bun.env).toEqual({ MARS_WORKER: "1" })
    expect(injectedScope.require("./answer.cjs")).toEqual({ value: 42 })
  } finally {
    bootstrap.dispose()
    await runtime.dispose()
  }
})

test("Phase 3 Process Worker runtime bootstrap closes stdin", async () => {
  const runtime = await createMarsRuntime()
  const kernel = createMarsKernel()
  const originalSpawn = kernel.spawn.bind(kernel)
  let resolveCapturedHandle: (handle: ProcessHandle) => void = () => {}
  const capturedHandlePromise = new Promise<ProcessHandle>(resolve => {
    resolveCapturedHandle = resolve
  })
  kernel.spawn = async options => {
    const handle = await originalSpawn(options)
    resolveCapturedHandle(handle)
    return handle
  }
  const scope = new MarsTestProcessWorkerRuntimeScope()
  const bootstrap = installProcessWorkerRuntimeBootstrap({
    scope: scope as unknown as MarsTestProcessWorkerRuntimeScope & Record<string, unknown>,
    vfs: runtime.vfs,
    kernel,
    autoRun: false,
  })

  try {
    scope.dispatch({
      type: "process.worker.boot",
      id: "process-worker-stdin-close",
      argv: ["bun", "run", "worker-entry.ts"],
      cwd: "/workspace",
    })
    await bootstrap.idle()
    const capturedHandle = await capturedHandlePromise
    const stdinReader = capturedHandle.stdin.getReader()

    scope.dispatch({
      type: "process.worker.stdin",
      id: "process-worker-stdin-close",
      chunk: new TextEncoder().encode("bootstrap stdin"),
    })
    await bootstrap.idle()
    scope.dispatch({
      type: "process.worker.stdin.close",
      id: "process-worker-stdin-close",
    })
    await bootstrap.idle()
    const firstChunk = await stdinReader.read()
    const closedChunk = await stdinReader.read()

    expect(new TextDecoder().decode(firstChunk.value)).toBe("bootstrap stdin")
    expect(closedChunk.done).toBe(true)

    stdinReader.releaseLock()
  } finally {
    bootstrap.dispose()
    await kernel.shutdown()
    await runtime.dispose()
  }
})

test("Phase 3 Process Worker runtime bootstrap executes bun run module with stdio", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "worker-entry.ts": "console.log('worker module bootstrap')",
    },
  })
  const originalPostMessage = globalThis.postMessage
  const messages: unknown[] = []
  const workerScope = Object.assign(globalThis, {
    postMessage: (message: unknown) => {
      messages.push(message)
    },
  })
  const bootstrap = installProcessWorkerRuntimeBootstrap({
    scope: workerScope,
    vfs: runtime.vfs,
    kernel: runtime.kernel,
  })

  try {
    globalThis.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "process.worker.boot",
        id: "process-worker-module",
        argv: ["bun", "run", "worker-entry.ts"],
        cwd: "/workspace",
      },
    }))
    await bootstrap.idle()

    expect(messages[0]).toEqual({
      type: "boot",
      id: "process-worker-module",
      argv: ["bun", "run", "worker-entry.ts"],
    })
    expect(messages.some(message => {
      const payload = message as { type?: string; chunk?: Uint8Array } | undefined
      return payload?.type === "process.worker.stdout" && new TextDecoder().decode(payload.chunk).includes("worker module bootstrap")
    })).toBe(true)
    expect(messages.at(-1)).toEqual({
      type: "process.worker.exit",
      id: "process-worker-module",
      code: 0,
    })
  } finally {
    bootstrap.dispose()
    if (originalPostMessage) globalThis.postMessage = originalPostMessage
    else delete (globalThis as { postMessage?: unknown }).postMessage
    await runtime.dispose()
  }
})

test("Phase 3 Process Worker runtime bootstrap applies incremental VFS patches before run", async () => {
  const runtime = await createMarsRuntime()
  const originalPostMessage = globalThis.postMessage
  const messages: unknown[] = []
  const workerScope = Object.assign(globalThis, {
    postMessage: (message: unknown) => {
      messages.push(message)
    },
  })
  const bootstrap = installProcessWorkerRuntimeBootstrap({
    scope: workerScope,
    vfs: runtime.vfs,
    kernel: runtime.kernel,
    autoRun: false,
  })

  try {
    globalThis.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "process.worker.boot",
        id: "process-worker-patch",
        argv: ["bun", "run", "patched-entry.ts"],
        cwd: "/workspace",
      },
    }))
    await bootstrap.idle()
    globalThis.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "process.worker.vfs.patch",
        id: "process-worker-patch",
        patches: [createWriteFilePatch("/workspace/patched-entry.ts", "console.log('patched worker entry')")],
      },
    }))
    await bootstrap.idle()
    globalThis.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "process.worker.run",
        id: "process-worker-patch",
      },
    }))
    await bootstrap.idle()

    expect(messages[0]).toEqual({
      type: "boot",
      id: "process-worker-patch",
      argv: ["bun", "run", "patched-entry.ts"],
    })
    expect(messages[1]).toEqual({
      type: "process.worker.vfs.patch",
      id: "process-worker-patch",
      ok: true,
      count: 1,
    })
    expect(messages.some(message => {
      const payload = message as { type?: string; chunk?: Uint8Array } | undefined
      return payload?.type === "process.worker.stdout" && new TextDecoder().decode(payload.chunk).includes("patched worker entry")
    })).toBe(true)
    expect(messages.at(-1)).toEqual({
      type: "process.worker.exit",
      id: "process-worker-patch",
      code: 0,
    })
  } finally {
    bootstrap.dispose()
    if (originalPostMessage) globalThis.postMessage = originalPostMessage
    else delete (globalThis as { postMessage?: unknown }).postMessage
    await runtime.dispose()
  }
})

test("Phase 3 Process Worker bootstrap script packages worker entry source", () => {
  const objectURLs: string[] = []
  const script = createProcessWorkerBootstrapScript({
    cwd: "/workspace/app",
    initialFiles: {
      "worker-entry.ts": "console.log('packaged worker')",
      bin: {
        "payload.bin": new Uint8Array([1, 2, 3]),
      },
    },
    initialSnapshot: {
      "snapshot-entry.ts": {
        kind: "file",
        encoding: "base64",
        data: "Y29uc29sZS5sb2coJ3NuYXBzaG90Jyk=",
      },
    },
    snapshotRoot: "/workspace/app",
    autoRun: false,
  })
  const url = createProcessWorkerBootstrapBlobURL({
    cwd: "/workspace/app",
    initialFiles: {
      "worker-entry.ts": "console.log('packaged worker')",
    },
    scope: {
      Blob,
      URL: {
        createObjectURL: blob => {
          expect(blob.type).toContain("text/javascript")
          objectURLs.push("blob:mars-process-worker")
          return objectURLs[0]
        },
      },
    },
  })

  expect(script).toContain("installProcessWorkerRuntimeBootstrap")
  expect(script).toContain("createMarsVFS")
  expect(script).toContain("restoreVFSSnapshot")
  expect(script).toContain("createMarsKernel")
  expect(script).toContain("/workspace/app")
  expect(script).toContain("worker-entry.ts")
  expect(script).toContain("snapshot-entry.ts")
  expect(script).toContain("packaged worker")
  expect(script).toContain("new Uint8Array([1,2,3])")
  expect(script).toContain("autoRun: false")
  expect(url).toBe("blob:mars-process-worker")
  expect(objectURLs).toEqual(["blob:mars-process-worker"])
})

test("Phase 3 Bun.build can build vite playground entry", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("vite-react-ts"),
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/App.tsx"],
    outfile: "dist/playground-app.js",
  })
  const output = String(await runtime.vfs.readFile("dist/playground-app.js", "utf8"))

  expect(result.success).toBe(true)
  expect(result.outputs[0].path).toBe("/workspace/dist/playground-app.js")
  expect(output).toContain("Mars Vite React TS")
  expect(output).toContain("__mars_jsx")

  await runtime.dispose()
})

test("Phase 3 playground module cases include Bun.build prework", async () => {
  const cases = await loadPlaygroundModuleCases()
  const buildCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-build-vite-entry")

  expect(buildCase?.status).toBe("prework")
  expect(buildCase?.module).toBe("bun-build")
  expect(await readPlaygroundCaseEntry(buildCase?.entry ?? "")).toContain("Mars Vite React TS")
})

test("Phase 3 shell bun run executes index.ts through kernel stdio", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
  })

  const result = await runtime.shell.run("bun run index.ts")
  const processRecord = runtime.kernel.ps().find(record => record.argv.join(" ") === "bun run index.ts")

  expect(result.code).toBe(0)
  expect(result.stdout).toBe("bun run index {\"phase\":3}\n")
  expect(result.stderr).toBe("bun run stderr\n")
  expect(processRecord?.exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 bun run package scripts execute through shell and spawn entrypoints", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "package.json": JSON.stringify({
        name: "phase3-package-scripts",
        scripts: {
          prestart: "echo package-script-pre",
          start: "echo package-script-started",
          poststart: "echo package-script-post",
          envcheck: "envdump from-script",
          bincheck: "mars-bin from-script",
        },
      }),
    },
  })
  const envdumpCommand: ShellCommand = {
    name: "envdump",
    run: context => ({
      code: 0,
      stdout: `${JSON.stringify({
        argv: context.argv.slice(1),
        custom: context.env.CUSTOM_SCRIPT_ENV,
        initCwd: context.env.INIT_CWD,
        lifecycleEvent: context.env.npm_lifecycle_event,
        lifecycleScript: context.env.npm_lifecycle_script,
        nodeExecPath: context.env.npm_node_execpath,
        packageJson: context.env.npm_package_json,
        packageName: context.env.npm_package_name,
        path: context.env.PATH,
        userAgent: context.env.npm_config_user_agent,
      })}\n`,
      stderr: "",
    }),
  }
  runtime.shell.registerCommand(envdumpCommand)
  runtime.vfs.mkdirSync("node_modules/.bin", { recursive: true })
  runtime.vfs.writeFileSync("node_modules/.bin/mars-bin", "echo bin-script")

  const shellResult = await runtime.shell.run("bun run start -- shell-arg")
  const runtimeProcess = await runtime.spawn("bun", ["run", "start", "--", "runtime-arg"])
  const bunProcess = await runtime.bun.spawn({ cmd: ["bun", "run", "start", "--", "bun-arg"] })
  const shellEnvResult = await runtime.shell.run("bun run envcheck -- shell-extra", {
    env: { CUSTOM_SCRIPT_ENV: "shell-env" },
  })
  const runtimeEnvProcess = await runtime.spawn("bun", ["run", "envcheck", "--", "runtime-extra"], {
    env: { CUSTOM_SCRIPT_ENV: "runtime-env" },
  })
  const bunEnvProcess = await runtime.bun.spawn({
    cmd: ["bun", "run", "envcheck", "--", "bun-extra"],
    env: { CUSTOM_SCRIPT_ENV: "bun-env" },
  })
  const binResult = await runtime.shell.run("bun run bincheck")
  const [runtimeStdout, runtimeStderr, runtimeExitCode, bunStdout, bunStderr, bunExitCode] = await Promise.all([
    new Response(runtimeProcess.stdout).text(),
    new Response(runtimeProcess.stderr).text(),
    runtimeProcess.exited,
    new Response(bunProcess.stdout).text(),
    new Response(bunProcess.stderr).text(),
    bunProcess.exited,
  ])
  const [runtimeEnvStdout, runtimeEnvExitCode, bunEnvStdout, bunEnvExitCode] = await Promise.all([
    new Response(runtimeEnvProcess.stdout).text(),
    runtimeEnvProcess.exited,
    new Response(bunEnvProcess.stdout).text(),
    bunEnvProcess.exited,
  ])
  const shellEnv = JSON.parse(shellEnvResult.stdout) as Record<string, unknown>
  const runtimeEnv = JSON.parse(runtimeEnvStdout) as Record<string, unknown>
  const bunEnv = JSON.parse(bunEnvStdout) as Record<string, unknown>

  expect(shellResult.code).toBe(0)
  expect(shellResult.stdout).toBe("package-script-pre\npackage-script-started shell-arg\npackage-script-post\n")
  expect(shellResult.stderr).toBe("")
  expect(runtimeStdout).toBe("package-script-pre\npackage-script-started runtime-arg\npackage-script-post\n")
  expect(runtimeStderr).toBe("")
  expect(runtimeExitCode).toBe(0)
  expect(bunStdout).toBe("package-script-pre\npackage-script-started bun-arg\npackage-script-post\n")
  expect(bunStderr).toBe("")
  expect(bunExitCode).toBe(0)
  expect(shellEnv.argv).toEqual(["from-script", "shell-extra"])
  expect(shellEnv.custom).toBe("shell-env")
  expect(shellEnv.initCwd).toBe("/workspace")
  expect(shellEnv.lifecycleEvent).toBe("envcheck")
  expect(shellEnv.lifecycleScript).toBe("envdump from-script")
  expect(shellEnv.nodeExecPath).toBe("bun")
  expect(shellEnv.packageJson).toBe("/workspace/package.json")
  expect(shellEnv.packageName).toBe("phase3-package-scripts")
  expect(shellEnv.userAgent).toBe("bun/mars")
  expect(String(shellEnv.path)).toContain("/workspace/node_modules/.bin")
  expect(runtimeEnv.argv).toEqual(["from-script", "runtime-extra"])
  expect(runtimeEnv.custom).toBe("runtime-env")
  expect(runtimeEnv.lifecycleEvent).toBe("envcheck")
  expect(runtimeEnv.packageName).toBe("phase3-package-scripts")
  expect(runtimeEnvExitCode).toBe(0)
  expect(bunEnv.argv).toEqual(["from-script", "bun-extra"])
  expect(bunEnv.custom).toBe("bun-env")
  expect(bunEnv.lifecycleEvent).toBe("envcheck")
  expect(bunEnv.packageName).toBe("phase3-package-scripts")
  expect(bunEnvExitCode).toBe(0)
  expect(binResult.code).toBe(0)
  expect(binResult.stdout).toBe("bin-script from-script\n")

  await runtime.dispose()
})

test("Phase 3 shell bun run can execute through configured Process Worker", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const resultTask = runtime.shell.run("bun run index.ts")
  const worker = await waitForMarsTestNativeWorker()
  worker.dispatch({
    type: "process.worker.stdout",
    id: "process-worker-1",
    chunk: "shell worker bun run stdout\n",
  })
  worker.dispatch({
    type: "process.worker.stderr",
    id: "process-worker-1",
    chunk: "shell worker bun run stderr\n",
  })
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const result = await resultTask

  expect(worker.messages[0]).toEqual({
    type: "process.worker.boot",
    id: "process-worker-1",
    argv: ["bun", "run", "index.ts"],
    cwd: "/workspace",
    env: {},
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("shell worker bun run stdout\n")
  expect(result.stderr).toBe("shell worker bun run stderr\n")

  await runtime.dispose()
})

test("Phase 3 runtime.spawn executes bun run index.ts through kernel stdio", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("bun run index {\"phase\":3}\n")
  expect(stderr).toBe("bun run stderr\n")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 runtime.spawn can execute bun run through configured Process Worker", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  const worker = MarsTestNativeWorker.instances[0]
  worker.dispatch({
    type: "process.worker.stdout",
    id: "process-worker-1",
    chunk: "worker bun run stdout\n",
  })
  worker.dispatch({
    type: "process.worker.stderr",
    id: "process-worker-1",
    chunk: "worker bun run stderr\n",
  })
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.url).toBe("/mars-process-worker.js")
  expect(worker.options).toEqual({ type: "module" })
  expect(worker.messages[0]).toEqual({
    type: "process.worker.boot",
    id: "process-worker-1",
    argv: ["bun", "run", "index.ts"],
    cwd: "/workspace",
    env: undefined,
  })
  expect(stdout).toBe("worker bun run stdout\n")
  expect(stderr).toBe("worker bun run stderr\n")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 Bun.spawn executes bun run index.ts through kernel stdio", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
  })

  const processHandle = await runtime.bun.spawn({ cmd: ["bun", "run", "index.ts"] })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("bun run index {\"phase\":3}\n")
  expect(stderr).toBe("bun run stderr\n")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 Bun.spawn can execute bun run through configured Process Worker", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const processHandle = await runtime.bun.spawn({ cmd: ["bun", "run", "index.ts"] })
  const worker = MarsTestNativeWorker.instances[0]
  worker.dispatch({
    type: "process.worker.stdout",
    id: "process-worker-1",
    chunk: "bun spawn worker stdout\n",
  })
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[0]).toEqual({
    type: "process.worker.boot",
    id: "process-worker-1",
    argv: ["bun", "run", "index.ts"],
    cwd: "/workspace",
    env: undefined,
  })
  expect(stdout).toBe("bun spawn worker stdout\n")
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn forwards ProcessHandle stdin", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  const worker = MarsTestNativeWorker.instances[0]
  await processHandle.write("stdin payload")
  await waitForMarsTestNativeWorkerMessages(worker, 2)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin",
    id: "process-worker-1",
    chunk: new TextEncoder().encode("stdin payload"),
  })
  expect(stdout).toBe("stdout:stdin payload")
  expect(stderr).toBe("stderr:stdin payload")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn forwards ProcessHandle closeStdin", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  const worker = MarsTestNativeWorker.instances[0]
  processHandle.closeStdin()
  await waitForMarsTestNativeWorkerMessages(worker, 2)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin.close",
    id: "process-worker-1",
  })
  expect(stdout).toBe("")
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn forwards initial stdin", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"], {
    stdin: "initial stdin payload",
  })
  const worker = MarsTestNativeWorker.instances[0]
  await waitForMarsTestNativeWorkerMessages(worker, 2)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin",
    id: "process-worker-1",
    chunk: new TextEncoder().encode("initial stdin payload"),
  })
  expect(stdout).toBe("stdout:initial stdin payload")
  expect(stderr).toBe("stderr:initial stdin payload")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn forwards initial stdin stream", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })
  const encoder = new TextEncoder()
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("stream stdin payload"))
      controller.close()
    },
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"], { stdin })
  const worker = MarsTestNativeWorker.instances[0]
  await waitForMarsTestNativeWorkerMessages(worker, 2)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin",
    id: "process-worker-1",
    chunk: encoder.encode("stream stdin payload"),
  })
  expect(stdout).toBe("stdout:stream stdin payload")
  expect(stderr).toBe("stderr:stream stdin payload")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn closes initial stdin stream", async () => {
  MarsTestNativeWorker.instances.length = 0
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-runtime-bun-run"),
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "/mars-process-worker.js",
      workerOptions: { type: "module" },
      workerConstructor: MarsTestNativeWorker,
    }),
  })
  const encoder = new TextEncoder()
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("stream stdin close payload"))
      controller.close()
    },
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"], { stdin })
  const worker = MarsTestNativeWorker.instances[0]
  await waitForMarsTestNativeWorkerMessages(worker, 3)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin",
    id: "process-worker-1",
    chunk: encoder.encode("stream stdin close payload"),
  })
  expect(worker.messages[2]).toEqual({
    type: "process.worker.stdin.close",
    id: "process-worker-1",
  })
  expect(stdout).toBe("stdout:stream stdin close payload")
  expect(stderr).toBe("stderr:stream stdin close payload")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 runtime.spawn executes general shell command through kernel stdio", async () => {
  const runtime = await createMarsRuntime()

  const processHandle = await runtime.spawn("echo", ["runtime-general"])
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("runtime-general\n")
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 Bun.spawn executes general shell command through kernel stdio", async () => {
  const runtime = await createMarsRuntime()

  const processHandle = await runtime.bun.spawn({ cmd: ["echo", "bun-general"] })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("bun-general\n")
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 Bun.spawn and runtime.spawn pipe initial stdin into shell command", async () => {
  const runtime = await createMarsRuntime()
  const encoder = new TextEncoder()
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("streamed shell stdin\n"))
      controller.close()
    },
  })

  const runtimeProcess = await runtime.spawn("cat", [], { stdin: "runtime shell stdin\n" })
  const bunProcess = await runtime.bun.spawn({ cmd: ["cat"], stdin })
  const [runtimeStdout, runtimeStderr, runtimeExitCode, bunStdout, bunStderr, bunExitCode] = await Promise.all([
    new Response(runtimeProcess.stdout).text(),
    new Response(runtimeProcess.stderr).text(),
    runtimeProcess.exited,
    new Response(bunProcess.stdout).text(),
    new Response(bunProcess.stderr).text(),
    bunProcess.exited,
  ])

  expect(runtimeStdout).toBe("runtime shell stdin\n")
  expect(runtimeStderr).toBe("")
  expect(runtimeExitCode).toBe(0)
  expect(bunStdout).toBe("streamed shell stdin\n")
  expect(bunStderr).toBe("")
  expect(bunExitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 Bun.spawn supports shorthand argv through configured Process Worker", async () => {
  MarsTestNativeWorker.instances = []
  const runtime = await createMarsRuntime({
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "mars-worker://spawn-shorthand",
      workerConstructor: MarsTestNativeWorker,
    }),
    initialFiles: {
      src: {
        "index.ts": "console.log('spawn shorthand route')",
      },
    },
  })

  const processHandle = await runtime.bun.spawn(["bun", "run", "index.ts"])
  const worker = await waitForMarsTestNativeWorker()
  await waitForMarsTestNativeWorkerMessages(worker, 1)

  await processHandle.write("shorthand payload")
  await waitForMarsTestNativeWorkerMessages(worker, 2)
  worker.dispatch({
    type: "process.worker.exit",
    id: "process-worker-1",
    code: 0,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(worker.messages[0]).toEqual({
    type: "process.worker.boot",
    id: "process-worker-1",
    argv: ["bun", "run", "index.ts"],
    cwd: "/workspace",
    env: undefined,
  })
  expect(worker.messages[1]).toEqual({
    type: "process.worker.stdin",
    id: "process-worker-1",
    chunk: new TextEncoder().encode("shorthand payload"),
  })
  expect(stdout).toBe("stdout:shorthand payload")
  expect(stderr).toBe("stderr:shorthand payload")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 3 configured Process Worker spawn rejects writes after closeStdin", async () => {
  MarsTestNativeWorker.instances = []
  const runtime = await createMarsRuntime({
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "mars-worker://stdin-close-error",
      workerConstructor: MarsTestNativeWorker,
    }),
    initialFiles: {
      src: {
        "index.ts": "console.log('stdin close error route')",
      },
    },
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  processHandle.closeStdin()

  let writeError: Error | null = null
  try {
    await processHandle.write("late payload")
  } catch (error) {
    writeError = error as Error
  }

  expect(writeError).not.toBeNull()
  expect(String(writeError?.message ?? "")).toContain("Stdio channel is closed")
  await processHandle.kill(0)
  await processHandle.exited

  await runtime.dispose()
})

test("Phase 3 runtime.dispose terminates active native Process Worker carriers", async () => {
  MarsTestNativeWorker.instances = []
  const runtime = await createMarsRuntime({
    processWorkerFactory: createMarsProcessWorkerFactory({
      workerURL: "mars-worker://dispose-terminate",
      workerConstructor: MarsTestNativeWorker,
    }),
    initialFiles: {
      src: {
        "index.ts": "console.log('dispose terminate route')",
      },
    },
  })

  const processHandle = await runtime.spawn("bun", ["run", "index.ts"])
  const worker = await waitForMarsTestNativeWorker()
  await waitForMarsTestNativeWorkerMessages(worker, 1)

  await runtime.dispose()

  await processHandle.exited
  expect(worker.terminated).toBe(true)
})

test("Phase 3 Bun.spawnSync returns explicit fallback result", async () => {
  const runtime = await createMarsRuntime()
  const result = runtime.bun.spawnSync({ cmd: ["bun", "run", "index.ts"] })

  expect(result.success).toBe(false)
  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain("Bun.spawnSync")

  await runtime.dispose()
})

test("Phase 3 Bun.spawnSync executes echo when SAB sync profile is available", async () => {
  const runtime = await createMarsRuntime()
  const result = runtime.bun.spawnSync({ cmd: ["echo", "sync", "path"] })

  expect(result.success).toBe(true)
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout)).toBe("sync path\n")
  expect(new TextDecoder().decode(result.stderr)).toBe("")

  await runtime.dispose()
})

test("Phase 3 Bun.spawnSync reports no-SAB fallback explicitly", async () => {
  const runtime = await createMarsRuntime()
  const bun = createMarsBun({
    vfs: runtime.vfs,
    kernel: runtime.kernel,
    scope: {} as typeof globalThis,
  })
  const result = bun.spawnSync({ cmd: ["echo", "fallback"] })

  expect(result.success).toBe(false)
  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain("SharedArrayBuffer + Atomics.wait")

  await runtime.dispose()
})

test("Phase 3 CryptoHasher digests common algorithms", async () => {
  const expectedSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  const expectedMd5 = "5d41402abc4b2a76b9719d911017c592"
  const runtime = await createMarsRuntime()
  const hasher = new runtime.bun.CryptoHasher("sha256")

  expect(await hasher.update("hello").digest()).toBe(expectedSha256)
  expect(await new MarsCryptoHasher("sha256").update("hello").digest()).toBe(expectedSha256)
  expect(await new MarsCryptoHasher("md5").update("hel").update("lo").digest()).toBe(expectedMd5)
  expect(await createHashDigest("sha256", "hello")).toBe(expectedSha256)
  expect(await createHashDigest("md5", "hello")).toBe(expectedMd5)

  await runtime.dispose()
})

test("Phase 3 CryptoHasher supports digest encodings", async () => {
  const sha256 = new MarsCryptoHasher("sha256")
  sha256.update("hello")
  const sha1Buffer = await createHashDigest("sha1", "hello", "buffer")

  expect(await sha256.digest("base64url")).toBe("LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ")
  expect(sha1Buffer instanceof Uint8Array).toBe(true)
  expect((sha1Buffer as Uint8Array).byteLength).toBe(20)
})

test("Phase 3 node crypto subset covers random, createHash and createHmac", async () => {
  expect(randomBytes(16).byteLength).toBe(16)
  expect(/^[0-9a-f-]{36}$/.test(randomUUID())).toBe(true)
  expect(await createHash("sha256").update("hello").digest()).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  )
  expect(await createHash("md5").update("hello").digest()).toBe("5d41402abc4b2a76b9719d911017c592")
  expect(await createHmac("sha256", "mars-key").update("hel").update("lo").digest()).toBe(
    "d1249e55d8f24838cfa2a9bb3fc5950d9002e92d08c142ffdbbd4e251e05c3fd",
  )
  expect(await createHmac("sha256", "mars-key").update("hello").digest("base64")).toBe(
    "0SSeVdjySDjPoqm7P8WVDZAC6S0IwUL/271OJR4Fw/0=",
  )
})

test("Phase 3 Bun.password hashes and verifies through WebCrypto", async () => {
  const runtime = await createMarsRuntime()
  const salt = new Uint8Array(16).fill(7)
  const hash = await runtime.bun.password.hash("mars-secret", {
    iterations: 1_000,
    salt,
  })

  expect(hash).toContain("$mars$pbkdf2-sha256$")
  expect(await runtime.bun.password.verify("mars-secret", hash)).toBe(true)
  expect(await runtime.bun.password.verify("wrong-secret", hash)).toBe(false)
  expect(await marsPassword.verify("mars-secret", hash)).toBe(true)

  const costHash = await runtime.bun.password.hash("mars-secret", {
    cost: 10,
    salt,
  })

  expect(costHash).toContain("$mars$pbkdf2-sha256$1024$")
  expect(await runtime.bun.password.verify("mars-secret", costHash)).toBe(true)
  const invalidCostMessage = await runtime.bun.password.hash("mars-secret", { cost: 0 }).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )
  const tooLargeCostMessage = await runtime.bun.password.hash("mars-secret", { cost: 18 }).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )

  expect(invalidCostMessage).toBe("Invalid password cost: 0")
  expect(tooLargeCostMessage).toBe("Invalid password cost: 18")

  await runtime.dispose()
})

test("Phase 3 Bun.sql stores and queries rows through MarsVFS", async () => {
  const runtime = await createMarsRuntime({ runtimeFeatures: { sql: true } })
  const db = runtime.bun.sql.db
  const databasePath = db.path

  await db.exec("create table if not exists notes (id integer primary key, title text, done integer)")
  await db.run("insert into notes (title, done) values (?, ?)", ["first", 0])
  await db.run("insert into notes (title, done) values (?, ?)", ["second", 1])
  await db.run("update notes set title = ? where id = ?", ["first-updated", 1])
  const activeRows = await db.all("select id, title, done from notes where done = ? order by id", [0])
  const countRow = await db.get("select count(*) as total from notes")
  const taggedRows = await runtime.bun.sql`select title from notes where id = ${1}`
  await db.run("delete from notes where id = ?", [2])
  await db.close()

  const persistedBytes = await runtime.vfs.readFile(databasePath)
  const reopened = runtime.bun.sql.open(databasePath)
  const reopenedRows = await reopened.all("select id, title from notes order by id")

  expect(activeRows).toEqual([{ id: 1, title: "first-updated", done: 0 }])
  expect(countRow).toEqual({ total: 2 })
  expect((persistedBytes as Uint8Array).byteLength > 0).toBe(true)
  expect(reopenedRows).toEqual([{ id: 1, title: "first-updated" }])
  expect(taggedRows).toEqual([{ title: "first-updated" }])

  await runtime.dispose()
})

test("Phase 3 Bun.sql supports BEGIN/COMMIT/ROLLBACK transaction semantics", async () => {
  const runtime = await createMarsRuntime({ runtimeFeatures: { sql: true } })
  const db = runtime.bun.sql.db
  const databasePath = db.path

  await db.exec("create table if not exists tx_notes (id integer primary key, title text)")

  await db.exec("begin")
  await db.run("insert into tx_notes (title) values (?)", ["rollback-row"])
  await db.exec("rollback")

  const rolledBackCount = await db.get<{ total: number }>("select count(*) as total from tx_notes")

  await db.exec("begin transaction")
  await db.run("insert into tx_notes (title) values (?)", ["commit-row"])
  await db.exec("commit")
  await db.close()

  const reopened = runtime.bun.sql.open(databasePath)
  const rows = await reopened.all<{ id: number; title: string }>("select id, title from tx_notes order by id")

  expect(rolledBackCount).toEqual({ total: 0 })
  expect(rows).toEqual([{ id: 1, title: "commit-row" }])

  await reopened.close()
  await runtime.dispose()
})

test("Phase 3 VFS snapshot serializes and restores workspace files", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "snapshot.txt": "snapshot survives restore",
      },
    },
  })
  const snapshot = await snapshotVFS(runtime.vfs, "/workspace")
  const restoredRuntime = await createMarsRuntime()

  await restoreVFSSnapshot(restoredRuntime.vfs, snapshot, "/workspace/restored")

  expect(await restoredRuntime.vfs.readFile("/workspace/restored/src/snapshot.txt", "utf8")).toBe(
    "snapshot survives restore",
  )

  await restoredRuntime.dispose()
  await runtime.dispose()
})

test("Phase 3 OPFS persistence adapter stores snapshot bytes with memory fallback", async () => {
  const adapter = createOPFSPersistenceAdapter({ fallback: "memory" })
  await adapter.open()
  await adapter.set("workspace-snapshot", "opfs fallback persists bytes")

  const stored = await adapter.get("workspace-snapshot")
  expect(adapter.kind).toBe("memory")
  expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe("opfs fallback persists bytes")
  expect(await adapter.keys()).toEqual(["workspace-snapshot"])

  await adapter.delete("workspace-snapshot")
  expect(await adapter.get("workspace-snapshot")).toBe(null)
  await adapter.close()
})

test("Phase 3 OPFS persistence adapter uses OPFS scope when available", async () => {
  const opfsEntries = new Map<string, Uint8Array>()
  const scope = {
    navigator: {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async (name: string, options?: { create?: boolean }) => {
            if (!opfsEntries.has(name) && !options?.create) throw new Error("File not found")

            return {
              getFile: async () => ({
                arrayBuffer: async () => {
                  const value = opfsEntries.get(name)
                  if (!value) throw new Error("File not found")
                  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                },
              }),
              createWritable: async () => ({
                write: async (data: Uint8Array) => {
                  opfsEntries.set(name, data.slice())
                },
                close: async () => {},
              }),
            }
          },
          removeEntry: async (name: string) => {
            opfsEntries.delete(name)
          },
          keys: async function* () {
            for (const key of opfsEntries.keys()) yield key
          },
        }),
      },
    },
  }

  const adapter = createOPFSPersistenceAdapter({
    namespace: "phase3",
    scope: scope as typeof globalThis,
  })
  await adapter.open()
  await adapter.set("workspace-snapshot", "opfs available")
  await adapter.set("workspace-log", "opfs log")
  opfsEntries.set("other:workspace-snapshot", new TextEncoder().encode("other namespace"))

  expect(adapter.kind).toBe("opfs")
  expect(new TextDecoder().decode((await adapter.get("workspace-snapshot")) ?? new Uint8Array())).toBe("opfs available")
  expect(await adapter.has("workspace-snapshot")).toBe(true)
  expect(await adapter.has("missing")).toBe(false)
  expect(await adapter.size()).toBe(2)
  expect(await adapter.keys()).toEqual(["workspace-log", "workspace-snapshot"])

  await adapter.delete("workspace-snapshot")
  expect(await adapter.get("workspace-snapshot")).toBe(null)
  expect(await adapter.size()).toBe(1)
  await adapter.clear()
  expect(await adapter.keys()).toEqual([])
  expect(opfsEntries.has("other:workspace-snapshot")).toBe(true)
  await adapter.close()
})

test("Phase 3 browser capabilities and profiles are described", () => {
  const capabilities = detectMarsCapabilities()
  const profileCapabilities = {
    ...capabilities,
    serviceWorker: true,
    sharedArrayBuffer: false,
    atomicsWait: false,
    opfs: false,
    webCrypto: true,
    worker: true,
  }
  const profiles = createBrowserTestProfiles(profileCapabilities)
  const automationProfiles = createBrowserAutomationProfiles(profileCapabilities)

  expect(typeof capabilities.webCrypto).toBe("boolean")
  expect(profiles.find(profile => profile.id === "async-fallback")?.enabled).toBe(true)
  expect(profiles.find(profile => profile.id === "service-worker-modules")?.enabled).toBe(true)
  expect(profiles.find(profile => profile.id === "sab-worker")?.enabled).toBe(false)
  expect(automationProfiles.map(profile => profile.id)).toEqual([
    "chromium-sab-service-worker",
    "chromium-opfs-persistence",
    "firefox-async-fallback",
    "firefox-service-worker-modules",
  ])
  expect(automationProfiles.find(profile => profile.id === "chromium-sab-service-worker")?.enabled).toBe(false)
  expect(automationProfiles.find(profile => profile.id === "firefox-service-worker-modules")?.enabled).toBe(true)
})

test("Phase 3 browser automation run plan wires enabled profiles to runner args", () => {
  const plan = createBrowserAutomationRunPlan({
    capabilities: {
      serviceWorker: true,
      sharedArrayBuffer: false,
      atomicsWait: false,
      opfs: false,
      webCrypto: true,
      worker: true,
      crossOriginIsolated: false,
      broadcastChannel: false,
      indexedDB: false,
    },
    command: "playwright",
    baseArgs: ["test", "--reporter=line"],
    env: {
      MARS_E2E: "1",
    },
  })

  expect(plan.map(target => target.profileId)).toEqual([
    "firefox-async-fallback",
    "firefox-service-worker-modules",
  ])
  expect(plan[0]).toEqual({
    profileId: "firefox-async-fallback",
    engine: "firefox",
    enabled: true,
    notes: "Firefox baseline profile for async fallback paths when SAB or OPFS are unavailable.",
    command: "playwright",
    args: [
      "test",
      "--reporter=line",
      "--project=firefox",
      "--grep=firefox-async-fallback",
    ],
    env: {
      MARS_E2E: "1",
      MARS_BROWSER_PROFILE: "firefox-async-fallback",
    },
  })
  expect(plan[1].args).toEqual([
    "test",
    "--reporter=line",
    "--project=firefox",
    "--grep=firefox-service-worker-modules",
  ])
  expect(plan[1].env).toEqual({
    MARS_E2E: "1",
    MARS_BROWSER_PROFILE: "firefox-service-worker-modules",
  })
})

test("Phase 3 browser automation runner executes plan targets and summarizes results", async () => {
  const summary = await runBrowserAutomationPlan({
    plan: {
      capabilities: {
        serviceWorker: true,
        sharedArrayBuffer: false,
        atomicsWait: false,
        opfs: false,
        webCrypto: true,
        worker: true,
        crossOriginIsolated: false,
        broadcastChannel: false,
        indexedDB: false,
      },
      command: "playwright",
      baseArgs: ["test"],
      env: {
        MARS_E2E: "1",
      },
    },
    executor: {
      execute: async target => {
        if (target.profileId === "firefox-service-worker-modules") {
          return {
            exitCode: 1,
            stderr: "service worker module timeout",
          }
        }

        return {
          exitCode: 0,
          stdout: `ok:${target.profileId}`,
        }
      },
    },
  })

  expect(summary.passed).toBe(false)
  expect(summary.results.map(result => result.profileId)).toEqual([
    "firefox-async-fallback",
    "firefox-service-worker-modules",
  ])
  expect(summary.results[0].passed).toBe(true)
  expect(summary.results[0].stdout).toBe("ok:firefox-async-fallback")
  expect(summary.results[1].passed).toBe(false)
  expect(summary.results[1].stderr).toBe("service worker module timeout")
})

test("Phase 3 browser automation runner supports stopOnFailure", async () => {
  const summary = await runBrowserAutomationPlan({
    targets: [
      {
        profileId: "firefox-async-fallback",
        engine: "firefox",
        enabled: true,
        notes: "phase3",
        command: "playwright",
        args: ["test", "--grep=firefox-async-fallback"],
        env: { MARS_BROWSER_PROFILE: "firefox-async-fallback" },
      },
      {
        profileId: "firefox-service-worker-modules",
        engine: "firefox",
        enabled: true,
        notes: "phase3",
        command: "playwright",
        args: ["test", "--grep=firefox-service-worker-modules"],
        env: { MARS_BROWSER_PROFILE: "firefox-service-worker-modules" },
      },
      {
        profileId: "chromium-opfs-persistence",
        engine: "chromium",
        enabled: true,
        notes: "phase3",
        command: "playwright",
        args: ["test", "--grep=chromium-opfs-persistence"],
        env: { MARS_BROWSER_PROFILE: "chromium-opfs-persistence" },
      },
    ],
    stopOnFailure: true,
    executor: {
      execute: async target => ({
        exitCode: target.profileId === "firefox-service-worker-modules" ? 2 : 0,
      }),
    },
  })

  expect(summary.passed).toBe(false)
  expect(summary.results.map(result => result.profileId)).toEqual([
    "firefox-async-fallback",
    "firefox-service-worker-modules",
  ])
  expect(summary.results[1].exitCode).toBe(2)
})

test("Phase 3 browser automation runner can execute targets through Bun.spawn", async () => {
  const executedCommands: string[][] = []
  const executor = createBunSpawnBrowserAutomationExecutor({
    scope: {
      Bun: {
        spawn: options => {
          executedCommands.push(options.cmd)
          return {
            stdout: new ReadableStream<Uint8Array>({
              start: controller => {
                controller.enqueue(new TextEncoder().encode(`ok:${options.cmd.join(" ")}`))
                controller.close()
              },
            }),
            stderr: new ReadableStream<Uint8Array>({
              start: controller => {
                controller.close()
              },
            }),
            exited: Promise.resolve(0),
          }
        },
      },
    },
  })

  const summary = await runBrowserAutomationPlan({
    targets: [
      {
        profileId: "firefox-async-fallback",
        engine: "firefox",
        enabled: true,
        notes: "phase3",
        command: "playwright",
        args: ["test", "--grep=firefox-async-fallback"],
        env: { MARS_BROWSER_PROFILE: "firefox-async-fallback" },
      },
    ],
    executor,
  })

  expect(summary.passed).toBe(true)
  expect(summary.results[0].stdout).toBe("ok:playwright test --grep=firefox-async-fallback")
  expect(executedCommands).toEqual([["playwright", "test", "--grep=firefox-async-fallback"]])
})

test("Phase 3 browser automation runner reports missing Bun runtime", async () => {
  const executor = createBunSpawnBrowserAutomationExecutor({ scope: {} })

  const summary = await runBrowserAutomationPlan({
    targets: [
      {
        profileId: "firefox-async-fallback",
        engine: "firefox",
        enabled: true,
        notes: "phase3",
        command: "playwright",
        args: ["test", "--grep=firefox-async-fallback"],
        env: { MARS_BROWSER_PROFILE: "firefox-async-fallback" },
      },
    ],
    executor,
  })

  expect(summary.passed).toBe(false)
  expect(summary.results[0].exitCode).toBe(1)
  expect(summary.results[0].stderr).toContain("Bun runtime is not available")
})

test("Phase 3 playground host enables SharedArrayBuffer and ServiceWorker preconditions", async () => {
  const viteConfig = await readPlaygroundText("vite.config.ts")
  const browserRuntime = await readPlaygroundText("src/browser-runtime.ts")
  const appSource = await readPlaygroundText("src/App.tsx")
  const playgroundReadme = await readPlaygroundText("README.md")

  expect(viteConfig).toContain("Cross-Origin-Opener-Policy")
  expect(viteConfig).toContain("Cross-Origin-Embedder-Policy")
  expect(viteConfig).toContain("Cross-Origin-Resource-Policy")
  expect(viteConfig).toContain("service-worker-allowed")
  expect(viteConfig).toContain("fallback: 'network'")
  expect(viteConfig).toContain("bootPromise")
  expect(viteConfig.includes("await restoreVFSSnapshot")).toBe(false)
  expect(browserRuntime).toContain("secureContext")
  expect(browserRuntime).toContain("ensurePlaygroundRuntimeStatus")
  expect(browserRuntime).toContain("phase3-playground-host-runtime")
  expect(browserRuntime).toContain("serviceWorkerRequiresReload")
  expect(appSource).toContain("Browser Runtime")
  expect(appSource).toContain("Service Worker")
  expect(appSource).toContain("Origin")
  expect(appSource).toContain("SW script")
  expect(appSource).toContain("Start / Refresh SW")
  expect(playgroundReadme).toContain("当前主流程架构")
  expect(playgroundReadme).toContain("bootPromise")
  expect(playgroundReadme).toContain("/__mars__/module?path=...")
})

test("Phase 3 architecture docs describe the current browser runtime flow", async () => {
  const compatibilityDoc = await readPlaygroundText("../docs/compatibility/bun-api.md")
  const rfc = await readPlaygroundText("../rfc/0001-mars-lib-technical-design.md")

  expect(compatibilityDoc).toContain("页面 host、ServiceWorker scope、Kernel/Process Worker 和 VFS/module graph")
  expect(compatibilityDoc).toContain("bootPromise")
  expect(compatibilityDoc).toContain("sw.vfs.patch")
  expect(compatibilityDoc).toContain("process.worker.vfs.patch")
  expect(rfc).toContain("当前主流程由四个运行时边界组成")
  expect(rfc).toContain("ServiceWorkerRouter")
  expect(rfc).toContain("/__mars__/module?path=...")
})

test("Phase 3 playground module cases include bun run prework", async () => {
  const cases = await loadPlaygroundModuleCases()
  const bunRunCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-run-index")
  const bunSpawnCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-spawn-run-index")
  const cryptoCase = cases.find(playgroundCase => playgroundCase.id === "phase3-crypto-hasher")
  const passwordCase = cases.find(playgroundCase => playgroundCase.id === "phase3-password")
  const sqliteCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-sql")
  const sqliteTransactionCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-sql-transaction")
  const sqliteWasmCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-sql-wasm")
  const snapshotCase = cases.find(playgroundCase => playgroundCase.id === "phase3-vfs-snapshot")
  const stdioCase = cases.find(playgroundCase => playgroundCase.id === "phase3-kernel-stdio")
  const opfsCase = cases.find(playgroundCase => playgroundCase.id === "phase3-opfs-persistence")
  const processWorkerCase = cases.find(playgroundCase => playgroundCase.id === "phase3-process-worker-factory")
  const processWorkerScriptCase = cases.find(playgroundCase => playgroundCase.id === "phase3-process-worker-script")
  const realBrowserWorkerSmokeCase = cases.find(playgroundCase => playgroundCase.id === "phase3-real-browser-worker-smoke")
  const bridgeChainCase = cases.find(playgroundCase => playgroundCase.id === "phase3-sw-kernel-process-bridge")
  const serviceWorkerRegistrationCase = cases.find(playgroundCase => playgroundCase.id === "phase3-service-worker-registration")
  const serviceWorkerBootstrapCase = cases.find(playgroundCase => playgroundCase.id === "phase3-service-worker-bootstrap")
  const serviceWorkerModuleResponseCase = cases.find(playgroundCase => playgroundCase.id === "phase3-service-worker-module-response")
  const serviceWorkerScopeSmokeCase = cases.find(playgroundCase => playgroundCase.id === "phase3-service-worker-scope-smoke")
  const kernelWorkerBootstrapCase = cases.find(playgroundCase => playgroundCase.id === "phase3-kernel-worker-bootstrap")
  const playgroundHostRuntimeCase = cases.find(playgroundCase => playgroundCase.id === "phase3-playground-host-runtime")

  expect(bunRunCase?.status).toBe("prework")
  expect(bunRunCase?.module).toBe("bun-run")
  expect(await readPlaygroundCaseEntry(bunRunCase?.entry ?? "")).toContain("bun run index")
  expect(bunSpawnCase?.status).toBe("prework")
  expect(bunSpawnCase?.module).toBe("bun-spawn")
  expect(await readPlaygroundCaseEntry(bunSpawnCase?.entry ?? "")).toContain("bun run index")
  expect(cryptoCase?.status).toBe("prework")
  expect(cryptoCase?.module).toBe("crypto")
  expect(await readPlaygroundCaseEntry(cryptoCase?.entry ?? "")).toContain("expectedSha256Hex")
  expect(await readPlaygroundCaseEntry(cryptoCase?.entry ?? "")).toContain("expectedMd5Hex")
  expect(passwordCase?.status).toBe("prework")
  expect(passwordCase?.module).toBe("password")
  expect(await readPlaygroundCaseEntry(passwordCase?.entry ?? "")).toContain("passwordFixtureText")
  expect(sqliteCase?.status).toBe("prework")
  expect(sqliteCase?.module).toBe("sqlite")
  expect(await readPlaygroundCaseEntry(sqliteCase?.entry ?? "")).toContain("sqliteDatabasePath")
  expect(sqliteTransactionCase?.status).toBe("prework")
  expect(sqliteTransactionCase?.module).toBe("sqlite-transaction")
  expect(await readPlaygroundCaseEntry(sqliteTransactionCase?.entry ?? "")).toContain("sqliteTransactionTableName")
  expect(sqliteWasmCase?.status).toBe("prework")
  expect(sqliteWasmCase?.module).toBe("sqlite-wasm")
  expect(await readPlaygroundCaseEntry(sqliteWasmCase?.entry ?? "")).toContain("sqliteWasmHeaderPrefix")
  expect(snapshotCase?.status).toBe("prework")
  expect(snapshotCase?.module).toBe("vfs-snapshot")
  expect(await readPlaygroundCaseEntry(snapshotCase?.entry ?? "")).toContain("snapshotSourceText")
  expect(stdioCase?.status).toBe("prework")
  expect(stdioCase?.module).toBe("kernel-stdio")
  expect(await readPlaygroundCaseEntry(stdioCase?.entry ?? "")).toContain("stdinFixtureText")
  expect(opfsCase?.status).toBe("prework")
  expect(opfsCase?.module).toBe("opfs-persistence")
  expect(await readPlaygroundCaseEntry(opfsCase?.entry ?? "")).toContain("opfsSnapshotKey")
  expect(processWorkerCase?.status).toBe("prework")
  expect(processWorkerCase?.module).toBe("process-worker")
  expect(await readPlaygroundCaseEntry(processWorkerCase?.entry ?? "")).toContain("processWorkerMessage")
  expect(processWorkerScriptCase?.status).toBe("prework")
  expect(processWorkerScriptCase?.module).toBe("process-worker-script")
  expect(await readPlaygroundCaseEntry(processWorkerScriptCase?.entry ?? "")).toContain("processWorkerScriptSource")
  expect(realBrowserWorkerSmokeCase?.status).toBe("smoke")
  expect(realBrowserWorkerSmokeCase?.module).toBe("real-browser-worker-smoke")
  expect(await readPlaygroundCaseEntry(realBrowserWorkerSmokeCase?.entry ?? "")).toContain("processWorkerBrowserSmokeSource")
  expect(await readPlaygroundCaseEntry(realBrowserWorkerSmokeCase?.entry ?? "")).toContain("processWorkerBrowserSmokeSnapshotRoot")
  expect(await readPlaygroundCaseEntry(realBrowserWorkerSmokeCase?.entry ?? "")).toContain("processWorkerBrowserSmokePatchMode")
  expect(bridgeChainCase?.status).toBe("prework")
  expect(bridgeChainCase?.module).toBe("sw-kernel-process-bridge")
  expect(await readPlaygroundCaseEntry(bridgeChainCase?.entry ?? "")).toContain("serviceWorkerBridgePath")
  expect(serviceWorkerRegistrationCase?.status).toBe("prework")
  expect(serviceWorkerRegistrationCase?.module).toBe("service-worker-registration")
  expect(await readPlaygroundCaseEntry(serviceWorkerRegistrationCase?.entry ?? "")).toContain("serviceWorkerScriptURL")
  expect(serviceWorkerBootstrapCase?.status).toBe("prework")
  expect(serviceWorkerBootstrapCase?.module).toBe("service-worker-bootstrap")
  expect(await readPlaygroundCaseEntry(serviceWorkerBootstrapCase?.entry ?? "")).toContain("serviceWorkerBootstrapConnectType")
  expect(serviceWorkerModuleResponseCase?.status).toBe("prework")
  expect(serviceWorkerModuleResponseCase?.module).toBe("service-worker-module-response")
  expect(await readPlaygroundCaseEntry(serviceWorkerModuleResponseCase?.entry ?? "")).toContain("serviceWorkerModuleEntry")
  expect(serviceWorkerScopeSmokeCase?.status).toBe("smoke")
  expect(serviceWorkerScopeSmokeCase?.module).toBe("service-worker-scope-smoke")
  expect(await readPlaygroundCaseEntry(serviceWorkerScopeSmokeCase?.entry ?? "")).toContain("serviceWorkerScopeSmokeScriptURL")
  expect(await readPlaygroundCaseEntry(serviceWorkerScopeSmokeCase?.entry ?? "")).toContain("serviceWorkerScopeSmokePatchMode")
  expect(await readPlaygroundCaseEntry(serviceWorkerScopeSmokeCase?.entry ?? "")).toContain("serviceWorkerScopeSmokeFetchMode")
  expect(await readPlaygroundText("src/browser-runtime.ts")).toContain("const nativeResponse = await fetch(moduleRequestUrl)")
  expect(await readPlaygroundText("src/browser-runtime.ts")).toContain("fetch=${serviceWorkerScopeSmokeFetchMode}")
  expect(kernelWorkerBootstrapCase?.status).toBe("prework")
  expect(kernelWorkerBootstrapCase?.module).toBe("kernel-worker-bootstrap")
  expect(await readPlaygroundCaseEntry(kernelWorkerBootstrapCase?.entry ?? "")).toContain("kernelWorkerConnectType")
  expect(playgroundHostRuntimeCase?.status).toBe("smoke")
  expect(playgroundHostRuntimeCase?.module).toBe("playground-host-runtime")
  expect(await readPlaygroundCaseEntry(playgroundHostRuntimeCase?.entry ?? "")).toContain("playgroundHostRequiresSharedArrayBuffer")
})

test("Phase 3 Bun.serve WebSocket upgrade creates bidirectional WebSocket connection", async () => {
  const received: (string | Uint8Array)[] = []
  const closeCodes: number[] = []

  const { serverWs, clientWs } = createWebSocketPair<{ id: string }>(
    { id: "test-conn" },
  )

  expect(serverWs.readyState).toBe(1)
  expect(serverWs.data.id).toBe("test-conn")
  expect(clientWs.readyState).toBe(1)

  clientWs.onmessage = event => received.push(event.data as string)
  clientWs.onclose = event => closeCodes.push(event.code)

  // Server sends a message to client
  serverWs.send("hello from server")
  expect(received).toEqual(["hello from server"])

  // Client sends a message to server
  clientWs.send("hello from client")

  // Server closes the connection
  serverWs.close(1000, "done")
  expect(serverWs.readyState).toBe(3)
  expect(clientWs.readyState).toBe(3)
  expect(closeCodes).toEqual([1000])
})

test("Phase 3 upgradeToWebSocket triggers websocket handler open/message/close lifecycle", async () => {
  const openArgs: string[] = []
  const messages: (string | Uint8Array)[] = []
  const closeArgs: number[] = []

  const clientWs = upgradeToWebSocket<{ user: string }>(
    {
      open: ws => openArgs.push(ws.data.user),
      message: (_ws, msg) => messages.push(msg),
      close: (_ws, code) => closeArgs.push(code),
    },
    { user: "alice" },
  )

  expect(clientWs).not.toBeNull()
  expect(openArgs).toEqual(["alice"])

  // Client sends to server
  clientWs!.send("ping")
  expect(messages).toEqual(["ping"])

  // Client close triggers server close callback
  clientWs!.close(1001, "going away")
  expect(closeArgs).toEqual([1001])
  expect(clientWs!.readyState).toBe(3)
})

test("Phase 3 ServiceWorker classifies ws://mars.localhost URL as websocket", () => {
  expect(classifyRequest(new URL("ws://mars.localhost:3000/chat"))).toBe("websocket")
  expect(classifyRequest(new URL("wss://mars.localhost:3000/chat"))).toBe("websocket")
  expect(classifyRequest(new URL("ws://example.com/chat"))).toBe("external")
  expect(classifyRequest(new URL("http://mars.localhost:3000/api"))).toBe("virtual-server")
})

test("Phase 3 ServiceWorkerRouter returns 426 for ws://mars.localhost WebSocket request", async () => {
  const kernel = createMarsKernel()
  await kernel.boot()

  const router = createServiceWorkerRouter({
    fallback: "network",
    kernelClient: {
      resolvePort: async () => null,
      dispatchToKernel: async () => new Response("not reached"),
    },
    vfsClient: {
      readFile: async () => null,
      stat: async () => null,
      contentType: () => "application/octet-stream",
    },
  })

  const wsRequest = new Request("ws://mars.localhost:3000/chat", {
    headers: { upgrade: "websocket" },
  })

  const context = await router.match(wsRequest)
  expect(context).not.toBeNull()
  expect(context!.kind).toBe("websocket")

  const response = await router.handle(context!)
  expect(response.status).toBe(426)
  expect(response.headers.get("x-mars-ws-port")).toBe("3000")
  expect(response.headers.get("x-mars-ws-pathname")).toBe("/chat")

  await kernel.shutdown()
})

test("Phase 3 handleWebSocketRoute returns diagnostic 426 response", () => {
  const response = handleWebSocketRoute({
    url: new URL("ws://mars.localhost:8080/ws"),
    request: new Request("ws://mars.localhost:8080/ws"),
  })

  expect(response.status).toBe(426)
  expect(response.headers.get("upgrade")).toBe("websocket")
  expect(response.headers.get("x-mars-ws-port")).toBe("8080")
  expect(response.headers.get("x-mars-ws-pathname")).toBe("/ws")
})

test("Phase 3 compat matrix includes WebSocket upgrade entry for Bun.serve", () => {
  const entry = getBunApiCompat("Bun.serve")
  expect(entry).not.toBeNull()
  expect(entry!.tests).toContain("Phase 3 Bun.serve WebSocket upgrade creates bidirectional WebSocket connection")
  expect(entry!.notes).toContain("MarsServerWebSocket")
})

test("Phase 3 node crypto subset covers timingSafeEqual, getHashes and pbkdf2Async", async () => {
  const encoder = new TextEncoder()
  const a = encoder.encode("mars-equal-test")
  const b = encoder.encode("mars-equal-test")
  const c = encoder.encode("different-input!")

  expect(timingSafeEqual(a, b)).toBe(true)
  expect(timingSafeEqual(a, c)).toBe(false)
  expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)

  const hashes = getHashes()
  expect(hashes).toContain("sha256")
  expect(hashes).toContain("sha512")
  expect(hashes).toContain("md5")
  expect(hashes).toContain("sha1")

  const derivedKey = await pbkdf2Async("mars-password", "mars-salt", 1_000, 32, "sha256")
  expect(derivedKey instanceof Uint8Array).toBe(true)
  expect(derivedKey.byteLength).toBe(32)

  const derivedKeySha512 = await pbkdf2Async("mars-password", "mars-salt", 1_000, 64, "sha512")
  expect(derivedKeySha512.byteLength).toBe(64)

  const derivedKeyA = await pbkdf2Async("mars-password", "mars-salt", 1_000, 32, "sha256")
  const derivedKeyB = await pbkdf2Async("mars-password", "mars-salt", 1_000, 32, "sha256")
  expect(timingSafeEqual(derivedKeyA, derivedKeyB)).toBe(true)
})

test("Phase 3 Bun.password recognizes bcrypt and argon2 format and throws explicit error", async () => {
  const bcrypt2yHash = "$2y$10$someHashValueHere/abcdefghijklm/nopqrstuvwxyz1234567890"
  const bcrypt2bHash = "$2b$12$anotherBcryptHashValue/abcdefghijklmno/pqrstuvwxyz01234"
  const argon2Hash = "$argon2id$v=19$m=65536,t=3,p=4$someSaltValue$someHashValue"

  const bcrypt2yError = await marsPassword.verify("any-password", bcrypt2yHash).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )
  const bcrypt2bError = await marsPassword.verify("any-password", bcrypt2bHash).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )
  const argon2Error = await marsPassword.verify("any-password", argon2Hash).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )
  const bcryptHashError = await marsPassword.hash("any-password", { algorithm: "bcrypt" }).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )
  const argon2IdHashError = await marsPassword.hash("any-password", { algorithm: "argon2id" }).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  )

  expect(bcrypt2yError).toContain("bcrypt")
  expect(bcrypt2yError).toContain("not supported")
  expect(bcrypt2bError).toContain("bcrypt")
  expect(bcrypt2bError).toContain("not supported")
  expect(argon2Error).toContain("argon2")
  expect(argon2Error).toContain("not supported")
  expect(bcryptHashError).toContain("bcrypt")
  expect(bcryptHashError).toContain("not available")
  expect(argon2IdHashError).toContain("argon2id")
  expect(argon2IdHashError).toContain("not available")
})

test("Phase 3 Bun.password handles binary inputs and malformed Mars hashes", async () => {
  const encoder = new TextEncoder()
  const passwordBytes = encoder.encode("mars-binary-secret")
  const saltBytes = encoder.encode("fixed-salt-123456")
  const hash = await marsPassword.hash(passwordBytes.buffer.slice(0), {
    iterations: 1_000,
    salt: saltBytes,
  })

  expect(await marsPassword.verify(passwordBytes, hash)).toBe(true)
  expect(await marsPassword.verify(encoder.encode("wrong-secret"), hash)).toBe(false)
  expect(await marsPassword.verify("mars-binary-secret", "$mars$pbkdf2-sha256$0$bad$bad")).toBe(false)
  expect(await marsPassword.verify("mars-binary-secret", "$mars$pbkdf2-sha256$1000$not valid$bad")).toBe(false)
  expect(await marsPassword.verify("mars-binary-secret", "$mars$pbkdf2-sha256$1000$Zm9v$YmFy")).toBe(false)
})

test("Phase 3 CryptoHasher supports sha384 algorithm", async () => {
  const hasher = new MarsCryptoHasher("sha384")
  expect(hasher.algorithm).toBe("sha384")

  hasher.update("hello mars")
  const hex = await hasher.digest("hex")
  expect(typeof hex).toBe("string")
  expect((hex as string).length).toBe(96)

  const base64 = await new MarsCryptoHasher("sha384").update("hello mars").digest("base64")
  expect(typeof base64).toBe("string")
  expect((base64 as string).length > 60).toBe(true)

  const direct = await createHashDigest("sha384", "hello mars", "hex")
  expect(direct).toBe(hex)
})

test("Phase 3 CryptoHasher copy method duplicates hasher state", async () => {
  const original = new MarsCryptoHasher("sha256")
  original.update("hello ")

  const clone = original.copy()
  clone.update("world")

  original.update("world")

  const originalHex = await original.digest("hex")
  const cloneHex = await clone.digest("hex")
  expect(originalHex).toBe(cloneHex)

  const freshHex = await new MarsCryptoHasher("sha256").update("hello world").digest("hex")
  expect(originalHex).toBe(freshHex)

  const earlyClone = new MarsCryptoHasher("md5")
  earlyClone.update("abc")
  const earlyCloneCopy = earlyClone.copy()
  earlyCloneCopy.update("def")
  earlyClone.update("def")

  const earlyCloneHex = await earlyClone.digest("hex")
  const earlyCloneCopyHex = await earlyCloneCopy.digest("hex")
  expect(earlyCloneHex).toBe(earlyCloneCopyHex)
})

test("Phase 3 CryptoHasher digestSync returns sync result for md5 and throws for sha algorithms", () => {
  const md5Hasher = new MarsCryptoHasher("md5")
  md5Hasher.update("hello mars")
  const md5Hex = md5Hasher.digestSync("hex")
  expect(typeof md5Hex).toBe("string")
  expect((md5Hex as string).length).toBe(32)

  const md5HexAgain = new MarsCryptoHasher("md5").update("hello mars").digestSync()
  expect(md5HexAgain).toBe(md5Hex)

  const md5Base64 = new MarsCryptoHasher("md5").update("hello mars").digestSync("base64")
  expect(typeof md5Base64).toBe("string")

  const shaHasher = new MarsCryptoHasher("sha256")
  shaHasher.update("hello mars")

  let sha256SyncError: string | null = null
  try {
    shaHasher.digestSync("hex")
  } catch (error) {
    sha256SyncError = error instanceof Error ? error.message : String(error)
  }
  expect(sha256SyncError).not.toBeNull()
  expect(sha256SyncError).toContain("sha256")
  expect(sha256SyncError).toContain("digest")
})

test("Phase 3 Bun.spawnSync supports built-in commands and VFS-backed reads", () => {
  const vfs = createMarsVFS({ cwd: "/workspace/app" })
  const kernel = createMarsKernel()
  const bun = createMarsBun({ kernel, vfs })

  vfs.mkdirSync("notes", { recursive: true })
  vfs.writeFileSync("notes/a.txt", "alpha\n")
  vfs.writeFileSync("notes/b.txt", "beta\n")

  const trueResult = bun.spawnSync({ cmd: ["true"] })
  expect(trueResult.exitCode).toBe(0)
  expect(trueResult.success).toBe(true)

  const falseResult = bun.spawnSync({ cmd: ["false"] })
  expect(falseResult.exitCode).toBe(1)
  expect(falseResult.success).toBe(false)

  const pwdResult = bun.spawnSync({ cmd: ["pwd"] })
  expect(pwdResult.exitCode).toBe(0)
  expect(pwdResult.success).toBe(true)
  const pwdOut = new TextDecoder().decode(pwdResult.stdout)
  expect(pwdOut).toBe("/workspace/app\n")

  const printfResult = bun.spawnSync({ cmd: ["printf", "mars-sync-test"] })
  expect(printfResult.exitCode).toBe(0)
  const printfOut = new TextDecoder().decode(printfResult.stdout)
  expect(printfOut).toBe("mars-sync-test")

  const catResult = bun.spawnSync({ cmd: ["cat"] })
  expect(catResult.exitCode).toBe(0)
  expect(catResult.success).toBe(true)

  const catStdinResult = bun.spawnSync({ cmd: ["cat"], stdin: "sync stdin payload\n" })
  expect(catStdinResult.exitCode).toBe(0)
  expect(catStdinResult.success).toBe(true)
  expect(new TextDecoder().decode(catStdinResult.stdout)).toBe("sync stdin payload\n")

  const lsResult = bun.spawnSync({ cmd: ["ls", "notes"] })
  expect(lsResult.exitCode).toBe(0)
  const lsOut = new TextDecoder().decode(lsResult.stdout)
  expect(lsOut).toContain("a.txt")
  expect(lsOut).toContain("b.txt")

  const catFilesResult = bun.spawnSync({ cmd: ["cat", "notes/a.txt", "notes/b.txt"] })
  expect(catFilesResult.exitCode).toBe(0)
  expect(new TextDecoder().decode(catFilesResult.stdout)).toBe("alpha\nbeta\n")

  const grepResult = bun.spawnSync({ cmd: ["grep", "alpha", "notes/a.txt"] })
  expect(grepResult.exitCode).toBe(0)
  expect(new TextDecoder().decode(grepResult.stdout)).toBe("/workspace/app/notes/a.txt:1:alpha\n")

  const recursiveGrepResult = bun.spawnSync({ cmd: ["grep", "-R", "beta", "notes"] })
  expect(recursiveGrepResult.exitCode).toBe(0)
  expect(new TextDecoder().decode(recursiveGrepResult.stdout)).toBe("/workspace/app/notes/b.txt:1:beta\n")

  const noMatchGrepResult = bun.spawnSync({ cmd: ["grep", "missing", "notes/a.txt"] })
  expect(noMatchGrepResult.success).toBe(false)
  expect(noMatchGrepResult.exitCode).toBe(1)
  expect(new TextDecoder().decode(noMatchGrepResult.stdout)).toBe("")

  const mkdirResult = bun.spawnSync({ cmd: ["mkdir", "-p", "generated/logs"] })
  expect(mkdirResult.success).toBe(true)
  vfs.writeFileSync("generated/logs/run.txt", "created by spawnSync\n")
  expect(vfs.readFileSync("generated/logs/run.txt", "utf8")).toBe("created by spawnSync\n")

  const rmResult = bun.spawnSync({ cmd: ["rm", "generated/logs/run.txt"] })
  expect(rmResult.success).toBe(true)
  expect(vfs.existsSync("generated/logs/run.txt")).toBe(false)

  const missingCatResult = bun.spawnSync({ cmd: ["cat", "notes/missing.txt"] })
  expect(missingCatResult.success).toBe(false)
  expect(new TextDecoder().decode(missingCatResult.stderr)).toContain("missing.txt")

  const unknownResult = bun.spawnSync({ cmd: ["not-a-builtin-command", "arg1"] })
  expect(unknownResult.success).toBe(false)
  const unknownStderr = new TextDecoder().decode(unknownResult.stderr)
  expect(unknownStderr).toContain("not-a-builtin-command")
})

test("Phase 3 OPFS persistence adapter supports has, size and clear operations", async () => {
  const adapter = createOPFSPersistenceAdapter({ fallback: "memory" })
  await adapter.open()

  expect(await adapter.size()).toBe(0)
  expect(await adapter.has("missing")).toBe(false)

  await adapter.set("key-a", "value-a")
  await adapter.set("key-b", "value-b")
  await adapter.set("key-c", "value-c")

  expect(await adapter.size()).toBe(3)
  expect(await adapter.has("key-a")).toBe(true)
  expect(await adapter.has("key-b")).toBe(true)
  expect(await adapter.has("missing-key")).toBe(false)

  const keys = await adapter.keys()
  expect(keys).toEqual(["key-a", "key-b", "key-c"])

  await adapter.clear()
  expect(await adapter.size()).toBe(0)
  expect(await adapter.has("key-a")).toBe(false)
  const keysAfterClear = await adapter.keys()
  expect(keysAfterClear).toEqual([])

  await adapter.close()
})

test("Phase 3 Bun.sql prepared statements support parameterized queries", async () => {
  const vfs = createMarsVFS()
  const kernel = createMarsKernel()
  const bun = createMarsBun({ kernel, vfs, runtimeFeatures: { sql: true, esbuild: false, swc: false } })

  const db = bun.sql.open("/test-prepared.sqlite")
  await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)")
  await db.exec("INSERT INTO users (name, score) VALUES (?, ?)", ["alice", 100])
  await db.exec("INSERT INTO users (name, score) VALUES (?, ?)", ["bob", 85])
  await db.exec("INSERT INTO users (name, score) VALUES (?, ?)", ["carol", 95])

  const stmt = db.prepare<{ id: number; name: string; score: number }>(
    "SELECT * FROM users WHERE score >= ? ORDER BY score DESC",
  )

  const topTwo = await stmt.all([90])
  expect(topTwo.length).toBe(2)
  expect(topTwo[0].name).toBe("alice")
  expect(topTwo[1].name).toBe("carol")

  const stmtGet = db.prepare<{ id: number; name: string; score: number }>(
    "SELECT * FROM users WHERE name = ?",
  )
  const alice = await stmtGet.get(["alice"])
  expect(alice).not.toBeNull()
  expect(alice!.name).toBe("alice")
  expect(alice!.score).toBe(100)

  const notFound = await stmtGet.get(["dave"])
  expect(notFound).toBeNull()

  const insertStmt = db.prepare("INSERT INTO users (name, score) VALUES (?, ?)")
  const insertResult = await insertStmt.run(["dave", 70])
  expect(insertResult.changes).toBe(1)

  const allUsers = await db.all("SELECT * FROM users ORDER BY id")
  expect(allUsers.length).toBe(4)

  await insertStmt.finalize()
  let finalizedError: string | null = null
  try {
    await insertStmt.run(["eve", 60])
  } catch (error) {
    finalizedError = error instanceof Error ? error.message : String(error)
  }
  expect(finalizedError).not.toBeNull()
  expect(finalizedError).toContain("finalized")

  await db.close()
})

test("Phase 3 node crypto hkdfAsync derives key via WebCrypto HKDF", async () => {
  const key = new TextEncoder().encode("master-secret")
  const salt = new TextEncoder().encode("random-salt")
  const info = new TextEncoder().encode("mars-context-v1")

  const derived32 = await hkdfAsync("sha256", key, salt, info, 32)
  expect(derived32 instanceof Uint8Array).toBe(true)
  expect(derived32.byteLength).toBe(32)

  const derived64 = await hkdfAsync("sha512", key, salt, info, 64)
  expect(derived64.byteLength).toBe(64)

  // Same inputs should produce deterministic output
  const derived32b = await hkdfAsync("sha256", key, salt, info, 32)
  expect(timingSafeEqual(derived32, derived32b)).toBe(true)

  // Different info => different output
  const derived32c = await hkdfAsync("sha256", key, salt, new TextEncoder().encode("other-ctx"), 32)
  expect(timingSafeEqual(derived32, derived32c)).toBe(false)
})

test("Phase 3 node crypto getCiphers and getCurves return available algorithms", () => {
  const ciphers = getCiphers()
  expect(Array.isArray(ciphers)).toBe(true)

  const curves = getCurves()
  expect(Array.isArray(curves)).toBe(true)
  expect(curves).toContain("P-256")
  expect(curves).toContain("P-384")
  expect(curves).toContain("P-521")
})

test("Phase 3 node crypto createSign/Verify/CipherIV/DecipherIV throw explicit errors", () => {
  let signError: string | null = null
  try { createSign("sha256") } catch (error) { signError = error instanceof Error ? error.message : String(error) }
  expect(signError).not.toBeNull()
  expect(signError).toContain("createSign")
  expect(signError).toContain("browser context")

  let verifyError: string | null = null
  try { createVerify("sha256") } catch (error) { verifyError = error instanceof Error ? error.message : String(error) }
  expect(verifyError).not.toBeNull()
  expect(verifyError).toContain("createVerify")

  let cipherError: string | null = null
  try { createCipheriv("aes-256-gcm") } catch (error) { cipherError = error instanceof Error ? error.message : String(error) }
  expect(cipherError).not.toBeNull()
  expect(cipherError).toContain("createCipheriv")

  let decipherError: string | null = null
  try { createDecipheriv("aes-256-gcm") } catch (error) { decipherError = error instanceof Error ? error.message : String(error) }
  expect(decipherError).not.toBeNull()
  expect(decipherError).toContain("createDecipheriv")
})

test("Phase 3 capabilities detects crossOriginIsolated, broadcastChannel and indexedDB", () => {
  const caps = detectMarsCapabilities(globalThis)
  expect(typeof caps.crossOriginIsolated).toBe("boolean")
  expect(typeof caps.broadcastChannel).toBe("boolean")
  expect(typeof caps.indexedDB).toBe("boolean")

  // In Bun test environment: crossOriginIsolated is false, broadcastChannel may vary
  expect(caps.crossOriginIsolated).toBe(false)

  // All capabilities are serializable booleans
  const keys = Object.keys(caps) as (keyof typeof caps)[]
  for (const key of keys) {
    expect(typeof caps[key]).toBe("boolean")
  }

  // Capability set covers the full expected surface
  expect("serviceWorker" in caps).toBe(true)
  expect("sharedArrayBuffer" in caps).toBe(true)
  expect("opfs" in caps).toBe(true)
  expect("webCrypto" in caps).toBe(true)
  expect("worker" in caps).toBe(true)
  expect("crossOriginIsolated" in caps).toBe(true)
  expect("broadcastChannel" in caps).toBe(true)
  expect("indexedDB" in caps).toBe(true)
})

test("Phase 3 Bun.build output artifacts include hash field", async () => {
  const vfs = createMarsVFS()
  vfs.writeFileSync("/workspace/entry.ts", "export const value = 42")

  const result = await buildProject({
    entrypoints: ["/workspace/entry.ts"],
    outdir: "/dist",
    vfs,
  })

  expect(result.success).toBe(true)
  expect(result.outputs.length >= 1).toBe(true)

  const artifact = result.outputs[0]
  expect(typeof artifact.hash).toBe("string")
  expect(artifact.hash!.length).toBe(16)

  // Same content should produce same hash
  const vfs2 = createMarsVFS()
  vfs2.writeFileSync("/workspace/entry.ts", "export const value = 42")
  const result2 = await buildProject({
    entrypoints: ["/workspace/entry.ts"],
    outdir: "/dist",
    vfs: vfs2,
  })
  expect(result2.outputs[0].hash).toBe(artifact.hash)

  // Different content should produce different hash
  const vfs3 = createMarsVFS()
  vfs3.writeFileSync("/workspace/entry.ts", "export const value = 99")
  const result3 = await buildProject({
    entrypoints: ["/workspace/entry.ts"],
    outdir: "/dist",
    vfs: vfs3,
  })
  expect(result3.outputs[0].hash).not.toBe(artifact.hash)
})