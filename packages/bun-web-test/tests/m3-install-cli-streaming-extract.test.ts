/**
 * 真实目录门禁适配 — bun-install-streaming-extract.test.ts
 *
 * 映射来源：test/cli/install/bun-install-streaming-extract.test.ts
 * 可迁移语义（web installer 版本）：
 *   1. 分块（chunked）tarball 响应可正确解包并安装
 *   2. chunked 与 buffered（一次性）响应产出相同 lockfile/layout 结果
 *   3. chunked 场景下 integrity mismatch 必须失败
 *   4. 边界块大小（1 byte / 大块）下结果稳定
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

function createChunkedResponse(data: Uint8Array, chunkSize: number): Response {
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.byteLength)
      controller.enqueue(toStrict(data.slice(offset, end)))
      offset = end
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  })
}

const REGISTRY = 'https://registry.example.test'

function installWithFetch(fetchFn: (input: string | URL) => Promise<Response>) {
  return installFromManifest(
    { dependencies: { 'stream-pkg': '1.0.0' } },
    { registryUrl: REGISTRY, fetchFn },
  )
}

function installWithFetchAndRetry(
  fetchFn: (input: string | URL) => Promise<Response>,
  retryCount: number,
) {
  return installFromManifest(
    { dependencies: { 'stream-pkg': '1.0.0' } },
    { registryUrl: REGISTRY, fetchFn, retryCount },
  )
}

describe('bun-install-streaming-extract (web installer port)', () => {
  test('installs correctly from chunked tarball response', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const tar = createTar([
      { path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' },
      { path: 'package/index.js', data: 'module.exports = "ok"' },
      { path: 'package/data/a.txt', data: 'a'.repeat(1024) },
      { path: 'package/data/b.txt', data: 'b'.repeat(1024) },
      { path: 'package/data/c.txt', data: 'c'.repeat(1024) },
    ])
    const tgz = await gzip(tar)
    const integrity = await toSRI(tgz)

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl, integrity } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return createChunkedResponse(tgz, 97)
      return new Response('not found', { status: 404 })
    }

    const result = await installWithFetch(fetchFn)

    expect(result.lockfile.packages['stream-pkg@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['stream-pkg@1.0.0']?.integrity).toBe(integrity)
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/stream-pkg',
      packageKey: 'stream-pkg@1.0.0',
    })
  })

  test('chunked and buffered responses produce identical lockfile/layout', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const tar = createTar([
      { path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' },
      { path: 'package/index.js', data: 'module.exports = "ok"' },
    ])
    const tgz = await gzip(tar)
    const integrity = await toSRI(tgz)

    const makeFetch = (chunked: boolean) => async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl, integrity } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        return chunked ? createChunkedResponse(tgz, 128) : new Response(toStrict(tgz), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const chunked = await installWithFetch(makeFetch(true))
    const buffered = await installWithFetch(makeFetch(false))

    expect(JSON.stringify(chunked.lockfile)).toBe(JSON.stringify(buffered.lockfile))
    expect(JSON.stringify(chunked.layoutPlan)).toBe(JSON.stringify(buffered.layoutPlan))
  })

  test('chunked tarball rejects when integrity mismatches', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const good = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' }]))
    const bad = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"9.9.9"}' }]))
    const integrityGood = await toSRI(good)

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl, integrity: integrityGood } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return createChunkedResponse(bad, 111)
      return new Response('not found', { status: 404 })
    }

    await expect(() => installWithFetch(fetchFn)).rejects.toThrow(/integrity/i)
  })

  test('chunk size = 1 byte still installs successfully', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const tgz = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' }]))
    const integrity = await toSRI(tgz)

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl, integrity } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return createChunkedResponse(tgz, 1)
      return new Response('not found', { status: 404 })
    }

    const result = await installWithFetch(fetchFn)
    expect(result.lockfile.packages['stream-pkg@1.0.0']).toBeDefined()
  })

  test('very large chunk size behaves like buffered', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const tgz = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' }]))
    const integrity = await toSRI(tgz)

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl, integrity } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return createChunkedResponse(tgz, 1_000_000)
      return new Response('not found', { status: 404 })
    }

    const result = await installWithFetch(fetchFn)
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/stream-pkg',
      packageKey: 'stream-pkg@1.0.0',
    })
  })

  test('damaged tarball retries and succeeds on next attempt', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const goodTgz = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' }]))
    const damagedTgz = goodTgz.slice(0, Math.max(8, Math.floor(goodTgz.length / 3)))
    let tarballRequests = 0

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        return tarballRequests === 1
          ? createChunkedResponse(damagedTgz, 2)
          : createChunkedResponse(goodTgz, 97)
      }
      return new Response('not found', { status: 404 })
    }

    const result = await installWithFetchAndRetry(fetchFn, 1)
    expect(tarballRequests).toBe(2)
    expect(result.lockfile.packages['stream-pkg@1.0.0']).toBeDefined()
  })

  test('damaged tarball retry exhaustion surfaces attempt count', async () => {
    const tarballUrl = `${REGISTRY}/stream-pkg/-/stream-pkg-1.0.0.tgz`
    const goodTgz = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' }]))
    const damagedTgz = goodTgz.slice(0, Math.max(8, Math.floor(goodTgz.length / 3)))
    let tarballRequests = 0

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/stream-pkg`) {
        return new Response(
          JSON.stringify({
            name: 'stream-pkg',
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { dist: { tarball: tarballUrl } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        return createChunkedResponse(damagedTgz, 2)
      }
      return new Response('not found', { status: 404 })
    }

    await expect(() => installWithFetchAndRetry(fetchFn, 1)).rejects.toThrow(/after 2 attempts/)
    expect(tarballRequests).toBe(2)
  })
})
