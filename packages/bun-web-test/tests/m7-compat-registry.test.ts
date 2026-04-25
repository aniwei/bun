import { describe, it, expect, beforeEach } from 'vitest'
import {
  CompatRegistry,
  MarsWebUnsupportedError,
  isCompatLevel,
  isDegradation,
  compareByLevel,
  COMPAT_LEVELS,
  scanDtsContent,
} from '@mars/web-compat-registry'
import type { CompatEntry, CompatLevel } from '@mars/web-compat-registry'

// ── levels ────────────────────────────────────────────────────────────────────

describe('isCompatLevel', () => {
  it('returns true for valid levels', () => {
    for (const level of ['A', 'B', 'C', 'D']) {
      expect(isCompatLevel(level)).toBe(true)
    }
  })

  it('returns false for invalid values', () => {
    expect(isCompatLevel('E')).toBe(false)
    expect(isCompatLevel(1)).toBe(false)
    expect(isCompatLevel(null)).toBe(false)
  })
})

describe('isDegradation', () => {
  it('A → D is a degradation', () => { expect(isDegradation('A', 'D')).toBe(true) })
  it('B → C is a degradation', () => { expect(isDegradation('B', 'C')).toBe(true) })
  it('C → D is a degradation', () => { expect(isDegradation('C', 'D')).toBe(true) })
  it('A → A is not', () => { expect(isDegradation('A', 'A')).toBe(false) })
  it('D → A is not (improvement)', () => { expect(isDegradation('D', 'A')).toBe(false) })
  it('B → B is not', () => { expect(isDegradation('B', 'B')).toBe(false) })
})

describe('compareByLevel', () => {
  it('A < B < C < D', () => {
    const levels: CompatLevel[] = ['D', 'B', 'A', 'C']
    expect(levels.sort(compareByLevel)).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('COMPAT_LEVELS', () => {
  it('contains all four levels', () => {
    expect(COMPAT_LEVELS).toContain('A')
    expect(COMPAT_LEVELS).toContain('D')
    expect(COMPAT_LEVELS).toHaveLength(4)
  })
})

// ── CompatRegistry ────────────────────────────────────────────────────────────

describe('CompatRegistry – register / get / list', () => {
  let reg: CompatRegistry

  beforeEach(() => {
    // 每个测试使用独立实例（不污染全局单例）
    CompatRegistry.__resetInstance()
    reg = new CompatRegistry()
  })

  it('register and get', () => {
    reg.register({ symbol: 'Bun.serve', level: 'A' })
    expect(reg.get('Bun.serve')).toMatchObject({ symbol: 'Bun.serve', level: 'A' })
  })

  it('registerAll registers multiple entries', () => {
    reg.registerAll([
      { symbol: 'Bun.serve', level: 'A' },
      { symbol: 'node:fs.readFile', level: 'B' },
    ])
    expect(reg.get('Bun.serve')).toBeDefined()
    expect(reg.get('node:fs.readFile')).toBeDefined()
  })

  it('list() returns all entries sorted by symbol', () => {
    reg.registerAll([
      { symbol: 'z-sym', level: 'C' },
      { symbol: 'a-sym', level: 'A' },
    ])
    const names = reg.list().map(e => e.symbol)
    expect(names).toEqual(['a-sym', 'z-sym'])
  })

  it('list(level) filters by level', () => {
    reg.registerAll([
      { symbol: 'Bun.serve', level: 'A' },
      { symbol: 'Bun.file', level: 'B' },
      { symbol: 'Bun.dlopen', level: 'D' },
    ])
    const aLevel = reg.list('A').map(e => e.symbol)
    expect(aLevel).toEqual(['Bun.serve'])
  })

  it('register overwrites existing entry', () => {
    reg.register({ symbol: 'Bun.serve', level: 'A' })
    reg.register({ symbol: 'Bun.serve', level: 'C', notes: 'degraded' })
    expect(reg.get('Bun.serve')?.level).toBe('C')
  })
})

// ── validate ──────────────────────────────────────────────────────────────────

describe('CompatRegistry – validate', () => {
  let reg: CompatRegistry

  beforeEach(() => {
    CompatRegistry.__resetInstance()
    reg = new CompatRegistry()
  })

  it('ok=true when all known symbols are registered', () => {
    reg.register({ symbol: 'Bun.serve', level: 'A' })
    reg.setKnownSymbols(['Bun.serve'])
    const result = reg.validate()
    expect(result.ok).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it('ok=false when known symbols are missing', () => {
    reg.setKnownSymbols(['Bun.serve', 'Bun.file'])
    const result = reg.validate()
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('Bun.serve')
    expect(result.missing).toContain('Bun.file')
  })

  it('detects degraded entries against snapshot', () => {
    reg.register({ symbol: 'Bun.serve', level: 'C' })
    const snapshot = new Map<string, CompatLevel>([['Bun.serve', 'A']])
    const result = reg.validate(snapshot)
    expect(result.degraded).toHaveLength(1)
    expect(result.degraded[0]).toMatchObject({ symbol: 'Bun.serve', from: 'A', to: 'C' })
  })

  it('no degradation when level improves', () => {
    reg.register({ symbol: 'Bun.serve', level: 'A' })
    const snapshot = new Map<string, CompatLevel>([['Bun.serve', 'C']])
    const result = reg.validate(snapshot)
    expect(result.degraded).toHaveLength(0)
  })

  it('missing is sorted alphabetically', () => {
    reg.setKnownSymbols(['z-sym', 'a-sym', 'm-sym'])
    const result = reg.validate()
    expect(result.missing).toEqual(['a-sym', 'm-sym', 'z-sym'])
  })
})

// ── assertSupported ───────────────────────────────────────────────────────────

describe('CompatRegistry – assertSupported', () => {
  let reg: CompatRegistry

  beforeEach(() => {
    CompatRegistry.__resetInstance()
    reg = new CompatRegistry()
  })

  it('does not throw for level A/B/C symbols', () => {
    reg.register({ symbol: 'Bun.serve', level: 'A' })
    reg.register({ symbol: 'Bun.file', level: 'B' })
    reg.register({ symbol: 'Bun.glob', level: 'C' })
    expect(() => reg.assertSupported('Bun.serve')).not.toThrow()
    expect(() => reg.assertSupported('Bun.file')).not.toThrow()
    expect(() => reg.assertSupported('Bun.glob')).not.toThrow()
  })

  it('throws MarsWebUnsupportedError for level D', () => {
    reg.register({ symbol: 'process.dlopen', level: 'D' })
    expect(() => reg.assertSupported('process.dlopen')).toThrow(MarsWebUnsupportedError)
  })

  it('throws for unregistered symbol', () => {
    expect(() => reg.assertSupported('Bun.unknown')).toThrow(MarsWebUnsupportedError)
  })

  it('error has correct properties', () => {
    reg.register({ symbol: 'Bun.dlopen', level: 'D', notes: 'native only' })
    try {
      reg.assertSupported('Bun.dlopen')
      expect.fail('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MarsWebUnsupportedError)
      const e = err as MarsWebUnsupportedError
      expect(e.code).toBe('ERR_BUN_WEB_UNSUPPORTED')
      expect(e.symbol).toBe('Bun.dlopen')
      expect(e.compatLevel).toBe('D')
      expect(e.message).toContain('Bun.dlopen')
    }
  })
})

// ── CompatRegistry singleton ──────────────────────────────────────────────────

describe('CompatRegistry.instance', () => {
  beforeEach(() => CompatRegistry.__resetInstance())

  it('returns the same instance on repeated calls', () => {
    const a = CompatRegistry.instance
    const b = CompatRegistry.instance
    expect(a).toBe(b)
  })

  it('__resetInstance creates a fresh instance', () => {
    const a = CompatRegistry.instance
    CompatRegistry.__resetInstance()
    const b = CompatRegistry.instance
    expect(a).not.toBe(b)
  })
})

// ── MarsWebUnsupportedError ───────────────────────────────────────────────────

describe('MarsWebUnsupportedError', () => {
  it('has correct code and symbol', () => {
    const err = new MarsWebUnsupportedError('Bun.native')
    expect(err.code).toBe('ERR_BUN_WEB_UNSUPPORTED')
    expect(err.symbol).toBe('Bun.native')
    expect(err.compatLevel).toBe('D')
    expect(err.name).toBe('MarsWebUnsupportedError')
  })

  it('message includes symbol name', () => {
    const err = new MarsWebUnsupportedError('Bun.native')
    expect(err.message).toContain('Bun.native')
  })

  it('appends notes when provided', () => {
    const err = new MarsWebUnsupportedError('Bun.x', { notes: 'needs NAPI' })
    expect(err.message).toContain('needs NAPI')
  })
})

// ── scanDtsContent ────────────────────────────────────────────────────────────

describe('scanDtsContent', () => {
  it('extracts top-level export declarations', () => {
    const content = `
      export declare function serve(opts: unknown): unknown;
      export declare const version: string;
      export declare class Server {}
    `
    const symbols = scanDtsContent(content, 'test.d.ts')
    expect(symbols).toContain('serve')
    expect(symbols).toContain('version')
    expect(symbols).toContain('Server')
  })

  it('extracts Bun namespace members', () => {
    const content = `
      declare namespace Bun {
        export function serve(opts: unknown): unknown;
        export const version: string;
      }
    `
    const symbols = scanDtsContent(content, 'bun.d.ts')
    expect(symbols).toContain('Bun.serve')
    expect(symbols).toContain('Bun.version')
  })

  it('extracts node: module members', () => {
    const content = `
      declare module 'node:fs' {
        export function readFile(path: string): Promise<Buffer>;
        export function writeFile(path: string, data: string): Promise<void>;
      }
    `
    const symbols = scanDtsContent(content, 'node.d.ts')
    expect(symbols).toContain('node:fs.readFile')
    expect(symbols).toContain('node:fs.writeFile')
  })

  it('deduplicates symbols', () => {
    const content = `
      export declare function foo(): void;
      export declare function foo(): void;
    `
    const symbols = scanDtsContent(content, 'dup.d.ts')
    expect(symbols.filter(s => s === 'foo')).toHaveLength(1)
  })
})
