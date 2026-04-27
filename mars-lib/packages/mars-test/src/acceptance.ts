import type { SerializedError } from "@mars/bridge"
import type { MarsRuntime } from "@mars/client"
import type { FileTree } from "@mars/vfs"

export interface AcceptanceCase {
  name: string
  files: FileTree
  setup?(runtime: MarsRuntime): Promise<void>
  run(runtime: MarsRuntime): Promise<void>
  assert(runtime: MarsRuntime): Promise<void>
}

export interface AcceptanceRunnerOptions {
  browser: "chromium" | "firefox"
  persistence: "memory" | "opfs" | "indexeddb"
  offline: boolean
}

export interface AcceptanceResult {
  name: string
  passed: boolean
  durationMs: number
  logs: string[]
  error?: SerializedError
}

export async function runAcceptanceCase(
  runtime: MarsRuntime,
  acceptanceCase: AcceptanceCase,
): Promise<AcceptanceResult> {
  const startedAt = performance.now()
  const logs: string[] = []

  try {
    await runtime.restore(acceptanceCase.files)
    await acceptanceCase.setup?.(runtime)
    await acceptanceCase.run(runtime)
    await acceptanceCase.assert(runtime)

    return {
      name: acceptanceCase.name,
      passed: true,
      durationMs: performance.now() - startedAt,
      logs,
    }
  } catch (error) {
    return {
      name: acceptanceCase.name,
      passed: false,
      durationMs: performance.now() - startedAt,
      logs,
      error: error instanceof Error
        ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
        : { name: "Error", message: String(error) },
    }
  }
}