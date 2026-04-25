import { describe, it, expect, vi } from 'vitest'
import { HookRegistry } from '@mars/web-hooks'
import {
  PluginRegistry,
  PluginContextImpl,
  matchesLoaderPattern,
  dispatchLoader,
  PluginBudgetExceededError,
  runWithBudget,
} from '@mars/web-plugin-api'
import type { MarsWebPlugin, BunPluginDescriptor, LoaderPattern } from '@mars/web-plugin-api'

// ── matchesLoaderPattern ──────────────────────────────────────────────────────

describe('matchesLoaderPattern', () => {
  it('matches path by filter regex', () => {
    const pattern: LoaderPattern = {
      filter: /\.ts$/,
      loader: () => ({ contents: '' }),
    }
    expect(matchesLoaderPattern(pattern, { path: 'foo.ts', namespace: 'file' })).toBe(true)
    expect(matchesLoaderPattern(pattern, { path: 'foo.js', namespace: 'file' })).toBe(false)
  })

  it('matches namespace when declared', () => {
    const pattern: LoaderPattern = {
      filter: /.*/,
      namespace: 'virtual',
      loader: () => ({ contents: '' }),
    }
    expect(matchesLoaderPattern(pattern, { path: 'any', namespace: 'virtual' })).toBe(true)
    expect(matchesLoaderPattern(pattern, { path: 'any', namespace: 'file' })).toBe(false)
  })

  it('accepts any namespace when not declared', () => {
    const pattern: LoaderPattern = {
      filter: /.*/,
      loader: () => ({ contents: '' }),
    }
    expect(matchesLoaderPattern(pattern, { path: 'x', namespace: 'anything' })).toBe(true)
  })
})

// ── dispatchLoader ────────────────────────────────────────────────────────────

describe('dispatchLoader', () => {
  it('returns result from first matching pattern', async () => {
    const patterns: LoaderPattern[] = [
      { filter: /\.ts$/, loader: () => ({ contents: 'ts-content', loader: 'ts' as const }) },
      { filter: /.+/, loader: () => ({ contents: 'fallback' }) },
    ]
    const result = await dispatchLoader(patterns, { path: 'foo.ts', namespace: 'file', importer: '' })
    expect(result?.contents).toBe('ts-content')
  })

  it('falls through to next pattern when first does not match', async () => {
    const patterns: LoaderPattern[] = [
      { filter: /\.css$/, loader: () => ({ contents: 'css' }) },
      { filter: /\.ts$/, loader: () => ({ contents: 'ts' }) },
    ]
    const result = await dispatchLoader(patterns, { path: 'foo.ts', namespace: 'file', importer: '' })
    expect(result?.contents).toBe('ts')
  })

  it('returns null when no pattern matches', async () => {
    const patterns: LoaderPattern[] = [
      { filter: /\.css$/, loader: () => ({ contents: '' }) },
    ]
    const result = await dispatchLoader(patterns, { path: 'foo.ts', namespace: 'file', importer: '' })
    expect(result).toBeNull()
  })
})

// ── PluginContextImpl ─────────────────────────────────────────────────────────

describe('PluginContextImpl – registerLoader', () => {
  it('registers a hook in HookRegistry for loader:load', () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('test-plugin', registry, new AbortController().signal)

    ctx.registerLoader({ filter: /\.ts$/, loader: () => ({ contents: 'x' }) })

    const hooks = registry.getRegistered('loader:load')
    expect(hooks).toHaveLength(1)
    expect(hooks[0].name).toBe('test-plugin:loader:0')
  })

  it('hook executes loader and populates output', async () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('my-plugin', registry, new AbortController().signal)

    ctx.registerLoader({
      filter: /\.txt$/,
      loader: args => ({ contents: `loaded:${args.path}`, loader: 'text' }),
    })

    const output: { contents?: string; loader?: string } = {}
    await registry.execute('loader:load', { path: 'hello.txt', namespace: 'file' }, output)
    expect(output.contents).toBe('loaded:hello.txt')
    expect(output.loader).toBe('text')
  })

  it('hook skips non-matching paths', async () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('p', registry, new AbortController().signal)

    ctx.registerLoader({ filter: /\.css$/, loader: () => ({ contents: 'css!' }) })

    const output: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'foo.ts', namespace: 'file' }, output)
    expect(output.contents).toBeUndefined()
  })
})

describe('PluginContextImpl – disableHooks / enableHooks', () => {
  it('disableHooks prevents loader execution', async () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('p', registry, new AbortController().signal)
    ctx.registerLoader({ filter: /.+/, loader: () => ({ contents: 'hi' }) })

    ctx.disableHooks()
    const output: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'any.ts', namespace: 'file' }, output)
    expect(output.contents).toBeUndefined()
  })

  it('enableHooks restores loader execution', async () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('p', registry, new AbortController().signal)
    ctx.registerLoader({ filter: /.+/, loader: () => ({ contents: 'hi' }) })

    ctx.disableHooks()
    ctx.enableHooks()
    const output: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'any.ts', namespace: 'file' }, output)
    expect(output.contents).toBe('hi')
  })
})

describe('PluginContextImpl – rollback', () => {
  it('rollback removes all registered hooks from HookRegistry', () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('p', registry, new AbortController().signal)
    ctx.registerLoader({ filter: /\.ts$/, loader: () => ({ contents: '' }) })
    ctx.registerLoader({ filter: /\.css$/, loader: () => ({ contents: '' }) })

    expect(registry.getRegistered('loader:load')).toHaveLength(2)
    ctx.rollback()
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
  })
})

describe('PluginContextImpl – asBunBuildContext', () => {
  it('onLoad registers a loader via registerLoader', async () => {
    const registry = new HookRegistry()
    const ctx = new PluginContextImpl('bun-compat', registry, new AbortController().signal)
    const build = ctx.asBunBuildContext()

    build.onLoad({ filter: /\.yaml$/ }, async args => ({
      contents: `# loaded ${args.path}`,
      loader: 'text',
    }))

    const output: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'config.yaml', namespace: 'file' }, output)
    expect(output.contents).toBe('# loaded config.yaml')
  })
})

// ── PluginRegistry ────────────────────────────────────────────────────────────

describe('PluginRegistry – register MarsWebPlugin', () => {
  it('registers a plugin and setup is called', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    let setupCalled = false
    const plugin: MarsWebPlugin = {
      name: 'my-loader-plugin',
      setup(ctx) {
        setupCalled = true
        ctx.registerLoader({ filter: /\.md$/, loader: () => ({ contents: '# hi', loader: 'text' }) })
      },
    }

    await pluginReg.register(plugin)
    expect(setupCalled).toBe(true)
    expect(pluginReg.has('my-loader-plugin')).toBe(true)
  })

  it('duplicate registration is silently skipped', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)
    let setupCount = 0

    const plugin: MarsWebPlugin = {
      name: 'dup',
      setup() { setupCount++ },
    }

    await pluginReg.register(plugin)
    await pluginReg.register(plugin)
    expect(setupCount).toBe(1)
  })

  it('setup error rolls back hooks and does not throw', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    const plugin: MarsWebPlugin = {
      name: 'bad-plugin',
      setup(ctx) {
        ctx.registerLoader({ filter: /.+/, loader: () => ({ contents: '' }) })
        throw new Error('setup boom')
      },
    }

    await pluginReg.register(plugin)
    expect(pluginReg.has('bad-plugin')).toBe(false)
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"bad-plugin"'))
    consoleSpy.mockRestore()
  })
})

describe('PluginRegistry – registerBunPlugin', () => {
  it('Bun.plugin descriptor maps onLoad to loader:load hook', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    const descriptor: BunPluginDescriptor = {
      name: 'bun-yaml',
      setup(build) {
        build.onLoad({ filter: /\.yaml$/ }, async args => ({
          contents: `yaml:${args.path}`,
          loader: 'text',
        }))
      },
    }

    await pluginReg.registerBunPlugin(descriptor)
    expect(pluginReg.has('bun-yaml')).toBe(true)

    const output: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'data.yaml', namespace: 'file' }, output)
    expect(output.contents).toBe('yaml:data.yaml')
  })
})

describe('PluginRegistry – enable / disable / unregister', () => {
  it('disable prevents loader from firing; enable restores it', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register({
      name: 'p1',
      setup(ctx) {
        ctx.registerLoader({ filter: /.+/, loader: () => ({ contents: 'p1-content' }) })
      },
    })

    pluginReg.disable('p1')
    const out1: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'x.ts', namespace: 'file' }, out1)
    expect(out1.contents).toBeUndefined()

    pluginReg.enable('p1')
    const out2: { contents?: string } = {}
    await registry.execute('loader:load', { path: 'x.ts', namespace: 'file' }, out2)
    expect(out2.contents).toBe('p1-content')
  })

  it('unregister removes plugin and rolls back hooks', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register({
      name: 'p2',
      setup(ctx) {
        ctx.registerLoader({ filter: /.+/, loader: () => ({ contents: 'p2' }) })
      },
    })

    pluginReg.unregister('p2')
    expect(pluginReg.has('p2')).toBe(false)
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
  })

  it('list() reflects current registered plugins', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register({ name: 'a', setup() {} })
    await pluginReg.register({ name: 'b', setup() {} })
    pluginReg.unregister('a')

    const names = pluginReg.list().map(p => p.name)
    expect(names).toEqual(['b'])
  })
})

describe('PluginRegistry – dispose', () => {
  it('dispose unregisters all plugins', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register({ name: 'x', setup() {} })
    await pluginReg.register({ name: 'y', setup() {} })

    pluginReg.dispose()
    expect(pluginReg.list()).toHaveLength(0)
  })
})

// ── sandbox / runWithBudget ───────────────────────────────────────────────────

describe('runWithBudget', () => {
  it('resolves normally when fn completes within budget', async () => {
    const result = await runWithBudget('p', () => Promise.resolve(42), { timeoutMs: 500 })
    expect(result).toBe(42)
  })

  it('throws PluginBudgetExceededError when fn exceeds timeout', async () => {
    const neverResolves = new Promise<never>(() => {})
    await expect(
      runWithBudget('slow-plugin', () => neverResolves, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(PluginBudgetExceededError)
  })

  it('error message contains plugin name', async () => {
    await expect(
      runWithBudget('my-plugin', () => new Promise<never>(() => {}), { timeoutMs: 10 }),
    ).rejects.toThrow('"my-plugin"')
  })
})
