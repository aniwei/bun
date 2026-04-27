/**
 * 真实目录门禁适配 — install cache store 语义
 *
 * 覆盖点：
 * 1. tarball cache miss 会回源并写入缓存
 * 2. 二次安装命中缓存时不请求 tarball URL
 * 3. 缓存内容 integrity 不匹配时会回源刷新
 * 4. lockfile-only 模式不会触发 tarball cache 读写
 */
import { describe, expect, test } from 'vitest'
import { installFromManifest } from '../../../packages/bun-web-installer/src'

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number): void {
  const octal = value.toString(8).padStart(width - 1, '0')
  writeAscii(target, offset, octal)
  target[offset + width - 1] = 0
}

function createTar(entries: Array<{ path: string; data?: string }>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.data ?? '')
    const header = new Uint8Array(512)
    writeAscii(header, 0, entry.path)
    writeOctal(header, 100, 8, 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, content.length)
    writeOctal(header, 136, 12, 0)
    header[156] = '0'.charCodeAt(0)
    writeAscii(header, 257, 'ustar\0')
    writeAscii(header, 263, '00')
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let checksum = 0
    for (let i = 0; i < header.length; i++) checksum += header[i]
    const checksumText = checksum.toString(8).padStart(6, '0')
    writeAscii(header, 148, checksumText)
    header[154] = 0
    header[155] = 0x20
    blocks.push(header)
    if (content.length > 0) {
      blocks.push(content)
      const remainder = content.length % 512
      if (remainder !== 0) blocks.push(new Uint8Array(512 - remainder))
    }
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512))
  const total = blocks.reduce((sum, b) => sum + b.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

function toStrict(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength)
  out.set(input)
  return out
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  await writer.write(toStrict(data))
  await writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

async function toSRI(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-512', toStrict(data))
  return `sha512-${Buffer.from(digest).toString('base64')}`
}

const REGISTRY = 'https://registry.example.test'

describe('install cache store (web installer port)', () => {
  test('cache miss downloads tarball and writes cache entry', async () => {
    const tarballUrl = `${REGISTRY}/cache-demo/-/cache-demo-1.0.0.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"cache-demo","version":"1.0.0"}' }]))
    const integrity = await toSRI(tarball)

    let setCalls = 0
    const cacheMap = new Map<string, Uint8Array>()

    const result = await installFromManifest(
      { dependencies: { 'cache-demo': 'latest' } },
      {
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          if (url === `${REGISTRY}/cache-demo`) {
            return new Response(
              JSON.stringify({
                name: 'cache-demo',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': { dist: { tarball: tarballUrl, integrity } },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          if (url === tarballUrl) return new Response(toStrict(tarball), { status: 200 })
          return new Response('not found', { status: 404 })
        },
        tarballCache: {
          getTarball: async key => cacheMap.get(key) ?? null,
          setTarball: async (key, bytes) => {
            setCalls += 1
            cacheMap.set(key, new Uint8Array(bytes))
          },
        },
      },
    )

    expect(result.lockfile.packages['cache-demo@1.0.0']).toBeDefined()
    expect(setCalls).toBe(1)
    expect(cacheMap.has('cache-demo@1.0.0')).toBe(true)
  })

  test('second install uses cached tarball and does not request tarball url', async () => {
    const tarballUrl = `${REGISTRY}/cache-hit/-/cache-hit-1.0.0.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"cache-hit","version":"1.0.0"}' }]))
    const integrity = await toSRI(tarball)

    const cacheMap = new Map<string, Uint8Array>([['cache-hit@1.0.0', new Uint8Array(tarball)]])
    let tarballRequests = 0

    const result = await installFromManifest(
      { dependencies: { 'cache-hit': 'latest' } },
      {
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          if (url === `${REGISTRY}/cache-hit`) {
            return new Response(
              JSON.stringify({
                name: 'cache-hit',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': { dist: { tarball: tarballUrl, integrity } },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          if (url === tarballUrl) {
            tarballRequests += 1
            return new Response(toStrict(tarball), { status: 200 })
          }
          return new Response('not found', { status: 404 })
        },
        tarballCache: {
          getTarball: async key => cacheMap.get(key) ?? null,
          setTarball: async (key, bytes) => {
            cacheMap.set(key, new Uint8Array(bytes))
          },
        },
      },
    )

    expect(result.lockfile.packages['cache-hit@1.0.0']).toBeDefined()
    expect(tarballRequests).toBe(0)
  })

  test('integrity mismatch on cached tarball triggers refetch and cache refresh', async () => {
    const tarballUrl = `${REGISTRY}/cache-refresh/-/cache-refresh-1.0.0.tgz`
    const goodTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"cache-refresh","version":"1.0.0"}' }]))
    const badTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"cache-refresh","version":"9.9.9"}' }]))
    const integrity = await toSRI(goodTarball)

    const cacheMap = new Map<string, Uint8Array>([['cache-refresh@1.0.0', new Uint8Array(badTarball)]])
    let tarballRequests = 0

    const result = await installFromManifest(
      { dependencies: { 'cache-refresh': 'latest' } },
      {
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          if (url === `${REGISTRY}/cache-refresh`) {
            return new Response(
              JSON.stringify({
                name: 'cache-refresh',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': { dist: { tarball: tarballUrl, integrity } },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          if (url === tarballUrl) {
            tarballRequests += 1
            return new Response(toStrict(goodTarball), { status: 200 })
          }
          return new Response('not found', { status: 404 })
        },
        tarballCache: {
          getTarball: async key => cacheMap.get(key) ?? null,
          setTarball: async (key, bytes) => {
            cacheMap.set(key, new Uint8Array(bytes))
          },
        },
      },
    )

    expect(result.lockfile.packages['cache-refresh@1.0.0']).toBeDefined()
    expect(tarballRequests).toBe(1)
    expect(cacheMap.get('cache-refresh@1.0.0')).toEqual(goodTarball)
  })

  test('lockfile-only mode does not touch tarball cache', async () => {
    const tarballUrl = `${REGISTRY}/lock-only/-/lock-only-1.0.0.tgz`
    let getCalls = 0
    let setCalls = 0

    const result = await installFromManifest(
      { dependencies: { 'lock-only': 'latest' } },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          if (url === `${REGISTRY}/lock-only`) {
            return new Response(
              JSON.stringify({
                name: 'lock-only',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': { dist: { tarball: tarballUrl } },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response('not found', { status: 404 })
        },
        tarballCache: {
          getTarball: async () => {
            getCalls += 1
            return null
          },
          setTarball: async () => {
            setCalls += 1
          },
        },
      },
    )

    expect(result.lockfile.packages['lock-only@1.0.0']).toBeDefined()
    expect(getCalls).toBe(0)
    expect(setCalls).toBe(0)
  })
})
