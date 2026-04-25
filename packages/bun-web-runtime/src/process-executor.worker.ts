/**
 * Standalone Worker script for Bun-in-browser process execution.
 *
 * This file is loaded by the Service Worker at:
 *   /__bun__/worker/bun-process.js
 *
 * In development / test environments (Bun), the file is loaded directly via
 *   new Worker(new URL('./process-executor.worker.ts', import.meta.url))
 *
 * No imports from other @mars packages – this script must be fully
 * self-contained so it can be served as a standalone JS resource.
 */

// ---------------------------------------------------------------------------
// Message protocol (runtime shapes, erased types only)
// ---------------------------------------------------------------------------

type WorkerInput = {
  source: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
}

type PortRegistration = {
  host: string
  protocol: 'http' | 'https'
}

type ExitSignal = { __bunWebProcessExit: true; code: number }

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeServePort(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input > 0 ? input : 3000
  }
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 3000
}

function normalizeExitCode(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.trunc(input)
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function normalizeServeRegistration(options: unknown): PortRegistration {
  const opts = options as Record<string, unknown> | null | undefined
  const rawHost = opts ? (opts.hostname ?? opts.host) : undefined
  const host = (rawHost ? String(rawHost) : 'localhost').trim() || 'localhost'
  const protocol: 'http' | 'https' = opts?.tls ? 'https' : 'http'
  return { host, protocol }
}

function createConsoleCapture(output: string[], errors: string[]) {
  const capture = (target: string[]) =>
    (...args: unknown[]) => {
      target.push(args.map(stringifyArg).join(' '))
    }
  return {
    log: capture(output),
    info: capture(output),
    warn: capture(errors),
    error: capture(errors),
  }
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
  const payload: WorkerInput = event.data ?? {}
  const output: string[] = []
  const errors: string[] = []
  const consoleLike = createConsoleCapture(output, errors)

  const makeExitSignal = (code: number): ExitSignal => ({
    __bunWebProcessExit: true,
    code: normalizeExitCode(code),
  })

  const processLike = {
    argv: payload.argv ?? [],
    env: payload.env ?? {},
    cwd: () => payload.cwd ?? '/',
    exit: (code = 0) => {
      throw makeExitSignal(code)
    },
  }

  const bunLike = {
    version: '0.0.0-web',
    env: payload.env ?? {},
    argv: payload.argv ?? [],
    cwd: () => payload.cwd ?? '/',
    file: () => undefined,
    exit: (code = 0) => {
      throw makeExitSignal(code)
    },
    serve: (options: unknown) => {
      const port = normalizeServePort((options as Record<string, unknown>)?.port)
      self.postMessage({ type: 'registerPort', port, registration: normalizeServeRegistration(options) })
      return { port, stop() {}, reload() {} }
    },
  }

  let exitCode = 0

  try {
    // AsyncFunction eval is intentional here: the worker executes arbitrary
    // user-provided Bun scripts in an isolated Worker scope.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as (
      ...args: string[]
    ) => (...params: unknown[]) => Promise<unknown>
    const fn = AsyncFunction('console', 'Bun', 'process', String(payload.source ?? ''))
    await fn(consoleLike, bunLike, processLike)
  } catch (error) {
    const err = error as Record<string, unknown>
    if (err?.__bunWebProcessExit === true) {
      exitCode = normalizeExitCode(err.code)
    } else {
      exitCode = 1
      errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }
  }

  if (payload.stdin) {
    errors.push(`stdin:${String(payload.stdin)}`)
  }

  self.postMessage({
    type: 'result',
    result: {
      exitCode,
      stdout: output.length > 0 ? `${output.join('\n')}\n` : '',
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    },
  })
}
