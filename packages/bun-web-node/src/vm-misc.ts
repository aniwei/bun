import * as assertModule from 'node:assert'
import { Console } from 'node:console'
import * as osModule from 'node:os'
import * as utilModule from 'node:util'
import * as vmModule from 'node:vm'

export { assertModule, utilModule, osModule, vmModule }

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
