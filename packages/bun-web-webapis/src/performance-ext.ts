// performance Bun extension attributes (RFC §8.3)
// Bun exposes `performance.nodeTiming`, `performance.timeOrigin` etc.
// that are not present on the browser performance object.
// We patch these onto globalThis.performance if they are missing.

export interface BunNodeTiming {
  readonly bootstrapComplete: number
  readonly loopStart: number
  readonly loopExit: number
  readonly nodeStart: number
  readonly v8Start: number
  readonly environment: number
  readonly initializeMainModule: number
  readonly thirdPartyMainStart: number
  readonly thirdPartyMainEnd: number
  readonly clusterSetupStart: number
  readonly clusterSetupEnd: number
  readonly preLoadModulesStart: number
  readonly preLoadModulesEnd: number
  readonly loopStartDelay: number
}

const ZERO_NODE_TIMING: BunNodeTiming = {
  bootstrapComplete: 0,
  loopStart: 0,
  loopExit: 0,
  nodeStart: 0,
  v8Start: 0,
  environment: 0,
  initializeMainModule: 0,
  thirdPartyMainStart: 0,
  thirdPartyMainEnd: 0,
  clusterSetupStart: 0,
  clusterSetupEnd: 0,
  preLoadModulesStart: 0,
  preLoadModulesEnd: 0,
  loopStartDelay: 0,
}

export function installPerformanceExt(): void {
  const perf = globalThis.performance
  if (!perf) return

  if (!('nodeTiming' in perf)) {
    Object.defineProperty(perf, 'nodeTiming', {
      get: () => ZERO_NODE_TIMING,
      configurable: true,
    })
  }

  // Bun.nanoseconds() → we don't have it in browser, but expose a stub
  if (typeof globalThis.Bun !== 'undefined' && !('nanoseconds' in (globalThis.Bun as object))) {
    ;(globalThis.Bun as Record<string, unknown>)['nanoseconds'] = () =>
      BigInt(Math.round(performance.now() * 1_000_000))
  }
}
