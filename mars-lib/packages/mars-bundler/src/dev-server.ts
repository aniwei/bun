import { createModuleResponse, modulePathFromUrl } from "@mars/sw"
import { normalizePath } from "@mars/vfs"

import { createHMRChannel } from "./hmr-channel"
import { createModuleGraph } from "./module-graph"
import { createViteClientModule } from "./vite-client"
import { loadViteConfig } from "./vite-config"

import type { MarsKernel, VirtualServer } from "@mars/kernel"
import type { ResolveOptions } from "@mars/resolver"
import type { Transpiler, TransformResult } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"
import type { DevServer, HMRChannel, HMRUpdate, ViteConfigShape } from "./types"

export interface MarsDevServerOptions {
  vfs: MarsVFS
  kernel?: MarsKernel
  root?: string
  port?: number
  transpiler?: Transpiler
  resolveOptions?: ResolveOptions
  hmrChannel?: HMRChannel
}

export class MarsDevServer implements DevServer, VirtualServer {
  readonly #options: MarsDevServerOptions
  readonly #graph = createModuleGraph()
  readonly #hmrChannel: HMRChannel
  readonly #config: Promise<ViteConfigShape>
  readonly hostname = "mars.localhost"
  port: number
  #listening = false

  constructor(options: MarsDevServerOptions) {
    this.#options = options
    this.#hmrChannel = options.hmrChannel ?? createHMRChannel()
    this.#config = loadViteConfig(options.vfs, options.root ?? "/workspace")
    this.port = options.port ?? 5173
  }

  async config(): Promise<ViteConfigShape> {
    return this.#config
  }

  async listen(port = this.port): Promise<void> {
    this.port = port
    if (this.#options.kernel) this.#options.kernel.registerPort(1, port, this)
    this.#listening = true
  }

  async close(): Promise<void> {
    if (this.#options.kernel && this.#listening) this.#options.kernel.unregisterPort(this.port)
    this.#listening = false
  }

  async transformRequest(url: string): Promise<TransformResult | null> {
    if (url === "/@vite/client") {
      return {
        code: createViteClientModule(),
        imports: [],
        diagnostics: [],
      }
    }

    const config = await this.config()
    const root = this.#options.root ?? config.root
    const response = await createModuleResponse(url, {
      vfs: this.#options.vfs,
      root,
      transpiler: this.#options.transpiler,
      resolveOptions: mergeViteResolveOptions(this.#options.resolveOptions, config),
      define: config.define,
      alias: config.resolve.alias,
    })
    if (response.status >= 400) return null

    const code = await response.text()
    const path = modulePathFromUrl(url, root, config.resolve.alias)
    const imports = JSON.parse(response.headers.get("x-mars-imports") ?? "[]") as string[]

    this.#graph.updateModule(path, imports.map(importPath => ({
      path: importPath,
      kind: "import" as const,
    })))

    return {
      code,
      imports: imports.map(importPath => ({ path: importPath, kind: "import" as const })),
      diagnostics: [],
    }
  }

  async loadModule(url: string): Promise<Response> {
    if (url === "/@vite/client") {
      return new Response(createViteClientModule(), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
        },
      })
    }

    const config = await this.config()

    return createModuleResponse(url, {
      vfs: this.#options.vfs,
      root: this.#options.root ?? config.root,
      transpiler: this.#options.transpiler,
      resolveOptions: mergeViteResolveOptions(this.#options.resolveOptions, config),
      define: config.define,
      alias: config.resolve.alias,
    })
  }

  async handleHMRUpdate(file: string): Promise<HMRUpdate[]> {
    const config = await this.config()
    const path = normalizePath(file, this.#options.root ?? config.root)
    const invalidatedEntries = this.#graph.invalidate(path)
    const updates = invalidatedEntries.length
      ? invalidatedEntries.map(entry => createUpdate(entry.path))
      : [createUpdate(path)]

    this.#hmrChannel.send({
      type: "update",
      updates,
      timestamp: Date.now(),
    })

    return updates
  }

  async fetch(request: Request): Promise<Response> {
    return this.loadModule(new URL(request.url).pathname)
  }

  stop(): void {
    void this.close()
  }

  hmrChannel(): HMRChannel {
    return this.#hmrChannel
  }
}

export function createMarsDevServer(options: MarsDevServerOptions): MarsDevServer {
  return new MarsDevServer(options)
}

function createUpdate(path: string): HMRUpdate {
  return {
    type: "update",
    path,
    acceptedPath: path,
    timestamp: Date.now(),
  }
}

function mergeViteResolveOptions(
  resolveOptions: ResolveOptions | undefined,
  config: ViteConfigShape,
): ResolveOptions {
  const aliasPaths: Record<string, string[]> = {}

  for (const [alias, target] of Object.entries(config.resolve.alias)) {
    aliasPaths[alias] = [target]
    aliasPaths[`${alias}/*`] = [`${target}/*`]
  }

  return {
    ...resolveOptions,
    tsconfigPaths: {
      baseUrl: config.root,
      ...resolveOptions?.tsconfigPaths,
      paths: {
        ...aliasPaths,
        ...resolveOptions?.tsconfigPaths?.paths,
      },
    },
  }
}