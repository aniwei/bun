import type {
  KernelProcessExecutionRequest,
  KernelProcessExecutionResult,
  KernelProcessExecutor,
  KernelPortRegistration,
} from '@mars/web-kernel'

/**
 * Virtual path at which the SW serves the process-executor worker script.
 * In browser deployments, register this path via `installWorkerScriptInterceptor`
 * from `@mars/web-sw`.
 * In Bun dev/test environments the local `.ts` source is loaded directly via
 * `import.meta.url` – no SW required.
 */
export const PROCESS_EXECUTOR_WORKER_PATH = '/__bun__/worker/bun-process.js'

/**
 * Resolved URL of the worker source file for Bun dev/test environments.
 * Evaluated once at module load time so `import.meta.url` points to this file.
 */
const DEV_WORKER_URL = new URL('./process-executor.worker.ts', import.meta.url)

type BunScriptExecutionInput = {
  source: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
}

async function executeBunScriptInWorker(
  request: KernelProcessExecutionRequest,
  input: BunScriptExecutionInput,
  workerUrl: string | URL,
): Promise<KernelProcessExecutionResult> {
  const WorkerCtor = (globalThis as { Worker?: typeof Worker }).Worker
  if (!WorkerCtor) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'bun command requires Worker runtime support\n',
    }
  }

  try {
    const worker = new WorkerCtor(workerUrl)
    return await new Promise<KernelProcessExecutionResult>((resolve, reject) => {
      worker.onmessage = event => {
        const data = event.data as
          | { type?: 'registerPort'; port?: number; registration?: KernelPortRegistration }
          | { type?: 'result'; result?: KernelProcessExecutionResult }

        if (data?.type === 'registerPort' && typeof data.port === 'number') {
          request.registerPort?.(data.port, data.registration)
          return
        }

        if (data?.type === 'result' && data.result) {
          resolve(data.result)
          worker.terminate()
        }
      }

      worker.onerror = error => {
        worker.terminate()
        reject(error)
      }

      worker.postMessage(input)
    })
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `bun worker execution failed: ${error instanceof Error ? error.message : String(error)}\n`,
    }
  }
}

/**
 * Creates a `KernelProcessExecutor` backed by `process-executor.worker.ts`.
 *
 * @param workerUrl  URL to load the worker from.
 *   - Browser + SW: pass `PROCESS_EXECUTOR_WORKER_PATH` (SW intercepts it).
 *   - Bun dev / test: omit to use `DEV_WORKER_URL` (Bun loads the TS source).
 */
export function createRuntimeProcessExecutor(options?: {
  workerUrl?: string | URL
}): KernelProcessExecutor {
  const workerUrl: string | URL = options?.workerUrl ?? DEV_WORKER_URL

  return async (request: KernelProcessExecutionRequest): Promise<KernelProcessExecutionResult> => {
    const [entry, ...rest] = request.argv

    if (!entry) {
      return { exitCode: 1, stdout: '', stderr: 'spawn argv must not be empty\n' }
    }

    if (entry === 'bun') {
      const scriptPath = rest[0] === 'run' ? rest[1] : rest[0]
      if (!scriptPath) {
        return { exitCode: 1, stdout: '', stderr: 'bun spawn requires a script path\n' }
      }

      const source = request.readMountedFile(scriptPath)
      if (typeof source !== 'string') {
        return { exitCode: 1, stdout: '', stderr: `Script not found: ${scriptPath}\n` }
      }

      return executeBunScriptInWorker(
        request,
        {
          source,
          argv: request.argv,
          cwd: request.cwd ?? '/',
          env: request.env ?? {},
          stdin: request.stdin ?? '',
        },
        workerUrl,
      )
    }

    return {
      exitCode: 127,
      stdout: '',
      stderr: `command not found: ${entry}\n`,
    }
  }
}

/**
 * Default process executor for Bun dev/test environments.
 * Uses `DEV_WORKER_URL` (relative `import.meta.url` path) so no SW is needed.
 *
 * For browser deployments wire:
 *   createRuntimeProcessExecutor({ workerUrl: PROCESS_EXECUTOR_WORKER_PATH })
 * and register the SW handler via `installWorkerScriptInterceptor` from `@mars/web-sw`.
 */
export const runtimeProcessExecutor: KernelProcessExecutor = createRuntimeProcessExecutor()
