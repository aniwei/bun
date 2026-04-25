/**
 * M7-6 — 插件生命周期验收用例
 *
 * 验收标准：注册/卸载副作用可回滚（对齐实施计划 M7-6）
 *
 * 覆盖场景：
 * - 注册 → 生效 → 停用 → 恢复 → 卸载 → 回滚
 * - 多插件协同（loader 叠加）
 * - dispose() 批量清理
 * - Bun.plugin 兼容完整生命周期
 * - list() 状态一致性
 */

import { describe, it, expect } from 'vitest'
import { HookRegistry } from '@mars/web-hooks'
import { PluginRegistry } from '@mars/web-plugin-api'
import type { MarsWebPlugin } from '@mars/web-plugin-api'

// ── 辅助工厂 ─────────────────────────────────────────────────────────────────

function makeLoaderPlugin(name: string, ext: string, output: string): MarsWebPlugin {
  return {
    name,
    setup(ctx) {
      ctx.registerLoader({
        filter: new RegExp(`\\.${ext}$`),
        loader: args => ({ contents: `${output}:${args.path}`, loader: 'text' as const }),
      })
    },
  }
}

async function execLoad(
  registry: HookRegistry,
  path: string,
): Promise<{ contents?: string }> {
  const output: { contents?: string } = {}
  await registry.execute('loader:load', { path, namespace: 'file' }, output)
  return output
}

// ── 注册 → 生效 ───────────────────────────────────────────────────────────────

describe('plugin lifecycle – register → active', () => {
  it('registered plugin loader fires on matching path', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('yaml-plugin', 'yaml', 'yaml-content'))

    const out = await execLoad(registry, 'config.yaml')
    expect(out.contents).toBe('yaml-content:config.yaml')
  })

  it('non-matching extension is not handled', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('yaml-plugin', 'yaml', 'yaml-content'))

    const out = await execLoad(registry, 'index.ts')
    expect(out.contents).toBeUndefined()
  })
})

// ── 停用 → 恢复 ───────────────────────────────────────────────────────────────

describe('plugin lifecycle – disable → enable', () => {
  it('disabled plugin does not fire', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('p', 'md', 'md-content'))
    pluginReg.disable('p')

    const out = await execLoad(registry, 'readme.md')
    expect(out.contents).toBeUndefined()
    expect(pluginReg.get('p')?.enabled).toBe(false)
  })

  it('re-enabled plugin fires again', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('p', 'md', 'md-content'))
    pluginReg.disable('p')
    pluginReg.enable('p')

    const out = await execLoad(registry, 'readme.md')
    expect(out.contents).toBe('md-content:readme.md')
    expect(pluginReg.get('p')?.enabled).toBe(true)
  })
})

// ── 卸载 → 副作用回滚 ─────────────────────────────────────────────────────────

describe('plugin lifecycle – unregister rollback', () => {
  it('unregistered plugin hooks are removed from HookRegistry', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('p', 'svg', 'svg-content'))
    expect(registry.getRegistered('loader:load')).toHaveLength(1)

    pluginReg.unregister('p')
    expect(pluginReg.has('p')).toBe(false)
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
  })

  it('unregistered plugin does not fire after removal', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('p', 'svg', 'svg-content'))
    pluginReg.unregister('p')

    const out = await execLoad(registry, 'icon.svg')
    expect(out.contents).toBeUndefined()
  })

  it('unregister returns false for unknown plugin', () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)
    expect(pluginReg.unregister('ghost')).toBe(false)
  })
})

// ── 多插件协同 ────────────────────────────────────────────────────────────────

describe('plugin lifecycle – multi-plugin', () => {
  it('multiple plugins register independent hooks', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('css-plugin', 'css', 'css-output'))
    await pluginReg.register(makeLoaderPlugin('yaml-plugin', 'yaml', 'yaml-output'))

    expect(registry.getRegistered('loader:load')).toHaveLength(2)

    expect((await execLoad(registry, 'style.css')).contents).toBe('css-output:style.css')
    expect((await execLoad(registry, 'config.yaml')).contents).toBe('yaml-output:config.yaml')
  })

  it('unregistering one plugin leaves the other intact', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('css-plugin', 'css', 'css-output'))
    await pluginReg.register(makeLoaderPlugin('yaml-plugin', 'yaml', 'yaml-output'))

    pluginReg.unregister('css-plugin')

    expect(registry.getRegistered('loader:load')).toHaveLength(1)
    expect((await execLoad(registry, 'config.yaml')).contents).toBe('yaml-output:config.yaml')
    expect((await execLoad(registry, 'style.css')).contents).toBeUndefined()
  })
})

// ── dispose() 批量清理 ────────────────────────────────────────────────────────

describe('plugin lifecycle – dispose', () => {
  it('dispose removes all plugins and their hooks', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('a', 'ts', 'ts-out'))
    await pluginReg.register(makeLoaderPlugin('b', 'tsx', 'tsx-out'))

    pluginReg.dispose()

    expect(pluginReg.list()).toHaveLength(0)
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
  })

  it('after dispose, loader does not fire', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('a', 'ts', 'ts-out'))
    pluginReg.dispose()

    const out = await execLoad(registry, 'app.ts')
    expect(out.contents).toBeUndefined()
  })
})

// ── Bun.plugin 兼容生命周期 ───────────────────────────────────────────────────

describe('plugin lifecycle – Bun.plugin compat', () => {
  it('registerBunPlugin → disable → unregister rollback', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.registerBunPlugin({
      name: 'bun-svg',
      setup(build) {
        build.onLoad({ filter: /\.svg$/ }, async args => ({
          contents: `<svg from="${args.path}" />`,
          loader: 'text' as const,
        }))
      },
    })

    // 生效
    const out1 = await execLoad(registry, 'icon.svg')
    expect(out1.contents).toContain('icon.svg')

    // 停用
    pluginReg.disable('bun-svg')
    const out2 = await execLoad(registry, 'icon.svg')
    expect(out2.contents).toBeUndefined()

    // 卸载 → 回滚
    pluginReg.unregister('bun-svg')
    expect(registry.getRegistered('loader:load')).toHaveLength(0)
  })
})

// ── list() 状态一致性 ─────────────────────────────────────────────────────────

describe('plugin lifecycle – list() consistency', () => {
  it('list() reflects real-time plugin state', async () => {
    const registry = new HookRegistry()
    const pluginReg = new PluginRegistry(registry)

    await pluginReg.register(makeLoaderPlugin('a', 'ts', 'x'))
    await pluginReg.register(makeLoaderPlugin('b', 'css', 'y'))
    pluginReg.disable('a')

    expect(pluginReg.get('a')?.enabled).toBe(false)
    expect(pluginReg.get('b')?.enabled).toBe(true)

    pluginReg.unregister('b')
    expect(pluginReg.list().map(p => p.name)).toEqual(['a'])
  })
})
