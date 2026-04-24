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

/**
 * Install fetch interception on a Service Worker-like global scope.
 * Returns an unsubscribe function.
 */
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

/**
 * Install Service Worker runtime listeners:
 * - install: best-effort skipWaiting
 * - activate: best-effort clients.claim
 * - fetch: virtual request interception
 */
export function installServiceWorkerRuntime(
  target: ServiceWorkerGlobalLike,
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): () => void {
  const removeFetch = installFetchInterceptor(target, resolver, dispatchToKernel)

  const installHandler = (event: ExtendableEventLike) => {
    event.waitUntil(Promise.resolve(target.skipWaiting?.()))
  }

  const activateHandler = (event: ExtendableEventLike) => {
    event.waitUntil(Promise.resolve(target.clients?.claim?.()))
  }

  target.addEventListener('install', installHandler)
  target.addEventListener('activate', activateHandler)

  return () => {
    removeFetch()
    target.removeEventListener?.('install', installHandler)
    target.removeEventListener?.('activate', activateHandler)
  }
}
