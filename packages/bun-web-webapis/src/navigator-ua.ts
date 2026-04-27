// navigator UA compat strategy (RFC §8.3)

export interface UACompatStrategy {
  /** UA identifier string injected as globalThis.__BUN_WEB_UA__ */
  identifier: string
  /** Headers to inject on outbound fetch requests */
  headerInjection: Record<string, string>
}

const DEFAULT_IDENTIFIER = `Bun/${typeof Bun !== 'undefined' ? Bun.version : '1.x.x'} (browser)`

const DEFAULT_STRATEGY: UACompatStrategy = {
  identifier: DEFAULT_IDENTIFIER,
  headerInjection: {
    'X-Bun-Runtime': 'browser',
  },
}

let _installed = false
let _strategy: UACompatStrategy = { ...DEFAULT_STRATEGY }

export function installUACompat(strategy?: Partial<UACompatStrategy>): void {
  _strategy = {
    identifier: strategy?.identifier ?? DEFAULT_STRATEGY.identifier,
    headerInjection: strategy?.headerInjection ?? DEFAULT_STRATEGY.headerInjection,
  }
  // Inject onto globalThis for userland detection
  ;(globalThis as Record<string, unknown>).__BUN_WEB_UA__ = _strategy.identifier
  _installed = true
}

export function getBunUAIdentifier(): string {
  return _strategy.identifier
}

export function getHeaderInjection(): Record<string, string> {
  return { ..._strategy.headerInjection }
}

export function isUACompatInstalled(): boolean {
  return _installed
}
