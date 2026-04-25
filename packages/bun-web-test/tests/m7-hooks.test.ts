import { describe, it, expect, vi } from 'vitest'
import {
  HookRegistry,
  defineHook,
  getPresetHooks,
  INTERCEPTOR_TIMINGS,
  OBSERVER_TIMINGS,
  createHookBuckets,
} from '@mars/web-hooks'

// ── defineHook ────────────────────────────────────────────────────────────────

describe('defineHook', () => {
  it('creates an interceptor spec for InterceptorTiming', () => {
    const spec = defineHook({
      name: 'my-loader',
      timing: 'loader:load',
      handle: (_input, _output) => {},
    })
    expect(spec.kind).toBe('interceptor')
    expect(spec.name).toBe('my-loader')
    expect(spec.timing).toBe('loader:load')
    expect(spec.priority).toBe(50)
    expect(spec.enabled).toBe(true)
  })

  it('creates an observer spec for ObserverTiming', () => {
    const spec = defineHook({
      name: 'boot-observer',
      timing: 'kernel:boot',
      handle: () => {},
    })
    expect(spec.kind).toBe('observer')
    expect(spec.timing).toBe('kernel:boot')
  })

  it('respects custom priority and enabled=false', () => {
    const spec = defineHook({
      name: 'low-prio',
      timing: 'net:fetch',
      handle: () => {},
      priority: 10,
      enabled: false,
    })
    expect(spec.priority).toBe(10)
    expect(spec.enabled).toBe(false)
  })
})

// ── register / on / registerAll ───────────────────────────────────────────────

describe('HookRegistry – register', () => {
  it('registers a hook and has() returns true', () => {
    const reg = new HookRegistry()
    reg.register(defineHook({ name: 'h1', timing: 'loader:load', handle: () => {} }))
    expect(reg.has('h1')).toBe(true)
  })

  it('on() chains and registers an observer', () => {
    const reg = new HookRegistry()
    reg.on('kernel:boot', 'boot-log', () => {})
    expect(reg.has('boot-log')).toBe(true)
    expect(reg.getRegistered('kernel:boot')[0].name).toBe('boot-log')
  })

  it('registerAll() registers multiple hooks', () => {
    const reg = new HookRegistry()
    reg.registerAll([
      defineHook({ name: 'a', timing: 'loader:load', handle: () => {} }),
      defineHook({ name: 'b', timing: 'vfs:read', handle: () => {} }),
    ])
    expect(reg.has('a')).toBe(true)
    expect(reg.has('b')).toBe(true)
  })
})

// ── enable / disable ─────────────────────────────────────────────────────────

describe('HookRegistry – enable/disable', () => {
  it('disabled hook is not called during execute()', async () => {
    const called: string[] = []
    const reg = new HookRegistry()
    reg.register(
      defineHook({ name: 'h-alpha', timing: 'loader:load', handle: (_i, _o) => { called.push('alpha') } }),
    )
    reg.disable('h-alpha')
    await reg.execute('loader:load', { path: 'foo', namespace: 'file' }, {})
    expect(called).toHaveLength(0)
  })

  it('re-enabled hook is called again', async () => {
    const called: string[] = []
    const reg = new HookRegistry()
    reg.register(
      defineHook({ name: 'h-beta', timing: 'loader:load', handle: (_i, _o) => { called.push('beta') } }),
    )
    reg.disable('h-beta')
    await reg.execute('loader:load', { path: 'foo', namespace: 'file' }, {})
    expect(called).toHaveLength(0)

    reg.enable('h-beta')
    await reg.execute('loader:load', { path: 'foo', namespace: 'file' }, {})
    expect(called).toHaveLength(1)
  })
})

// ── unregister / clear ────────────────────────────────────────────────────────

describe('HookRegistry – unregister / clear', () => {
  it('unregister removes hook', () => {
    const reg = new HookRegistry()
    reg.register(defineHook({ name: 'rm-me', timing: 'loader:load', handle: () => {} }))
    expect(reg.unregister('rm-me')).toBe(true)
    expect(reg.has('rm-me')).toBe(false)
  })

  it('unregister returns false if hook not found', () => {
    const reg = new HookRegistry()
    expect(reg.unregister('nonexistent')).toBe(false)
  })

  it('clear() removes all hooks and re-enables disabled ones', async () => {
    const called: string[] = []
    const reg = new HookRegistry()
    reg.on('kernel:boot', 'obs1', () => { called.push('obs1') })
    reg.disable('obs1')
    reg.clear()
    expect(reg.getRegistered()).toHaveLength(0)

    // 重新注册后不应受之前 disable 影响
    reg.on('kernel:boot', 'obs2', () => { called.push('obs2') })
    await reg.emit('kernel:boot', {})
    expect(called).toEqual(['obs2'])
  })
})

// ── execute (interceptor) ─────────────────────────────────────────────────────

describe('HookRegistry – execute()', () => {
  it('calls interceptors in priority order and allows output mutation', async () => {
    const order: number[] = []
    const reg = new HookRegistry()
    reg.register(
      defineHook({
        name: 'h-30',
        timing: 'loader:transform',
        priority: 30,
        handle: (_i, o) => { order.push(30); (o as { contents?: string }).contents = 'by-30' },
      }),
    )
    reg.register(
      defineHook({
        name: 'h-10',
        timing: 'loader:transform',
        priority: 10,
        handle: (_i, o) => { order.push(10); (o as { contents?: string }).contents = 'by-10' },
      }),
    )

    const output: { contents?: string } = {}
    await reg.execute('loader:transform', { path: 'f', contents: 'x', loader: 'ts' }, output)
    expect(order).toEqual([10, 30])
    expect(output.contents).toBe('by-30')
  })

  it('hook error is logged but does not abort execution', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const called: string[] = []
    const reg = new HookRegistry()
    reg.register(
      defineHook({
        name: 'boom',
        timing: 'loader:load',
        priority: 10,
        handle: () => { throw new Error('oops') },
      }),
    )
    reg.register(
      defineHook({
        name: 'safe',
        timing: 'loader:load',
        priority: 20,
        handle: () => { called.push('safe') },
      }),
    )

    await reg.execute('loader:load', { path: 'x', namespace: 'file' }, {})
    expect(called).toEqual(['safe'])
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"boom"'))
    consoleSpy.mockRestore()
  })
})

// ── emit (observer) ──────────────────────────────────────────────────────────

describe('HookRegistry – emit()', () => {
  it('calls observers in priority order', async () => {
    const order: number[] = []
    const reg = new HookRegistry()
    reg.on('kernel:boot', 'obs-40', () => { order.push(40) }, 40)
    reg.on('kernel:boot', 'obs-5', () => { order.push(5) }, 5)

    await reg.emit('kernel:boot', {})
    expect(order).toEqual([5, 40])
  })

  it('observer error is logged but does not abort subsequent observers', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const called: string[] = []
    const reg = new HookRegistry()
    reg.on('kernel:boot', 'obs-err', () => { throw new Error('fail') }, 1)
    reg.on('kernel:boot', 'obs-ok', () => { called.push('ok') }, 2)

    await reg.emit('kernel:boot', {})
    expect(called).toEqual(['ok'])
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"obs-err"'))
    consoleSpy.mockRestore()
  })
})

// ── getRegistered ─────────────────────────────────────────────────────────────

describe('HookRegistry – getRegistered()', () => {
  it('returns all hooks across timings when no filter', () => {
    const reg = new HookRegistry()
    reg.on('loader:load', 'a', () => {})
    reg.on('kernel:boot', 'b', () => {})
    const all = reg.getRegistered()
    expect(all.map(h => h.name)).toContain('a')
    expect(all.map(h => h.name)).toContain('b')
  })

  it('returns only hooks for specific timing', () => {
    const reg = new HookRegistry()
    reg.on('loader:load', 'only-load', () => {})
    reg.on('kernel:boot', 'boot', () => {})
    const result = reg.getRegistered('loader:load')
    expect(result.map(h => h.name)).toEqual(['only-load'])
  })
})

// ── timings 常量 & createHookBuckets ─────────────────────────────────────────

describe('HOOK_TIMINGS & createHookBuckets', () => {
  it('INTERCEPTOR_TIMINGS includes expected entries', () => {
    expect(INTERCEPTOR_TIMINGS).toContain('loader:load')
    expect(INTERCEPTOR_TIMINGS).toContain('net:fetch')
  })

  it('OBSERVER_TIMINGS includes expected entries', () => {
    expect(OBSERVER_TIMINGS).toContain('kernel:boot')
    expect(OBSERVER_TIMINGS).toContain('process:onExit')
  })

  it('createHookBuckets returns empty arrays for all timings', () => {
    const buckets = createHookBuckets()
    expect(Array.isArray(buckets['loader:load'])).toBe(true)
    expect(buckets['loader:load']).toHaveLength(0)
    expect(Array.isArray(buckets['kernel:boot'])).toBe(true)
  })
})

// ── preset ────────────────────────────────────────────────────────────────────

describe('getPresetHooks', () => {
  it('none returns empty array', () => {
    expect(getPresetHooks('none')).toEqual([])
  })

  it('minimal returns empty array', () => {
    expect(getPresetHooks('minimal')).toEqual([])
  })

  it('default returns empty array (placeholder, not yet populated)', () => {
    expect(getPresetHooks('default')).toEqual([])
  })
})

// ── preset in HookRegistry constructor ───────────────────────────────────────

describe('HookRegistry preset option', () => {
  it('no preset → empty registry', () => {
    const reg = new HookRegistry()
    expect(reg.getRegistered()).toHaveLength(0)
  })

  it('preset:none → empty registry', () => {
    const reg = new HookRegistry({ preset: 'none' })
    expect(reg.getRegistered()).toHaveLength(0)
  })

  it('preset:minimal → empty registry (no system hooks defined yet)', () => {
    const reg = new HookRegistry({ preset: 'minimal' })
    expect(reg.getRegistered()).toHaveLength(0)
  })
})
