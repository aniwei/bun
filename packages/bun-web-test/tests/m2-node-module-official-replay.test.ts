import { describe, expect, test } from 'vitest'
import { createRequire, isBuiltin, Module, wrap, _nodeModulePaths } from '../../../packages/bun-web-node/src/module'
import path from '../../../packages/bun-web-node/src/path'

describe('bun-web migrated official node:module replay', () => {
  test('migrated: isBuiltin semantic subset', () => {
    expect(isBuiltin('fs')).toBe(true)
    expect(isBuiltin('path')).toBe(true)
    expect(isBuiltin('events')).toBe(true)
    expect(isBuiltin('node:events')).toBe(true)
    expect(isBuiltin('node:bacon')).toBe(false)
    expect(isBuiltin('test')).toBe(true)
  })

  test('migrated: builtin resolution keeps node:-prefixed ids', () => {
    const req = createRequire('/entry.js')

    expect(req.resolve('fs')).toBe('node:fs')
    expect(req.resolve('node:fs')).toBe('node:fs')
    expect(req.resolve('events')).toBe('node:events')
    expect(req.resolve('node:events')).toBe('node:events')
  })

  test('migrated: require cache bare builtin key does not affect node: builtin key', () => {
    const req = createRequire('/entry.js')
    const real = req('fs')
    const fake = { default: 'bar' }

    expect(req.cache.fs).toBeUndefined()
    req.cache.fs = fake

    expect(req('fs')).toBe(fake)
    expect(req('node:fs')).toBe(real)
  })

  test('migrated: require cache bare events key does not affect node:events key', () => {
    const req = createRequire('/entry.js')
    const real = req('events')
    const fake = { marker: 'fake-events' }

    expect(req.cache.events).toBeUndefined()
    req.cache.events = fake

    expect(req('events')).toBe(fake)
    expect(req('node:events')).toBe(real)
  })

  test('migrated: relative specifier cache key does not bypass missing-module error', () => {
    const req = createRequire('/app/index.js')
    req.cache['./bar.cjs'] = { default: 'bar' }

    expect(() => req('./bar.cjs')).toThrow(/MODULE_NOT_FOUND|Cannot find module/)
  })

  test('migrated: createRequire handles trailing slash directory base', () => {
    const req = createRequire('/app/src/')
    req.register('/app/src/lib/math.js', { answer: 42 })

    expect(req.resolve('./lib/math.js')).toBe('/app/src/lib/math.js')
    expect(req('./lib/math.js')).toEqual({ answer: 42 })
  })

  test('migrated: createRequire accepts file URL base with trailing slash', () => {
    const req = createRequire('file:///app/src/')
    req.register('/app/src/lib/url-base.js', { ok: true })

    expect(req.resolve('./lib/url-base.js')).toBe('/app/src/lib/url-base.js')
    expect(req('./lib/url-base.js')).toEqual({ ok: true })
  })

  test('official replay: builtinModules exists and is array', () => {
    expect(Array.isArray(Module.Module.prototype.constructor.prototype)).toBe(false)
    // Direct access to the exported constant
    const builtinModules = Module.Module === Module ? createRequire('/').resolve('module') : null
    expect(builtinModules).toBeDefined()

    // Test through require for full integration
    const req = createRequire('/entry.js')
    const moduleExports = req('module') as any
    expect(Array.isArray(moduleExports.builtinModules)).toBe(true)
    expect(moduleExports.builtinModules.length).toBeGreaterThan(10)
    expect(moduleExports.builtinModules.includes('fs')).toBe(true)
    expect(moduleExports.builtinModules.includes('path')).toBe(true)
    expect(moduleExports.builtinModules.includes('events')).toBe(true)
  })

  test('official replay: Module exists and can be instantiated', () => {
    expect(Module).toBeDefined()
    expect(Module.Module === Module).toBe(true)

    const m = new Module('test-id')
    expect(m.id).toBe('test-id')
    expect(m.exports).toEqual({})
  })

  test('official replay: Module.wrap wraps code correctly', () => {
    const wrapped = wrap('exports.foo = 1; return 42')
    expect(wrapped).toContain('function')
    expect(wrapped).toContain('exports')
    expect(wrapped).toContain('require')
    expect(wrapped).toContain('module')
    expect(wrapped).toContain('__filename')
    expect(wrapped).toContain('__dirname')

    // Test that the wrapped code can be evaluated
    const mod = { exports: {} as Record<string, any> }
    // eslint-disable-next-line no-eval
    const result = eval(wrapped)(mod.exports, mod)
    expect(result).toBe(42)
    expect(mod.exports.foo).toBe(1)
  })

  test('official replay: Module.wrap with no arguments', () => {
    const defaultWrapped = wrap()
    expect(defaultWrapped).toContain('undefined')
    expect(defaultWrapped).toContain('function (exports, require, module, __filename, __dirname)')
  })

  test('official replay: _nodeModulePaths generates correct search paths', () => {
    const rootPaths = _nodeModulePaths('/')
    expect(rootPaths).toEqual(['/node_modules'])

    const deepPaths = _nodeModulePaths('/a/b/c/d')
    expect(deepPaths).toContain('/a/b/c/d/node_modules')
    expect(deepPaths).toContain('/a/b/c/node_modules')
    expect(deepPaths).toContain('/a/b/node_modules')
    expect(deepPaths).toContain('/a/node_modules')
    expect(deepPaths).toContain('/node_modules')
  })

  test('official replay: Module._extensions contains expected loaders', () => {
    const extensions = Module._extensions

    expect('.js' in extensions).toBe(true)
    expect('.json' in extensions).toBe(true)
    expect('.node' in extensions).toBe(true)
  })

  test('official replay: Module._resolveLookupPaths respects module context', () => {
    // Relative path with filename should use that directory
    const relativeResult = Module._resolveLookupPaths('./bar', { filename: '/baz/abc' })
    expect(relativeResult).toEqual(['/baz'])

    // Relative path without context should use current directory
    const relativeNoContext = Module._resolveLookupPaths('./bar', {})
    expect(relativeNoContext).toEqual(['.'])

    // Bare specifier with custom paths should return those paths
    const bareResult = Module._resolveLookupPaths('bar', { paths: ['a'] })
    expect(bareResult).toEqual(['a'])

    // Bare specifier without paths should return empty
    const bareNoPath = Module._resolveLookupPaths('foo')
    expect(bareNoPath).toEqual([])
  })
})