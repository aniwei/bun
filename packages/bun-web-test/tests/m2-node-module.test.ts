import { describe, expect, test } from 'vitest'
import {
  builtinModulesList,
  createRequire,
  createRequireWithVfs,
  isBuiltin,
  register,
} from '../../../packages/bun-web-node/src/module'
import { VFS } from '../../../packages/bun-web-vfs/src/overlay-fs'

describe('bun-web M2 node module bridge smoke', () => {
  test('isBuiltin handles node and bare specifiers', () => {
    expect(isBuiltin('node:fs')).toBe(true)
    expect(isBuiltin('path')).toBe(true)
    expect(isBuiltin('not-a-core-module')).toBe(false)
  })

  test('register + createRequire loads custom modules', () => {
    register('virtual:sum', {
      sum: (a: number, b: number) => a + b,
    })

    const requireFn = createRequire('/app/index.ts')
    const mod = requireFn('virtual:sum') as { sum: (a: number, b: number) => number }

    expect(mod.sum(2, 3)).toBe(5)
    expect(requireFn.resolve('virtual:sum')).toBe('virtual:sum')
  })

  test('createRequire resolves builtin modules', () => {
    const requireFn = createRequire('/app/index.ts')

    const pathMod = requireFn('node:path') as { basename: (value: string) => string }
    expect(pathMod.basename('/a/b/c.txt')).toBe('c.txt')

    const query = requireFn('querystring') as { stringify: (input: Record<string, string>) => string }
    expect(query.stringify({ x: '1' })).toBe('x=1')

    expect(requireFn.resolve('fs')).toBe('node:fs')
    expect(requireFn.cache['node:path']).toBeDefined()
  })

  test('createRequire resolves relative and absolute registered modules', () => {
    register('/app/lib/math.ts', {
      mul: (a: number, b: number) => a * b,
    })

    const requireFn = createRequire('/app/main.ts')
    const rel = requireFn('./lib/math.ts') as { mul: (a: number, b: number) => number }
    const abs = requireFn('/app/lib/math.ts') as { mul: (a: number, b: number) => number }

    expect(rel.mul(3, 4)).toBe(12)
    expect(abs.mul(2, 5)).toBe(10)
    expect(requireFn.resolve('./lib/math.ts')).toBe('/app/lib/math.ts')
  })

  test('registered module has priority over builtin for same specifier', () => {
    register('path', {
      marker: 'custom-path',
    })

    const requireFn = createRequire('/app/index.ts')
    const loaded = requireFn('path') as { marker: string }
    expect(loaded.marker).toBe('custom-path')

    const builtin = requireFn('node:path') as { basename: (input: string) => string }
    expect(builtin.basename('/a/b.txt')).toBe('b.txt')
  })

  test('require.cache returns stable reference for registered modules', () => {
    register('/cache/value.ts', {
      count: 1,
    })

    const requireFn = createRequire('/cache/index.ts')
    const first = requireFn('./value.ts') as { count: number }
    const second = requireFn('./value.ts') as { count: number }

    expect(first).toBe(second)
    expect(requireFn.cache['/cache/value.ts']).toBe(first)
  })

  test('builtin require shares cache key between bare and node prefix', () => {
    const requireFn = createRequire('/app/index.ts')
    const bare = requireFn('fs') as { existsSync: (v: string) => boolean }
    const prefixed = requireFn('node:fs') as { existsSync: (v: string) => boolean }

    expect(bare).toBe(prefixed)
    expect(requireFn.cache['node:fs']).toBe(bare)
  })

  test('register hot-replaces cached module value', () => {
    const requireFn = createRequire('/app/index.ts')

    requireFn.register('virtual:hot', { version: 1 })
    const first = requireFn('virtual:hot') as { version: number }

    requireFn.register('virtual:hot', { version: 2 })
    const second = requireFn('virtual:hot') as { version: number }

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(first).not.toBe(second)
  })

  test('createRequire throws MODULE_NOT_FOUND for unknown module', () => {
    const requireFn = createRequire('/app/index.ts')

    let code = ''
    try {
      requireFn('virtual:missing')
    } catch (err) {
      const error = err as Error & { code?: string }
      code = error.code ?? ''
    }

    expect(code).toBe('MODULE_NOT_FOUND')
  })

  test('node:buffer is a builtin and can be required', () => {
    expect(isBuiltin('buffer')).toBe(true)
    expect(isBuiltin('node:buffer')).toBe(true)

    const requireFn = createRequire('/app/index.ts')
    const bufMod = requireFn('buffer') as { Buffer: typeof Buffer }
    expect(typeof bufMod.Buffer).toBe('function')
    expect(bufMod.Buffer.from('hello').toString('utf8')).toBe('hello')
  })

  test('builtinModulesList is an array of bare module names', () => {
    expect(Array.isArray(builtinModulesList)).toBe(true)
    expect(builtinModulesList).toContain('fs')
    expect(builtinModulesList).toContain('path')
    expect(builtinModulesList).toContain('buffer')
    expect(builtinModulesList).toContain('url')
    // Should not contain node: prefix entries
    for (const name of builtinModulesList) {
      expect(name.startsWith('node:')).toBe(false)
    }
  })

  test('node:url requires fileURLToPath and pathToFileURL', () => {
    const requireFn = createRequire('/app/index.ts')
    const urlMod = requireFn('node:url') as {
      fileURLToPath: (u: string | URL) => string
      pathToFileURL: (p: string) => URL
    }
    expect(typeof urlMod.fileURLToPath).toBe('function')
    expect(urlMod.fileURLToPath('file:///a/b.ts')).toBe('/a/b.ts')
    expect(urlMod.pathToFileURL('/a/b.ts').href).toBe('file:///a/b.ts')
  })

  test('official replay: createRequireWithVfs resolves node_modules package', () => {
    const vfs = new VFS()
    vfs.mkdirSync('/app/node_modules/left-pad', { recursive: true })
    vfs.writeFileSync(
      '/app/node_modules/left-pad/package.json',
      JSON.stringify({ name: 'left-pad', main: './index.js' }),
    )
    vfs.writeFileSync(
      '/app/node_modules/left-pad/index.js',
      [
        "module.exports = function leftPad(input, len, fill) {",
        "  const s = String(input)",
        "  const f = fill == null ? ' ' : String(fill)",
        '  if (s.length >= len) return s',
        '  return f.repeat(len - s.length) + s',
        '}',
      ].join('\n'),
    )

    const requireFn = createRequireWithVfs('/app/src/main.js', vfs)
    const leftPad = requireFn('left-pad') as (input: string, len: number, fill?: string) => string

    expect(leftPad('7', 3, '0')).toBe('007')
    expect(requireFn.resolve('left-pad')).toBe('/app/node_modules/left-pad/index.js')
  })

  test('official replay: createRequireWithVfs supports package local requires and cache', () => {
    const vfs = new VFS()
    vfs.mkdirSync('/workspace/node_modules/pkga/lib', { recursive: true })
    vfs.writeFileSync(
      '/workspace/node_modules/pkga/package.json',
      JSON.stringify({ name: 'pkga', main: './index.js' }),
    )
    vfs.writeFileSync(
      '/workspace/node_modules/pkga/index.js',
      "const inner = require('./lib/inner.js'); module.exports = { value: inner.value, hit: Math.random() > -1 }",
    )
    vfs.writeFileSync('/workspace/node_modules/pkga/lib/inner.js', 'module.exports = { value: 42 }')

    const requireFn = createRequireWithVfs('/workspace/src/entry.js', vfs)
    const first = requireFn('pkga') as { value: number; hit: boolean }
    const second = requireFn('pkga') as { value: number; hit: boolean }

    expect(first.value).toBe(42)
    expect(first.hit).toBe(true)
    expect(second).toBe(first)
  })
})
