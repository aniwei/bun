import { describe, expect, test } from 'bun:test'
import { VFS } from '../../../packages/bun-web-vfs/src/overlay-fs'
import { createNodeFs } from '../../../packages/bun-web-node/src/fs'

describe('bun-web M2 node fs bridge smoke', () => {
  test('sync read write exists work', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    fs.mkdirSync('/app', { recursive: true })
    fs.writeFileSync('/app/a.txt', 'hello-fs')
    fs.appendFileSync('/app/a.txt', '+append')

    expect(fs.existsSync('/app/a.txt')).toBe(true)
    expect(fs.readFileSync('/app/a.txt', 'utf8')).toBe('hello-fs+append')
    expect(fs.readdirSync('/app')).toContain('a.txt')

    const stat = fs.statSync('/app/a.txt')
    expect(stat.isFile()).toBe(true)

    fs.renameSync('/app/a.txt', '/app/b.txt')
    expect(fs.existsSync('/app/a.txt')).toBe(false)
    expect(fs.existsSync('/app/b.txt')).toBe(true)

    fs.unlinkSync('/app/b.txt')
    expect(fs.existsSync('/app/b.txt')).toBe(false)

    fs.mkdirSync('/app/dir/sub', { recursive: true })
    fs.writeFileSync('/app/dir/sub/origin.txt', 'copy-me')
    fs.copyFileSync('/app/dir/sub/origin.txt', '/app/dir/sub/copied.txt')
    expect(fs.readFileSync('/app/dir/sub/copied.txt', 'utf8')).toBe('copy-me')

    fs.rmSync('/app/dir', { recursive: true })
    expect(fs.existsSync('/app/dir')).toBe(false)
    expect(fs.existsSync('/app/dir/sub/copied.txt')).toBe(false)

    fs.rmSync('/app/missing', { force: true })

    fs.mkdirSync('/app/types', { recursive: true })
    fs.writeFileSync('/app/types/file.txt', 'x')
    const dirents = fs.readdirSync('/app/types', { withFileTypes: true })
    expect(dirents[0]?.name).toBe('file.txt')
    expect(dirents[0]?.isFile()).toBe(true)

    let rmDirCode = ''
    try {
      fs.rmSync('/app/types')
    } catch (err) {
      const error = err as Error & { code?: string }
      rmDirCode = error.code ?? ''
    }

    expect(rmDirCode).toBe('EISDIR')
  })

  test('promises read write access work', async () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    await fs.promises.mkdir('/tmp', { recursive: true })
    await fs.promises.writeFile('/tmp/data.txt', 'abc')
    await fs.promises.appendFile('/tmp/data.txt', 'def')

    const content = await fs.promises.readFile('/tmp/data.txt', 'utf8')
    expect(content).toBe('abcdef')

    const stat = await fs.promises.stat('/tmp/data.txt')
    expect(stat.isFile()).toBe(true)

    await fs.promises.access('/tmp/data.txt')

    await fs.promises.rename('/tmp/data.txt', '/tmp/moved.txt')
    expect(await fs.promises.readFile('/tmp/moved.txt', 'utf8')).toBe('abcdef')

    await fs.promises.copyFile('/tmp/moved.txt', '/tmp/copied.txt')
    expect(await fs.promises.readFile('/tmp/copied.txt', 'utf8')).toBe('abcdef')

    await fs.promises.unlink('/tmp/moved.txt')
    expect(fs.existsSync('/tmp/moved.txt')).toBe(false)

    await fs.promises.rm('/tmp', { recursive: true })
    expect(fs.existsSync('/tmp')).toBe(false)

    await fs.promises.mkdir('/types', { recursive: true })
    await fs.promises.writeFile('/types/a.txt', 'a')
    const dirents = await fs.promises.readdir('/types', { withFileTypes: true })
    expect(dirents[0]?.name).toBe('a.txt')
    expect(dirents[0]?.isFile()).toBe(true)

    let rmDirCode = ''
    try {
      await fs.promises.rm('/types')
    } catch (err) {
      const error = err as Error & { code?: string }
      rmDirCode = error.code ?? ''
    }

    expect(rmDirCode).toBe('EISDIR')

    let code = ''
    try {
      await fs.promises.access('/tmp/missing.txt')
    } catch (err) {
      const error = err as Error & { code?: string }
      code = error.code ?? ''
    }

    expect(code).toBe('ENOENT')
  })

  test('lstatSync behaves like statSync (VFS has no symlinks)', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    fs.mkdirSync('/ltest', { recursive: true })
    fs.writeFileSync('/ltest/file.txt', 'content')

    const lstat = fs.lstatSync('/ltest/file.txt')
    const stat = fs.statSync('/ltest/file.txt')

    expect(lstat.isFile()).toBe(true)
    expect(lstat.isDirectory()).toBe(false)
    expect(lstat.size).toBe(stat.size)

    const lstatDir = fs.lstatSync('/ltest')
    expect(lstatDir.isDirectory()).toBe(true)
  })

  test('realpathSync normalises path when it exists', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    fs.mkdirSync('/real/sub', { recursive: true })
    fs.writeFileSync('/real/sub/file.ts', 'x')

    expect(fs.realpathSync('/real/sub/file.ts')).toBe('/real/sub/file.ts')
    expect(fs.realpathSync('/real/sub/../sub/file.ts')).toBe('/real/sub/file.ts')

    let code = ''
    try {
      fs.realpathSync('/real/missing.ts')
    } catch (err) {
      const error = err as Error & { code?: string }
      code = error.code ?? ''
    }
    expect(code).toBe('ENOENT')
  })

  test('promises.lstat and promises.realpath work', async () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    await fs.promises.mkdir('/pltest', { recursive: true })
    await fs.promises.writeFile('/pltest/f.txt', 'data')

    const lstat = await fs.promises.lstat('/pltest/f.txt')
    expect(lstat.isFile()).toBe(true)

    const real = await fs.promises.realpath('/pltest/f.txt')
    expect(real).toBe('/pltest/f.txt')
  })

  test('official replay: realpathSync accepts normalized equivalent path', () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    fs.mkdirSync('/r/a/b', { recursive: true })
    fs.writeFileSync('/r/a/b/file.js', 'x')

    expect(fs.realpathSync('/r/a/./b/../b/file.js')).toBe('/r/a/b/file.js')
  })

  test('official replay: promises lstat matches stat type', async () => {
    const vfs = new VFS()
    const fs = createNodeFs(vfs)

    await fs.promises.mkdir('/p/types', { recursive: true })
    await fs.promises.writeFile('/p/types/a.txt', 'a')

    const [s1, s2] = await Promise.all([
      fs.promises.stat('/p/types/a.txt'),
      fs.promises.lstat('/p/types/a.txt'),
    ])

    expect(s1.isFile()).toBe(true)
    expect(s2.isFile()).toBe(true)
    expect(s1.isDirectory()).toBe(false)
    expect(s2.isDirectory()).toBe(false)
  })
})
