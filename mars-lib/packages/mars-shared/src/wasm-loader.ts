export interface WasmLoader {
  readonly name: string
  readonly ready: boolean
  load(): Promise<void>
  reset(): void
}

export function createWasmLoader(
  name: string,
  init: () => unknown | Promise<unknown>,
): WasmLoader {
  let ready = false
  let loading: Promise<void> | null = null

  return {
    name,
    get ready() {
      return ready
    },
    load() {
      if (ready) return Promise.resolve()

      loading ??= Promise.resolve()
        .then(() => init())
        .then(() => {
          ready = true
        })
        .catch(error => {
          loading = null
          throw error
        })

      return loading
    },
    reset() {
      ready = false
      loading = null
    },
  }
}