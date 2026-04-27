import { describe, expect, test } from 'vitest'
import { VFS } from '../../../packages/bun-web-vfs/src/overlay-fs'
import { createNodeFs } from '../../../packages/bun-web-node/src/fs'
import { createRequire, isBuiltin } from '../../../packages/bun-web-node/src/module'

describe('bun-web migrated official fs stats replay', () => {
  test('migrated: new Stats(...) assigns fields in Node order', () => {
    const fs = createNodeFs(new VFS())
    const args = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    const expected = {
      dev: 0,
      mode: 1,
      nlink: 2,
      uid: 3,
      gid: 4,
      rdev: 5,
      blksize: 6,
      ino: 7,
      size: 8,
      blocks: 9,
      atimeMs: 10,
      mtimeMs: 11,
      ctimeMs: 12,
      birthtimeMs: 13,
    }

    expect({ ...new fs.Stats(...args) }).toMatchObject(expected)
  })

  test('migrated: Stats(...) without new assigns fields in Node order', () => {
    const fs = createNodeFs(new VFS())
    const args = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    const expected = {
      dev: 0,
      mode: 1,
      nlink: 2,
      uid: 3,
      gid: 4,
      rdev: 5,
      blksize: 6,
      ino: 7,
      size: 8,
      blocks: 9,
      atimeMs: 10,
      mtimeMs: 11,
      ctimeMs: 12,
      birthtimeMs: 13,
    }

    const called = (fs.Stats as (...input: number[]) => Record<string, unknown>)(...args)
    expect({ ...called }).toMatchObject(expected)
  })

  test('migrated: Stats instances share Stats.prototype', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)
    vfs.mkdirSync('/stats', { recursive: true })
    vfs.writeFileSync('/stats/a.txt', 'a')

    const args = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    const fromSync = fs.statSync('/stats/a.txt')
    const fromNew = new fs.Stats(...args)
    const fromCall = (fs.Stats as (...input: number[]) => object)(...args)

    expect(fromSync instanceof fs.Stats).toBe(true)
    expect(fromNew instanceof fs.Stats).toBe(true)
    expect(fromCall instanceof fs.Stats).toBe(true)
    expect(Object.getPrototypeOf(fromSync)).toBe(fs.Stats.prototype)
    expect(Object.getPrototypeOf(fromNew)).toBe(fs.Stats.prototype)
    expect(Object.getPrototypeOf(fromCall)).toBe(fs.Stats.prototype)

    const bigint = fs.statSync('/stats/a.txt', { bigint: true })
    expect(Object.getPrototypeOf(bigint).constructor.name).toBe('BigIntStats')
    expect(bigint instanceof Object.getPrototypeOf(bigint).constructor).toBe(true)
  })

  test('migrated: fs stats truncate (number path)', () => {
    const fs = createNodeFs(new VFS())
    const stats = new fs.Stats(...Array.from({ length: 14 }, () => Number.MAX_VALUE))

    expect(stats.dev).toBeGreaterThan(0)
    expect(stats.mode).toBeGreaterThan(0)
    expect(stats.nlink).toBeGreaterThan(0)
    expect(stats.uid).toBeGreaterThan(0)
    expect(stats.gid).toBeGreaterThan(0)
    expect(stats.rdev).toBeGreaterThan(0)
    expect(stats.blksize).toBeGreaterThan(0)
    expect(stats.ino).toBeGreaterThan(0)
    expect(stats.size).toBeGreaterThan(0)
    expect(stats.blocks).toBeGreaterThan(0)
    expect(stats.atimeMs).toBeGreaterThan(0)
    expect(stats.mtimeMs).toBeGreaterThan(0)
    expect(stats.ctimeMs).toBeGreaterThan(0)
    expect(stats.birthtimeMs).toBeGreaterThan(0)
  })

  test('migrated: fs stats truncate (bigint path)', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)
    vfs.mkdirSync('/big', { recursive: true })
    vfs.writeFileSync('/big/a.txt', 'a')
    const stats = fs.statSync('/big/a.txt', { bigint: true })

    expect(stats.dev).toBeTypeOf('bigint')
    expect(stats.mode).toBeTypeOf('bigint')
    expect(stats.nlink).toBeTypeOf('bigint')
    expect(stats.uid).toBeTypeOf('bigint')
    expect(stats.gid).toBeTypeOf('bigint')
    expect(stats.rdev).toBeTypeOf('bigint')
    expect(stats.blksize).toBeTypeOf('bigint')
    expect(stats.ino).toBeTypeOf('bigint')
    expect(stats.size).toBeTypeOf('bigint')
    expect(stats.blocks).toBeTypeOf('bigint')
    expect(stats.atimeMs).toBeTypeOf('bigint')
    expect(stats.mtimeMs).toBeTypeOf('bigint')
    expect(stats.ctimeMs).toBeTypeOf('bigint')
    expect(stats.birthtimeMs).toBeTypeOf('bigint')
  })

  test('migrated: createStatsForIno keeps Node cast behavior', () => {
    const req = createRequire('/entry.js')
    const { createStatsForIno } = req('bun:internal-for-testing') as {
      createStatsForIno: (ino: bigint, big: boolean) => { ino: number | bigint }
    }

    const cases = [0n, 1n, (1n << 53n) - 1n, (1n << 63n) - 1n, 1n << 63n, 9225185599684229422n, (1n << 64n) - 1n]

    expect(cases.map(ino => createStatsForIno(ino, false).ino)).toEqual(cases.map(Number))
    expect(cases.map(ino => createStatsForIno(ino, true).ino)).toEqual(cases.map(ino => BigInt.asIntN(64, ino)))
  })

  test('migrated: internal-for-testing bare alias resolves to bun internal module', () => {
    const req = createRequire('/entry.js')
    const byBare = req('internal-for-testing') as {
      createStatsForIno: (ino: bigint, big: boolean) => { ino: number | bigint }
    }
    const byBun = req('bun:internal-for-testing') as {
      createStatsForIno: (ino: bigint, big: boolean) => { ino: number | bigint }
    }

    expect(byBare.createStatsForIno(9n, false).ino).toBe(9)
    expect(byBun.createStatsForIno(9n, false).ino).toBe(9)
    expect(req.resolve('internal-for-testing')).toBe('bun:internal-for-testing')
    expect(req.resolve('bun:internal-for-testing')).toBe('bun:internal-for-testing')
    expect(isBuiltin('internal-for-testing')).toBe(true)
    expect(isBuiltin('bun:internal-for-testing')).toBe(true)
  })

  test('migrated: repeated aborted read/write does not break fs promises flow', async () => {
    const fs = createNodeFs(new VFS())

    for (let i = 0; i < 500; i++) {
      const alreadyAborted = AbortSignal.abort()
      await expect(fs.promises.readFile('/missing', { signal: alreadyAborted })).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      })

      await expect(fs.promises.writeFile('/file.txt', 'x', { signal: alreadyAborted })).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      })
    }
  })
})