import { describe, expect, test } from 'vitest'
import {
  StringDecoder,
  URL,
  URLSearchParams,
  formatURL,
  parseQueryString,
  parseURL,
  querystring,
  resolveURL,
  stringifyQueryString,
} from '../../../packages/bun-web-node/src/url'
import { fileURLToPath, pathToFileURL } from '../../../packages/bun-web-node/src/url'

describe('bun-web M2 node url bridge smoke', () => {
  test('URL and resolve helpers work', () => {
    const resolved = resolveURL('https://example.com/a/b/c', '../d?x=1#k')
    expect(resolved).toBe('https://example.com/a/d?x=1#k')

    const parsed = parseURL('https://example.com:8080/p?q=1#hash')
    expect(parsed.protocol).toBe('https:')
    expect(parsed.host).toBe('example.com:8080')
    expect(parsed.pathname).toBe('/p')
    expect(parsed.search).toBe('?q=1')

    const url = new URL('https://bun.sh/docs')
    expect(formatURL(url)).toBe('https://bun.sh/docs')
  })

  test('querystring parse and stringify work', () => {
    const output = stringifyQueryString({ a: '1', b: ['2', '3'], c: 'x y' })
    expect(output).toBe('a=1&b=2&b=3&c=x%20y')

    const parsed = parseQueryString('a=1&b=2&b=3&c=x%20y')
    expect(parsed.a).toBe('1')
    expect(parsed.b).toEqual(['2', '3'])
    expect(parsed.c).toBe('x y')

    expect(querystring.stringify({ n: '42' })).toBe('n=42')
    expect(querystring.parse('n=42').n).toBe('42')
  })

  test('URLSearchParams is exported', () => {
    const params = new URLSearchParams('x=1&x=2')
    expect(params.getAll('x')).toEqual(['1', '2'])
  })

  test('parseURL can parse query object', () => {
    const parsed = parseURL('https://example.com/path?x=1&x=2', true)
    const query = parsed.query as { x: string[] }
    expect(query.x).toEqual(['1', '2'])
  })

  test('fileURLToPath converts file:// URL to fs path', () => {
    expect(fileURLToPath('file:///a/b/c.ts')).toBe('/a/b/c.ts')
    expect(fileURLToPath('file:///a/b/with%20space.ts')).toBe('/a/b/with space.ts')
    expect(fileURLToPath(new URL('file:///home/user/app.js'))).toBe('/home/user/app.js')
  })

  test('pathToFileURL converts fs path to file:// URL', () => {
    const u = pathToFileURL('/home/user/app.js')
    expect(u.href).toBe('file:///home/user/app.js')
    expect(u.protocol).toBe('file:')

    const u2 = pathToFileURL('/path/with space/file.ts')
    expect(u2.href).toBe('file:///path/with%20space/file.ts')
  })

  test('StringDecoder supports utf8 and base64 paths', () => {
    const utf8 = new StringDecoder('utf8')
    expect(utf8.write(Buffer.from('hello'))).toBe('hello')
    expect(utf8.end()).toBe('')

    const base64 = new StringDecoder('base64')
    expect(base64.write(Buffer.from('abc'))).toBe('YWJj')
    expect(base64.end(Buffer.from('de'))).toBe('ZGU=')
  })
})
