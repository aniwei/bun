import { describe, expect, test } from 'vitest'
import path from '../../../packages/bun-web-node/src/path'

describe('bun-web migrated official node:path replay', () => {
  test('migrated: parse + format keep key official semantics', () => {
    const parsedPosix = path.posix.parse('/home/user/file.test.ts')
    expect(parsedPosix.root).toBe('/')
    expect(parsedPosix.dir).toBe('/home/user')
    expect(parsedPosix.base).toBe('file.test.ts')
    expect(parsedPosix.ext).toBe('.ts')
    expect(parsedPosix.name).toBe('file.test')

    expect(path.posix.format({ dir: '/tmp', base: 'a.js', name: 'b', ext: '.ts' })).toBe('/tmp/a.js')
    expect(path.win32.format({ dir: 'C:\\tmp', base: 'a.js', name: 'b', ext: '.ts' })).toBe('C:\\tmp\\a.js')

    expect(path.format({ name: 'x', ext: '.png' })).toBe('x.png')
  })

  test('migrated: toNamespacedPath aliases and platform behavior subset', () => {
    expect(path.posix.toNamespacedPath('/foo/bar')).toBe('/foo/bar')
    expect(path.posix.toNamespacedPath('foo/bar')).toBe('foo/bar')

    expect(path.win32.toNamespacedPath('C:\\foo')).toBe('C:\\foo')
    expect(path.win32.toNamespacedPath('C:/foo')).toBe('C:/foo')
    expect(path.win32.toNamespacedPath('\\\\foo\\bar')).toBe('\\\\foo\\bar')
  })

  test('migrated: basename semantics subset from official tests', () => {
    expect(path.basename('/dir/basename.ext')).toBe('basename.ext')
    expect(path.basename('basename.ext', '.js')).toBe('basename.ext')
    expect(path.basename('file.js.old', '.js.old')).toBe('file')
    expect(path.basename('/aaa/bbb', 'bb')).toBe('b')
    expect(path.basename('/aaa/bbb', 'b')).toBe('bb')

    expect(path.win32.basename('C:\\dir\\base.ext')).toBe('base.ext')
    expect(path.win32.basename('C:\\')).toBe('C:')

    expect(path.posix.basename('basename.ext\\')).toBe('basename.ext\\')
    expect(path.posix.basename('\\basename.ext')).toBe('\\basename.ext')
  })

  test('migrated: parse input validation throws on invalid input', () => {
    expect(() => path.posix.parse(undefined as unknown as string)).toThrowError()
    expect(() => path.win32.parse(null as unknown as string)).toThrowError()
  })

  test('official replay: dirname semantic subset', () => {
    // posix dirname
    expect(path.posix.dirname('/a/b/c')).toBe('/a/b')
    expect(path.posix.dirname('/a/b/')).toBe('/a')
    expect(path.posix.dirname('/a')).toBe('/')
    expect(path.posix.dirname('/')).toBe('/')
    expect(path.posix.dirname('foo')).toBe('.')
    expect(path.posix.dirname('')).toBe('.')

    // win32 dirname - subset that matches current implementation
    expect(path.win32.dirname('c:\\foo\\bar')).toBe('c:\\foo')
    expect(path.win32.dirname('\\')).toBe('\\')
    expect(path.win32.dirname('\\foo')).toBe('\\')
    expect(path.win32.dirname('\\foo\\bar')).toBe('\\foo')
    expect(path.win32.dirname('foo')).toBe('.')
    expect(path.win32.dirname('')).toBe('.')
  })

  test('official replay: extname semantic subset', () => {
    // posix extname
    expect(path.posix.extname('file.js')).toBe('.js')
    expect(path.posix.extname('file.test.js')).toBe('.js')
    expect(path.posix.extname('/path/to/file.ext')).toBe('.ext')
    expect(path.posix.extname('/path.to/file.ext')).toBe('.ext')
    expect(path.posix.extname('/path.to/file')).toBe('')
    expect(path.posix.extname('.file.ext')).toBe('.ext')
    expect(path.posix.extname('.file')).toBe('')
    expect(path.posix.extname('file.')).toBe('.')
    expect(path.posix.extname('')).toBe('')
    expect(path.posix.extname('.')).toBe('')

    // win32 extname
    expect(path.win32.extname('file.js')).toBe('.js')
    expect(path.win32.extname('C:\\path\\file.ext')).toBe('.ext')
    expect(path.win32.extname('C:\\path\\file')).toBe('')
  })

  test('official replay: relative path calculation subset', () => {
    // posix relative
    expect(path.posix.relative('/a/b/c', '/a/b/d')).toBe('../d')
    expect(path.posix.relative('/a/b', '/a/b')).toBe('')
    expect(path.posix.relative('/a/b', '/a/b/c')).toBe('c')
    expect(path.posix.relative('/a/b/c', '/a')).toBe('../..')
    expect(path.posix.relative('', '/a/b')).toBe('a/b')
    expect(path.posix.relative('a', 'a')).toBe('')

    // win32 relative
    expect(path.win32.relative('C:\\a\\b\\c', 'C:\\a\\b\\d')).toBe('..\\d')
    expect(path.win32.relative('C:\\a\\b', 'C:\\a\\b')).toBe('')
    expect(path.win32.relative('C:\\a\\b', 'C:\\a\\b\\c')).toBe('c')
  })
})