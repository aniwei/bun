import type { Kernel } from '@mars/web-kernel'

export type ServeFetchHandler = (request: Request) => Response | Promise<Response>

export interface BunServeOptions {
  port?: number
  hostname?: string
  pid?: number
  fetch: ServeFetchHandler
}

export interface BunServeInstance {
  readonly port: number
  readonly hostname: string
  readonly url: string
  readonly pid: number
  fetch: ServeFetchHandler
  reload(next: Partial<Pick<BunServeOptions, 'fetch' | 'hostname'>>): void
  stop(): void
}

const serveRegistry = new Map<number, BunServeInstance>()
let autoPort = 3000

function nextPort(): number {
  while (serveRegistry.has(autoPort)) {
    autoPort += 1
  }
  return autoPort
}

function normalizePort(port?: number): number {
  if (port && Number.isInteger(port) && port > 0) {
    return port
  }
  return nextPort()
}

function normalizeHostname(hostname?: string): string {
  return hostname || '127.0.0.1'
}

function normalizePid(pid?: number): number {
  if (pid && Number.isInteger(pid) && pid > 0) {
    return pid
  }
  return 1
}

export function serve(options: BunServeOptions, kernel?: Kernel): BunServeInstance {
  const port = normalizePort(options.port)
  if (serveRegistry.has(port)) {
    throw new Error(`Port ${port} is already in use`)
  }

  const hostname = normalizeHostname(options.hostname)
  const pid = normalizePid(options.pid)

  const instance: BunServeInstance = {
    port,
    hostname,
    get url() {
      return `http://${this.hostname}:${this.port}`
    },
    pid,
    fetch: options.fetch,
    reload(next) {
      if (typeof next.fetch === 'function') {
        this.fetch = next.fetch
      }
      if (next.hostname) {
        ;(this as { hostname: string }).hostname = next.hostname
      }
    },
    stop() {
      serveRegistry.delete(port)
      kernel?.unregisterPort(port)
    },
  }

  serveRegistry.set(port, instance)
  kernel?.registerPort(pid, port)
  return instance
}

export function getServeInstance(port: number): BunServeInstance | null {
  return serveRegistry.get(port) ?? null
}

export function getServeHandler(port: number): ServeFetchHandler | null {
  return serveRegistry.get(port)?.fetch ?? null
}

export function clearServeRegistry(): void {
  serveRegistry.clear()
}
