import { describe, expect, test } from 'vitest'

import {
  createEmptyLockfile,
  planNodeModulesLayoutFromLockfile,
  upsertLockfilePackage,
} from '../../../packages/bun-web-installer/src'

describe('bun-web M3 installer node_modules layout', () => {
  test('hoists shared dependency with same resolved version to root node_modules', () => {
    let lockfile = createEmptyLockfile()

    lockfile = upsertLockfilePackage(lockfile, 'react@18.2.0', {
      name: 'react',
      version: '18.2.0',
    })

    lockfile = upsertLockfilePackage(lockfile, 'left-pad@1.3.0', {
      name: 'left-pad',
      version: '1.3.0',
      dependencies: {
        react: '18.2.0',
      },
    })

    lockfile = upsertLockfilePackage(lockfile, 'is-number@7.0.0', {
      name: 'is-number',
      version: '7.0.0',
      dependencies: {
        react: '18.2.0',
      },
    })

    const plan = planNodeModulesLayoutFromLockfile(lockfile, {
      'is-number': '7.0.0',
      'left-pad': '1.3.0',
    })

    expect(plan.entries).toEqual([
      { installPath: '/node_modules/is-number', packageKey: 'is-number@7.0.0' },
      { installPath: '/node_modules/left-pad', packageKey: 'left-pad@1.3.0' },
      { installPath: '/node_modules/react', packageKey: 'react@18.2.0' },
    ])

    const reactLinks = plan.links.filter(link => link.dependencyName === 'react')
    expect(reactLinks).toHaveLength(2)
    expect(reactLinks.every(link => link.toInstallPath === '/node_modules/react')).toBe(true)
  })

  test('keeps nested dependency when root slot has conflicting version', () => {
    let lockfile = createEmptyLockfile()

    lockfile = upsertLockfilePackage(lockfile, 'react@17.0.2', {
      name: 'react',
      version: '17.0.2',
    })
    lockfile = upsertLockfilePackage(lockfile, 'react@18.2.0', {
      name: 'react',
      version: '18.2.0',
    })

    lockfile = upsertLockfilePackage(lockfile, 'legacy-app@1.0.0', {
      name: 'legacy-app',
      version: '1.0.0',
      dependencies: {
        react: '17.0.2',
      },
    })

    lockfile = upsertLockfilePackage(lockfile, 'modern-app@1.0.0', {
      name: 'modern-app',
      version: '1.0.0',
      dependencies: {
        react: '18.2.0',
      },
    })

    const plan = planNodeModulesLayoutFromLockfile(lockfile, {
      'legacy-app': '1.0.0',
      'modern-app': '1.0.0',
    })

    expect(plan.entries).toContainEqual({
      installPath: '/node_modules/legacy-app',
      packageKey: 'legacy-app@1.0.0',
    })
    expect(plan.entries).toContainEqual({
      installPath: '/node_modules/modern-app',
      packageKey: 'modern-app@1.0.0',
    })

    const rootReact = plan.entries.find(entry => entry.installPath === '/node_modules/react')
    expect(rootReact).toBeDefined()
    expect(['react@17.0.2', 'react@18.2.0']).toContain(rootReact?.packageKey)

    const nestedReact = plan.entries.find(
      entry =>
        entry.installPath === '/node_modules/legacy-app/node_modules/react'
        || entry.installPath === '/node_modules/modern-app/node_modules/react',
    )
    expect(nestedReact).toBeDefined()
    expect(nestedReact?.packageKey).not.toBe(rootReact?.packageKey)
  })

  test('resolves deep dependency to already installed ancestor copy when possible', () => {
    let lockfile = createEmptyLockfile()

    lockfile = upsertLockfilePackage(lockfile, 'dep-c@1.0.0', {
      name: 'dep-c',
      version: '1.0.0',
    })
    lockfile = upsertLockfilePackage(lockfile, 'dep-b@1.0.0', {
      name: 'dep-b',
      version: '1.0.0',
      dependencies: {
        'dep-c': '1.0.0',
      },
    })
    lockfile = upsertLockfilePackage(lockfile, 'dep-a@1.0.0', {
      name: 'dep-a',
      version: '1.0.0',
      dependencies: {
        'dep-b': '1.0.0',
        'dep-c': '1.0.0',
      },
    })

    const plan = planNodeModulesLayoutFromLockfile(lockfile, {
      'dep-a': '1.0.0',
    })

    expect(plan.entries).toEqual([
      { installPath: '/node_modules/dep-a', packageKey: 'dep-a@1.0.0' },
      { installPath: '/node_modules/dep-b', packageKey: 'dep-b@1.0.0' },
      { installPath: '/node_modules/dep-c', packageKey: 'dep-c@1.0.0' },
    ])

    const directLink = plan.links.find(
      link => link.fromPackageKey === 'dep-a@1.0.0' && link.dependencyName === 'dep-c',
    )
    const transitiveLink = plan.links.find(
      link => link.fromPackageKey === 'dep-b@1.0.0' && link.dependencyName === 'dep-c',
    )

    expect(directLink?.toInstallPath).toBe('/node_modules/dep-c')
    expect(transitiveLink?.toInstallPath).toBe('/node_modules/dep-c')
  })

  test('throws clear error when root dependency cannot be resolved from lockfile', () => {
    const lockfile = createEmptyLockfile()

    expect(() =>
      planNodeModulesLayoutFromLockfile(lockfile, {
        express: '^4.0.0',
      }),
    ).toThrowError("Dependency 'express' not found in layout graph")
  })
})