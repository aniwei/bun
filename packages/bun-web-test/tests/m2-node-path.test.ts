import { describe, expect, test } from 'vitest'
import path, { posix, win32 } from '../../../packages/bun-web-node/src/path'

describe('bun-web M2 node path bridge smoke', () => {
  test('posix core methods work', () => {
    expect(posix.normalize('/foo//bar/../baz')).toBe('/foo/baz')
    expect(posix.join('/foo', 'bar', '..', 'baz')).toBe('/foo/baz')
    expect(posix.resolve('/a', 'b', '../c')).toBe('/a/c')
    expect(posix.relative('/a/b/c', '/a/d/e')).toBe('../../d/e')
    expect(posix.dirname('/a/b/file.txt')).toBe('/a/b')
    expect(posix.basename('/a/b/file.txt')).toBe('file.txt')
    expect(posix.extname('/a/b/file.txt')).toBe('.txt')
    expect(posix.isAbsolute('/a/b')).toBe(true)
    expect(posix.isAbsolute('a/b')).toBe(false)
  })

  test('win32 core methods work', () => {
    expect(win32.normalize('C:\\foo\\\\bar\\..\\baz')).toBe('C:\\foo\\baz')
    expect(win32.join('C:\\foo', 'bar', '..', 'baz')).toBe('C:\\foo\\baz')
    expect(win32.resolve('C:\\a', 'b', '..\\c')).toBe('C:\\a\\c')
    expect(win32.dirname('C:\\a\\b\\file.txt')).toBe('C:\\a\\b')
    expect(win32.basename('C:\\a\\b\\file.txt')).toBe('file.txt')
    expect(win32.extname('C:\\a\\b\\file.txt')).toBe('.txt')
    expect(win32.isAbsolute('C:\\a\\b')).toBe(true)
    expect(win32.isAbsolute('a\\b')).toBe(false)
  })

  test('default path exposes posix facade', () => {
    expect(path.sep).toBe('/')
    expect(path.normalize('/root//a/./b')).toBe('/root/a/b')
    expect(path.posix.basename('/tmp/x.js')).toBe('x.js')
    expect(path.win32.basename('C:\\tmp\\x.js')).toBe('x.js')
  })

  test('posix parse and format work', () => {
    const parsed = posix.parse('/home/user/file.test.ts')
    expect(parsed.root).toBe('/')
    expect(parsed.dir).toBe('/home/user')
    expect(parsed.base).toBe('file.test.ts')
    expect(parsed.ext).toBe('.ts')
    expect(parsed.name).toBe('file.test')

    const formatted = posix.format({ dir: '/home/user', name: 'file', ext: '.ts' })
    expect(formatted).toBe('/home/user/file.ts')

    // base takes priority over name+ext
    const formatted2 = posix.format({ dir: '/a', base: 'foo.txt' })
    expect(formatted2).toBe('/a/foo.txt')
  })

  test('win32 parse and format work', () => {
    const parsed = win32.parse('C:\\Users\\joe\\app.js')
    expect(parsed.root).toBe('C:\\')
    expect(parsed.dir).toBe('C:\\Users\\joe')
    expect(parsed.base).toBe('app.js')
    expect(parsed.ext).toBe('.js')
    expect(parsed.name).toBe('app')

    const formatted = win32.format({ root: 'C:\\', dir: 'C:\\Users', name: 'app', ext: '.js' })
    expect(formatted).toBe('C:\\Users\\app.js')
  })

  test('toNamespacedPath is a no-op on posix', () => {
    expect(posix.toNamespacedPath('/a/b/c')).toBe('/a/b/c')
    expect(posix.toNamespacedPath('relative')).toBe('relative')
  })

  test('official replay: format prefers base over name/ext', () => {
    expect(posix.format({ dir: '/tmp', base: 'a.js', name: 'b', ext: '.ts' })).toBe('/tmp/a.js')
    expect(win32.format({ dir: 'C:\\tmp', base: 'a.js', name: 'b', ext: '.ts' })).toBe('C:\\tmp\\a.js')
  })

  test('official replay: parse handles root-only and dotfiles', () => {
    const root = posix.parse('/')
    expect(root.root).toBe('/')
    expect(root.dir).toBe('/')
    expect(root.base).toBe('')

    const dot = posix.parse('/tmp/.env')
    expect(dot.base).toBe('.env')
    expect(dot.ext).toBe('')
    expect(dot.name).toBe('.env')
  })
})
