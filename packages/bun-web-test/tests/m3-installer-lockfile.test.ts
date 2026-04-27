import { describe, expect, test } from 'vitest'

import {
  createEmptyLockfile,
  readLockfile,
  upsertLockfilePackage,
  writeLockfile,
} from '../../../packages/bun-web-installer/src/lockfile'

describe('bun-web M3 installer lockfile', () => {
  test('readLockfile parses and normalizes package/dependency order', () => {
    const parsed = readLockfile(`
{
  "lockfileVersion": 1,
  "packages": {
    "z": {
      "name": "z",
      "version": "1.0.0",
      "dependencies": {
        "b": "1.0.0",
        "a": "1.0.0"
      }
    },
    "a": {
      "name": "a",
      "version": "1.0.0"
    }
  }
}
`)

    expect(Object.keys(parsed.packages)).toEqual(['a', 'z'])
    expect(Object.keys(parsed.packages.z.dependencies ?? {})).toEqual(['a', 'b'])
  })

  test('writeLockfile generates stable deterministic output', () => {
    const lockfile = {
      lockfileVersion: 1 as const,
      packages: {
        'b@1.0.0': {
          name: 'b',
          version: '1.0.0',
          dependencies: {
            z: '^1.0.0',
            a: '^1.0.0',
          },
        },
        'a@1.0.0': {
          name: 'a',
          version: '1.0.0',
        },
      },
    }

    const first = writeLockfile(lockfile)
    const second = writeLockfile(readLockfile(first))
    expect(second).toBe(first)
  })

  test('upsertLockfilePackage performs minimal incremental update', () => {
    let lockfile = createEmptyLockfile()

    lockfile = upsertLockfilePackage(lockfile, 'react@18.2.0', {
      name: 'react',
      version: '18.2.0',
      resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
      integrity: 'sha512-demo',
    })

    lockfile = upsertLockfilePackage(lockfile, 'scheduler@0.23.0', {
      name: 'scheduler',
      version: '0.23.0',
      dependencies: {
        react: '^18.2.0',
      },
    })

    expect(Object.keys(lockfile.packages)).toEqual(['react@18.2.0', 'scheduler@0.23.0'])
    expect(lockfile.packages['react@18.2.0'].version).toBe('18.2.0')
    expect(lockfile.packages['scheduler@0.23.0'].dependencies?.react).toBe('^18.2.0')
  })

  test('repeated upsert with same content does not change serialized lockfile', () => {
    const base = upsertLockfilePackage(createEmptyLockfile(), 'left-pad@1.3.0', {
      name: 'left-pad',
      version: '1.3.0',
      dependencies: {
        '@scope/helper': '^1.0.0',
      },
    })

    const first = writeLockfile(base)

    const updated = upsertLockfilePackage(base, 'left-pad@1.3.0', {
      name: 'left-pad',
      version: '1.3.0',
      dependencies: {
        '@scope/helper': '^1.0.0',
      },
    })
    const second = writeLockfile(updated)

    expect(second).toBe(first)
  })
})