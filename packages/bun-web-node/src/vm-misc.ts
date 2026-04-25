import * as assertModule from 'node:assert'
import { Console } from 'node:console'
import * as osModule from 'node:os'
import * as utilModule from 'node:util'
import * as vmModule from 'node:vm'

export { assertModule, utilModule, osModule, vmModule }

// ----- error classes ----------------------------------------------------------

type CompatLevel = 'A' | 'B' | 'C' | 'D'

/** Thrown when a D-level (or browser-unsupported) API is called in a web environment. */
export class MarsWebUnsupportedError extends Error {
  readonly code: 'ERR_BUN_WEB_UNSUPPORTED' = 'ERR_BUN_WEB_UNSUPPORTED'
  readonly symbol: string
  readonly compatLevel: CompatLevel

  constructor(symbol: string, meta?: { code?: string; level?: CompatLevel }) {
    super(`${symbol} is not supported in the browser web environment`)
    this.name = 'MarsWebUnsupportedError'
    this.symbol = symbol
    this.compatLevel = meta?.level ?? 'D'
  }
}

// ----- cluster (C-level stub) ------------------------------------------------

/**
 * node:cluster shim – not available in browser context.
 * Any call throws MarsWebUnsupportedError with ERR_BUN_WEB_UNSUPPORTED.
 */
export const clusterModule = {
  get isMaster(): never {
    throw new MarsWebUnsupportedError('cluster.isMaster', { level: 'C' })
  },
  get isPrimary(): never {
    throw new MarsWebUnsupportedError('cluster.isPrimary', { level: 'C' })
  },
  get isWorker(): never {
    throw new MarsWebUnsupportedError('cluster.isWorker', { level: 'C' })
  },
  fork(): never {
    throw new MarsWebUnsupportedError('cluster.fork', { level: 'C' })
  },
  setupPrimary(): never {
    throw new MarsWebUnsupportedError('cluster.setupPrimary', { level: 'C' })
  },
  disconnect(): never {
    throw new MarsWebUnsupportedError('cluster.disconnect', { level: 'C' })
  },
} as const

export function evaluateScript(code: string, context: Record<string, unknown> = {}): unknown {
  const vmContext = vmModule.createContext({ ...context })
  return new vmModule.Script(code).runInContext(vmContext)
}

export function createConsole(stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): Console {
  if (stdout && stderr) {
    return new Console({ stdout, stderr })
  }
  return console
}

export async function createReadlineInterface(input: NodeJS.ReadableStream, output?: NodeJS.WritableStream) {
  const readline = await import('node:readline')
  return readline.createInterface({ input, output })
}

export async function tryCreateWASI(options: Record<string, unknown> = {}): Promise<unknown> {
  try {
    const wasiModule = (await import('node:wasi')) as unknown as {
      WASI: new (options?: unknown) => unknown
    }
    return new wasiModule.WASI(options)
  } catch {
    return null
  }
}

export async function v8HeapStatistics(): Promise<Record<string, unknown> | null> {
  try {
    const v8Module = (await import('node:v8')) as unknown as {
      getHeapStatistics: () => unknown
    }
    return v8Module.getHeapStatistics() as Record<string, unknown>
  } catch {
    return null
  }
}
