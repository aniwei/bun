/**
 * 真实目录门禁适配 — node-modules-layout (bun-install 扁平化布局)
 *
 * 映射来源：test/cli/install/bun-install.test.ts（hoist/nested/dedup 子集）
 * 原始语义：hoisted flat install、nested install for conflicts、
 *   deduplication、root packages at /node_modules/<name>、
 *   layout plan contains all packages
 *
 * 本文件验证 @mars/web-installer node-modules-layout.ts 的布局规划语义：
 *   1. 根依赖安装到 /node_modules/<name>
 *   2. 无冲突的 transitive 依赖被 hoist 到根 /node_modules
 *   3. 同名不同版本导致嵌套（不 hoist）
 *   4. 多个包依赖同一版本时只有一个 layout entry（去重）
 *   5. layout plan entries 按 installPath 有序排列
 *   6. layout links 正确指向 resolved installPath
 */
import { describe, expect, test } from 'vitest'
import {
  buildLayoutGraphFromLockfile,
  planNodeModulesLayoutFromLockfile,
  planNodeModulesLayout,
  resolveRootPackageKeys,
} from '../../../packages/bun-web-installer/src/node-modules-layout'
import { createEmptyLockfile, upsertLockfilePackage } from '../../../packages/bun-web-installer/src/lockfile'

// ─── Lockfile builder ────────────────────────────────────────────────────────

function buildLockfile(pkgs: Array<{ key: string; name: string; version: string; deps?: Record<string, string> }>) {
  let lockfile = createEmptyLockfile()
  for (const pkg of pkgs) {
    lockfile = upsertLockfilePackage(lockfile, pkg.key, {
      name: pkg.name,
      version: pkg.version,
      resolved: `https://r.test/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,
      dependencies: pkg.deps,
    })
  }
  return lockfile
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function entriesByPath(plan: ReturnType<typeof planNodeModulesLayoutFromLockfile>) {
  return Object.fromEntries(plan.entries.map(e => [e.installPath, e.packageKey]))
}

describe('node-modules-layout (web installer port of bun-install hoisting semantics)', () => {
  // Maps to: "installs a package" — root deps land at /node_modules/<name>
  test('root dependency is placed at /node_modules/<name>', () => {
    const lockfile = buildLockfile([{ key: 'foo@1.0.0', name: 'foo', version: '1.0.0' }])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { foo: '1.0.0' })
    const byPath = entriesByPath(plan)

    expect(byPath['/node_modules/foo']).toBe('foo@1.0.0')
  })

  // Maps to: "installs a package with dependencies" — transitive hoisted
  test('transitive dependency without version conflict is hoisted to root', () => {
    const lockfile = buildLockfile([
      { key: 'bar@1.0.0', name: 'bar', version: '1.0.0', deps: { baz: '1.0.0' } },
      { key: 'baz@1.0.0', name: 'baz', version: '1.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { bar: '1.0.0' })
    const byPath = entriesByPath(plan)

    // Both hoisted to root node_modules
    expect(byPath['/node_modules/bar']).toBe('bar@1.0.0')
    expect(byPath['/node_modules/baz']).toBe('baz@1.0.0')
    // No nested copies
    expect(byPath['/node_modules/bar/node_modules/baz']).toBeUndefined()
  })

  // Maps to: "hoists a package which shares a dependency" — shared dep dedup
  test('two root packages sharing same transitive version share one layout entry', () => {
    const lockfile = buildLockfile([
      { key: 'foo@1.0.0', name: 'foo', version: '1.0.0', deps: { shared: '1.0.0' } },
      { key: 'bar@1.0.0', name: 'bar', version: '1.0.0', deps: { shared: '1.0.0' } },
      { key: 'shared@1.0.0', name: 'shared', version: '1.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { foo: '1.0.0', bar: '1.0.0' })
    const byPath = entriesByPath(plan)

    // Only one entry for 'shared'
    const sharedPaths = Object.keys(byPath).filter(p => p.includes('/shared'))
    expect(sharedPaths).toHaveLength(1)
    expect(sharedPaths[0]).toBe('/node_modules/shared')
  })

  // Maps to: conflicting transitive versions get nested
  test('conflicting transitive dependency versions produce nested node_modules', () => {
    const lockfile = buildLockfile([
      { key: 'foo@1.0.0', name: 'foo', version: '1.0.0', deps: { dep: '1.0.0' } },
      { key: 'bar@1.0.0', name: 'bar', version: '1.0.0', deps: { dep: '2.0.0' } },
      { key: 'dep@1.0.0', name: 'dep', version: '1.0.0' },
      { key: 'dep@2.0.0', name: 'dep', version: '2.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { foo: '1.0.0', bar: '1.0.0' })
    const byPath = entriesByPath(plan)

    // Both dep versions must appear somewhere
    const depEntries = Object.entries(byPath).filter(([, key]) => key.startsWith('dep@'))
    expect(depEntries.length).toBe(2)

    // One is hoisted to root, the other is nested
    const rootDep = byPath['/node_modules/dep']
    expect(rootDep).toBeDefined()
    const nestedDepPaths = Object.keys(byPath).filter(
      p => p !== '/node_modules/dep' && p.endsWith('/dep'),
    )
    expect(nestedDepPaths.length).toBe(1)
  })

  // Maps to: layout plan entries are sorted
  test('layout plan entries are sorted by installPath', () => {
    const lockfile = buildLockfile([
      { key: 'zzz@1.0.0', name: 'zzz', version: '1.0.0' },
      { key: 'aaa@1.0.0', name: 'aaa', version: '1.0.0' },
      { key: 'mmm@1.0.0', name: 'mmm', version: '1.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, {
      zzz: '1.0.0',
      aaa: '1.0.0',
      mmm: '1.0.0',
    })

    const paths = plan.entries.map(e => e.installPath)
    expect(paths).toEqual([...paths].sort())
  })

  // Maps to: "layout links resolve to correct installPath"
  test('layout links point from requester package to resolved installPath', () => {
    const lockfile = buildLockfile([
      { key: 'app@1.0.0', name: 'app', version: '1.0.0', deps: { util: '1.0.0' } },
      { key: 'util@1.0.0', name: 'util', version: '1.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { app: '1.0.0' })

    const utilLink = plan.links.find(
      l => l.fromPackageKey === 'app@1.0.0' && l.dependencyName === 'util',
    )
    expect(utilLink).toBeDefined()
    expect(utilLink!.toInstallPath).toBe('/node_modules/util')
  })

  // Maps to: complete graph: all lockfile packages appear in layout
  test('all packages in lockfile appear in the layout plan', () => {
    const lockfile = buildLockfile([
      { key: 'root@1.0.0', name: 'root', version: '1.0.0', deps: { leaf1: '1.0.0', leaf2: '1.0.0' } },
      { key: 'leaf1@1.0.0', name: 'leaf1', version: '1.0.0' },
      { key: 'leaf2@1.0.0', name: 'leaf2', version: '1.0.0' },
    ])
    const plan = planNodeModulesLayoutFromLockfile(lockfile, { root: '1.0.0' })
    const packageKeys = new Set(plan.entries.map(e => e.packageKey))

    expect(packageKeys.has('root@1.0.0')).toBe(true)
    expect(packageKeys.has('leaf1@1.0.0')).toBe(true)
    expect(packageKeys.has('leaf2@1.0.0')).toBe(true)
  })
})
