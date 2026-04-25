export type PortResolver = {
  resolvePort(port: number): number | null
}

export type DispatchToKernel = (pid: number, request: Request) => Promise<Response>

export type FetchEventLike = {
  request: Request
  respondWith(response: Response | Promise<Response>): void
}

export type FetchEventTargetLike = {
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
  removeEventListener?(type: 'fetch', listener: (event: FetchEventLike) => void): void
}

export type ExtendableEventLike = {
  waitUntil(promise: Promise<unknown>): void
}

export type ServiceWorkerGlobalLike = FetchEventTargetLike & {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  removeEventListener?(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  skipWaiting?(): Promise<void> | void
  clients?: {
    claim?(): Promise<void> | void
  }
}

abstract class AbstractSwLifecycleManager {
  private cleanup: (() => void) | null = null

  install(): () => void {
    if (!this.cleanup) {
      this.cleanup = this.installInternal()
    }

    return () => this.uninstall()
  }

  uninstall(): void {
    if (!this.cleanup) return
    this.cleanup()
    this.cleanup = null
  }

  protected abstract installInternal(): () => void
}

const BUN_LOCAL_SUFFIX = '.bun.local'

function parsePortSegment(pathname: string): number | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== '__bun__') {
    return null
  }

  const port = Number(parts[1])
  if (!Number.isInteger(port) || port <= 0) {
    return null
  }

  return port
}

export function resolveVirtualPid(url: URL, resolver?: PortResolver): number | null {
  if (url.hostname.endsWith(BUN_LOCAL_SUFFIX)) {
    const firstLabel = url.hostname.slice(0, -BUN_LOCAL_SUFFIX.length)
    const pid = Number(firstLabel)
    if (Number.isInteger(pid) && pid > 0) {
      return pid
    }
  }

  const port = parsePortSegment(url.pathname)
  if (port === null) {
    return null
  }

  if (!resolver) {
    return null
  }

  return resolver.resolvePort(port)
}

export function isVirtualBunRequest(url: URL): boolean {
  return url.hostname.endsWith(BUN_LOCAL_SUFFIX) || parsePortSegment(url.pathname) !== null
}

export async function dispatchVirtualRequest(
  request: Request,
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): Promise<Response> {
  const pid = resolveVirtualPid(new URL(request.url), resolver)
  if (pid === null) {
    return new Response('Virtual route not found', { status: 404 })
  }

  return dispatchToKernel(pid, request)
}

export function createFetchRouter(
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): (request: Request) => Promise<Response | null> {
  return async request => {
    const url = new URL(request.url)
    if (!isVirtualBunRequest(url)) {
      return null
    }

    return dispatchVirtualRequest(request, resolver, dispatchToKernel)
  }
}

export function createFetchEventHandler(
  router: (request: Request) => Promise<Response | null>,
): (event: FetchEventLike) => void {
  return event => {
    event.respondWith(
      (async () => {
        const routed = await router(event.request)
        if (routed) return routed
        return fetch(event.request)
      })(),
    )
  }
}

export function installFetchInterceptor(
  target: FetchEventTargetLike,
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): () => void {
  const router = createFetchRouter(resolver, dispatchToKernel)
  const handler = createFetchEventHandler(router)
  target.addEventListener('fetch', handler)

  return () => {
    target.removeEventListener?.('fetch', handler)
  }
}

export function installServiceWorkerRuntimeWithRouter(
  target: ServiceWorkerGlobalLike,
  router: (request: Request) => Promise<Response | null>,
): () => void {
  const handler = createFetchEventHandler(router)
  target.addEventListener('fetch', handler)

  const installHandler = (event: ExtendableEventLike) => {
    event.waitUntil(Promise.resolve(target.skipWaiting?.()))
  }

  const activateHandler = (event: ExtendableEventLike) => {
    event.waitUntil(Promise.resolve(target.clients?.claim?.()))
  }

  target.addEventListener('install', installHandler)
  target.addEventListener('activate', activateHandler)

  return () => {
    target.removeEventListener?.('fetch', handler)
    target.removeEventListener?.('install', installHandler)
    target.removeEventListener?.('activate', activateHandler)
  }
}

export function installServiceWorkerRuntime(
  target: ServiceWorkerGlobalLike,
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): () => void {
  const router = createFetchRouter(resolver, dispatchToKernel)
  return installServiceWorkerRuntimeWithRouter(target, router)
}

// ─── Worker script interception (for PROCESS_EXECUTOR_WORKER_PATH etc.) ─────

export type ScriptModuleFormat = 'auto' | 'esm' | 'cjs'

export type WorkerScriptDescriptor = {
  source: string
  specifier?: string
  packageName?: string
  packageType?: 'module' | 'commonjs'
  moduleFormat?: ScriptModuleFormat
}

export type WorkerScriptRecord = string | WorkerScriptDescriptor

export type WorkerScriptStore = Map<string, WorkerScriptRecord>

export type WorkerScriptModuleType = 'esm' | 'cjs'

export type WorkerScriptProcessInput = {
  pathname: string
  descriptor: WorkerScriptDescriptor
  detectedModuleType: WorkerScriptModuleType
}

export type WorkerScriptProcessResult = {
  source: string
  contentType?: string
}

export type WorkerScriptProcessor = {
  process(input: WorkerScriptProcessInput): WorkerScriptProcessResult | Promise<WorkerScriptProcessResult>
}

export type EsbuildTransformLike = {
  initialize?: (options?: { wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }) => Promise<void>
  transform: (code: string, options: Record<string, unknown>) => Promise<{ code: string } | string>
}

type CjsToEsmTransform = (source: string, options: { sourcefile: string }) => Promise<string>

type EsbuildWorkerScriptProcessorOptions = {
  cjsToEsmTransform?: CjsToEsmTransform
  esbuildInitOptions?: { wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }
  esbuildLoader?: () => Promise<EsbuildTransformLike>
}

const DEFAULT_SCRIPT_CONTENT_TYPE = 'text/javascript'

function toDescriptor(pathname: string, record: WorkerScriptRecord): WorkerScriptDescriptor {
  if (typeof record === 'string') {
    return {
      source: record,
      specifier: pathname,
      moduleFormat: 'auto',
    }
  }

  return {
    moduleFormat: 'auto',
    specifier: pathname,
    ...record,
  }
}

function parseScriptExt(specifier: string): string {
  const clean = specifier.split('?')[0]!.split('#')[0]!
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return ''
  return clean.slice(dot).toLowerCase()
}

export function detectWorkerScriptModuleType(pathname: string, descriptor: WorkerScriptDescriptor): WorkerScriptModuleType {
  if (descriptor.moduleFormat === 'esm') {
    return 'esm'
  }

  if (descriptor.moduleFormat === 'cjs') {
    return 'cjs'
  }

  const specifier = descriptor.specifier ?? pathname
  const ext = parseScriptExt(specifier)

  if (ext === '.mjs' || ext === '.mts') {
    return 'esm'
  }

  if (ext === '.cjs' || ext === '.cts') {
    return 'cjs'
  }

  if (descriptor.packageType === 'module') {
    return 'esm'
  }

  if (descriptor.packageType === 'commonjs') {
    return 'cjs'
  }

  if (descriptor.packageName) {
    return 'cjs'
  }

  return 'esm'
}

function isAlreadyInitializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Cannot call "initialize" more than once')
}

async function defaultLoadEsbuild(): Promise<EsbuildTransformLike> {
  const loaded = (await import('esbuild-wasm')) as unknown as EsbuildTransformLike
  if (!loaded || typeof loaded.transform !== 'function') {
    throw new Error('esbuild-wasm transform is unavailable')
  }

  return loaded
}

async function createDefaultCjsToEsmTransform(
  options: Pick<EsbuildWorkerScriptProcessorOptions, 'esbuildInitOptions' | 'esbuildLoader'>,
): Promise<CjsToEsmTransform> {
  const loader = options.esbuildLoader ?? defaultLoadEsbuild
  const esbuild = await loader()
  const initOptions = options.esbuildInitOptions

  if (initOptions && typeof esbuild.initialize === 'function') {
    try {
      await esbuild.initialize(initOptions)
    } catch (error) {
      if (!isAlreadyInitializedError(error)) {
        throw error
      }
    }
  }

  return async (source, transformOptions) => {
    const result = await esbuild.transform(source, {
      loader: 'js',
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      sourcemap: false,
      sourcefile: transformOptions.sourcefile,
    })

    return typeof result === 'string' ? result : result.code
  }
}

export class PassthroughWorkerScriptProcessor implements WorkerScriptProcessor {
  process(input: WorkerScriptProcessInput): WorkerScriptProcessResult {
    return { source: input.descriptor.source, contentType: DEFAULT_SCRIPT_CONTENT_TYPE }
  }
}

export class EsbuildWorkerScriptProcessor implements WorkerScriptProcessor {
  private cjsTransformPromise: Promise<CjsToEsmTransform> | null = null

  constructor(private readonly options: EsbuildWorkerScriptProcessorOptions = {}) {}

  private async resolveTransform(): Promise<CjsToEsmTransform> {
    if (this.options.cjsToEsmTransform) {
      return this.options.cjsToEsmTransform
    }

    if (!this.cjsTransformPromise) {
      this.cjsTransformPromise = createDefaultCjsToEsmTransform(this.options)
    }

    return this.cjsTransformPromise
  }

  async process(input: WorkerScriptProcessInput): Promise<WorkerScriptProcessResult> {
    if (input.detectedModuleType === 'esm') {
      return {
        source: input.descriptor.source,
        contentType: DEFAULT_SCRIPT_CONTENT_TYPE,
      }
    }

    const sourcefile = input.descriptor.specifier ?? input.pathname
    const transform = await this.resolveTransform()
    const transformed = await transform(input.descriptor.source, { sourcefile })

    return {
      source: transformed,
      contentType: DEFAULT_SCRIPT_CONTENT_TYPE,
    }
  }
}

export function registerWorkerScript(
  store: WorkerScriptStore,
  path: string,
  source: string,
  metadata: Omit<WorkerScriptDescriptor, 'source'> = {},
): void {
  if (Object.keys(metadata).length === 0) {
    store.set(path, source)
    return
  }

  store.set(path, {
    ...metadata,
    source,
  })
}

export function createWorkerScriptRouter(
  store: WorkerScriptStore,
  processor: WorkerScriptProcessor = new PassthroughWorkerScriptProcessor(),
): (request: Request) => Promise<Response | null> {
  return async request => {
    let pathname: string
    try {
      pathname = new URL(request.url).pathname
    } catch {
      return null
    }

    const record = store.get(pathname)
    if (record === undefined) {
      return null
    }

    const descriptor = toDescriptor(pathname, record)
    const detectedModuleType = detectWorkerScriptModuleType(pathname, descriptor)
    const result = await processor.process({
      pathname,
      descriptor,
      detectedModuleType,
    })

    return new Response(result.source, {
      status: 200,
      headers: {
        'Content-Type': result.contentType ?? DEFAULT_SCRIPT_CONTENT_TYPE,
      },
    })
  }
}

export function installWorkerScriptInterceptor(
  store: WorkerScriptStore,
  target: FetchEventTargetLike,
  options: {
    processor?: WorkerScriptProcessor
  } = {},
): () => void {
  const manager = new WorkerScriptInterceptorManager(store, target, options.processor)
  return manager.install()
}

export class WorkerScriptInterceptorManager extends AbstractSwLifecycleManager {
  private readonly processor: WorkerScriptProcessor

  constructor(
    private readonly store: WorkerScriptStore,
    private readonly target: FetchEventTargetLike,
    processor?: WorkerScriptProcessor,
  ) {
    super()
    this.processor = processor ?? new PassthroughWorkerScriptProcessor()
  }

  protected installInternal(): () => void {
    const router = createWorkerScriptRouter(this.store, this.processor)

    const handler = (event: FetchEventLike) => {
      let pathname: string
      try {
        pathname = new URL(event.request.url).pathname
      } catch {
        return
      }

      if (!this.store.has(pathname)) {
        return
      }

      event.respondWith(
        (async () => {
          const routed = await router(event.request)
          if (!routed) {
            throw new Error('worker script route not found')
          }

          return routed
        })(),
      )
    }

    this.target.addEventListener('fetch', handler)
    return () => this.target.removeEventListener?.('fetch', handler)
  }
}



export type KernelSwBridge = {
  resolvePort(port: number): number | null
  subscribe(
    event: 'portRegistered',
    listener: (payload: { pid: number; port: number; host: string; protocol: 'http' | 'https' }) => void,
  ): () => void
}

export type ServeHandlerRegistry = {
  getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
}

export function createKernelPortResolver(
  kernel: { resolvePort(port: number): number | null },
): PortResolver {
  return { resolvePort: port => kernel.resolvePort(port) }
}

export function extractVirtualPort(url: URL): number | null {
  return parsePortSegment(url.pathname)
}

export function createKernelDispatcher(
  registry: ServeHandlerRegistry,
  pidPortMap: ReadonlyMap<number, number>,
): DispatchToKernel {
  return async (pid, request) => {
    const url = new URL(request.url)
    const portFromUrl = parsePortSegment(url.pathname)
    const port = portFromUrl ?? pidPortMap.get(pid) ?? null

    if (port === null) {
      return new Response('SW dispatcher: no port mapping for pid', { status: 502 })
    }

    const handler = registry.getHandler(port)
    if (!handler) {
      return new Response('SW dispatcher: no handler for port', { status: 502 })
    }

    return handler(request)
  }
}

export type KernelServiceWorkerBridgeOptions = {
  workerScripts?: WorkerScriptStore
  scriptProcessor?: WorkerScriptProcessor
}

type CompositeServiceWorkerOptions = {
  workerScripts?: WorkerScriptStore
  scriptProcessor?: WorkerScriptProcessor
}

export class WebServiceWorkerManager extends AbstractSwLifecycleManager {
  constructor(
    private readonly target: ServiceWorkerGlobalLike,
    private readonly resolver: PortResolver,
    private readonly dispatchToKernel: DispatchToKernel,
    private readonly options: CompositeServiceWorkerOptions = {},
  ) {
    super()
  }

  protected installInternal(): () => void {
    const kernelRouter = createFetchRouter(this.resolver, this.dispatchToKernel)
    const workerScriptRouter = this.options.workerScripts
      ? createWorkerScriptRouter(
          this.options.workerScripts,
          this.options.scriptProcessor ?? new PassthroughWorkerScriptProcessor(),
        )
      : null

    const compositeRouter = async (request: Request): Promise<Response | null> => {
      if (workerScriptRouter) {
        const workerScriptResponse = await workerScriptRouter(request)
        if (workerScriptResponse) {
          return workerScriptResponse
        }
      }

      return kernelRouter(request)
    }

    return installServiceWorkerRuntimeWithRouter(this.target, compositeRouter)
  }
}

export function installServiceWorkerFromKernel(
  kernel: KernelSwBridge,
  target: ServiceWorkerGlobalLike,
  handlerRegistry: ServeHandlerRegistry,
  options: KernelServiceWorkerBridgeOptions = {},
): () => void {
  const manager = new KernelServiceWorkerBridgeManager(kernel, target, handlerRegistry, options)
  return manager.install()
}

export class KernelServiceWorkerBridgeManager extends AbstractSwLifecycleManager {
  private readonly pidPortMap = new Map<number, number>()

  constructor(
    private readonly kernel: KernelSwBridge,
    private readonly target: ServiceWorkerGlobalLike,
    private readonly handlerRegistry: ServeHandlerRegistry,
    private readonly options: KernelServiceWorkerBridgeOptions = {},
  ) {
    super()
  }

  protected installInternal(): () => void {
    const offRegistered = this.kernel.subscribe('portRegistered', ({ pid, port }) => {
      this.pidPortMap.set(pid, port)
    })

    const resolver = createKernelPortResolver(this.kernel)
    const dispatcher = createKernelDispatcher(this.handlerRegistry, this.pidPortMap)
    const manager = new WebServiceWorkerManager(this.target, resolver, dispatcher, {
      workerScripts: this.options.workerScripts,
      scriptProcessor: this.options.scriptProcessor,
    })
    const uninstallRuntime = manager.install()

    return () => {
      offRegistered()
      uninstallRuntime()
      this.pidPortMap.clear()
    }
  }
}
