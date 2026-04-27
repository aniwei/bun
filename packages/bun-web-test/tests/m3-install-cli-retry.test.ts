/**
 * 真实目录门禁适配 — bun-install-retry.test.ts
 *
 * 映射来源：test/cli/install/bun-install-retry.test.ts
 * 原始语义：registry 5xx 时会重试，最终成功安装
 *
 * 本文件聚焦 installFromManifest 的可观测重试策略：
 *   1. metadata 5xx 重试并最终成功
 *   2. tarball 5xx 重试并最终成功
 *   3. metadata 4xx 不重试
 *   4. tarball 4xx 不重试
 *   5. metadata 重试耗尽时包含 attempt 信息
 *   6. tarball 重试耗尽时包含 attempt 信息
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

describe('bun-install-retry (web installer port)', () => {
  test('retries metadata on 5xx and succeeds', async () => {
    const tarballUrl = `${REGISTRY}/bar/-/bar-0.0.2.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"bar","version":"0.0.2"}' }]))
    const integrity = await toSRI(tarball)

    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/BaR`) {
        metadataRequests += 1
        if (metadataRequests <= 3) {
          return new Response('temporary failure', { status: 503, statusText: 'Service Unavailable' })
        }
        return new Response(
          JSON.stringify({
            name: 'BaR',
            'dist-tags': { latest: '0.0.2' },
            versions: {
              '0.0.2': { dist: { tarball: tarballUrl, integrity } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return new Response(toStrict(tarball), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const result = await installFromManifest(
      { dependencies: { BaR: 'latest' } },
      { registryUrl: REGISTRY, fetchFn, retryCount: 5 },
    )

    expect(metadataRequests).toBe(4)
    expect(result.resolvedRootDependencies.BaR).toBe('0.0.2')
    expect(result.lockfile.packages['BaR@0.0.2']).toBeDefined()
  })

  test('retries tarball on 5xx and succeeds', async () => {
    const tarballUrl = `${REGISTRY}/retry-tar/-/retry-tar-1.0.0.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"retry-tar","version":"1.0.0"}' }]))
    const integrity = await toSRI(tarball)

    let tarballRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/retry-tar`) {
        return new Response(
          JSON.stringify({
            name: 'retry-tar',
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
        if (tarballRequests <= 2) {
          return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
        }
        return new Response(toStrict(tarball), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const result = await installFromManifest(
      { dependencies: { 'retry-tar': 'latest' } },
      { registryUrl: REGISTRY, fetchFn, retryCount: 3 },
    )

    expect(tarballRequests).toBe(3)
    expect(result.lockfile.packages['retry-tar@1.0.0']).toBeDefined()
  })

  test('does not retry metadata on 4xx', async () => {
    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/missing-meta`) {
        metadataRequests += 1
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'missing-meta': 'latest' } },
        { registryUrl: REGISTRY, fetchFn, retryCount: 5 },
      ),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')

    expect(metadataRequests).toBe(1)
  })

  test('does not retry tarball on 4xx', async () => {
    const tarballUrl = `${REGISTRY}/missing-tar/-/missing-tar-1.0.0.tgz`
    let tarballRequests = 0

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/missing-tar`) {
        return new Response(
          JSON.stringify({
            name: 'missing-tar',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'missing-tar': 'latest' } },
        { registryUrl: REGISTRY, fetchFn, retryCount: 5 },
      ),
    ).rejects.toThrow('Failed to download tarball: 404 Not Found')

    expect(tarballRequests).toBe(1)
  })

  test('metadata retry exhaustion reports attempts', async () => {
    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/always-503`) {
        metadataRequests += 1
        return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'always-503': 'latest' } },
        { registryUrl: REGISTRY, fetchFn, retryCount: 2 },
      ),
    ).rejects.toThrow('after 3 attempts')

    expect(metadataRequests).toBe(3)
  })

  test('tarball retry exhaustion reports attempts', async () => {
    const tarballUrl = `${REGISTRY}/tar-503/-/tar-503-1.0.0.tgz`
    let tarballRequests = 0

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/tar-503`) {
        return new Response(
          JSON.stringify({
            name: 'tar-503',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'tar-503': 'latest' } },
        { registryUrl: REGISTRY, fetchFn, retryCount: 2 },
      ),
    ).rejects.toThrow('after 3 attempts')

    expect(tarballRequests).toBe(3)
  })

  test('default retryCount retries metadata up to 6 attempts', async () => {
    const tarballUrl = `${REGISTRY}/default-meta/-/default-meta-1.0.0.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"default-meta","version":"1.0.0"}' }]))

    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/default-meta`) {
        metadataRequests += 1
        if (metadataRequests <= 5) {
          return new Response('temporary failure', { status: 503, statusText: 'Service Unavailable' })
        }
        return new Response(
          JSON.stringify({
            name: 'default-meta',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) return new Response(toStrict(tarball), { status: 200 })
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      { dependencies: { 'default-meta': 'latest' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(metadataRequests).toBe(6)
    expect(result.lockfile.packages['default-meta@1.0.0']).toBeDefined()
  })

  test('default retryCount retries tarball up to 6 attempts', async () => {
    const tarballUrl = `${REGISTRY}/default-tar/-/default-tar-1.0.0.tgz`
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"default-tar","version":"1.0.0"}' }]))

    let tarballRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/default-tar`) {
        return new Response(
          JSON.stringify({
            name: 'default-tar',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        if (tarballRequests <= 5) {
          return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
        }
        return new Response(toStrict(tarball), { status: 200 })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      { dependencies: { 'default-tar': 'latest' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(tarballRequests).toBe(6)
    expect(result.lockfile.packages['default-tar@1.0.0']).toBeDefined()
  })

  test('default retryCount metadata exhaustion reports after 6 attempts', async () => {
    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/default-meta-always-503`) {
        metadataRequests += 1
        return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'default-meta-always-503': 'latest' } },
        { registryUrl: REGISTRY, fetchFn },
      ),
    ).rejects.toThrow('after 6 attempts')

    expect(metadataRequests).toBe(6)
  })

  test('default retryCount tarball exhaustion reports after 6 attempts', async () => {
    const tarballUrl = `${REGISTRY}/default-tar-always-502/-/default-tar-always-502-1.0.0.tgz`
    let tarballRequests = 0

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === `${REGISTRY}/default-tar-always-502`) {
        return new Response(
          JSON.stringify({
            name: 'default-tar-always-502',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: tarballUrl } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === tarballUrl) {
        tarballRequests += 1
        return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        { dependencies: { 'default-tar-always-502': 'latest' } },
        { registryUrl: REGISTRY, fetchFn },
      ),
    ).rejects.toThrow('after 6 attempts')

    expect(tarballRequests).toBe(6)
  })
})
