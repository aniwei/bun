/**
 * 真实目录门禁适配 — bun-install-tarball-integrity.test.ts
 *
 * 映射来源：test/cli/install/bun-install-tarball-integrity.test.ts
 * 原始用例：tarball URL integrity、本地 tarball integrity、reinstall 一致性、内容变更失败
 *
 * 本文件验证 @mars/web-installer installFromManifest() 对 tarball 完整性的处理语义：
 *   1. 无预计算 integrity 时照常安装（不强制）
 *   2. 有 integrity 字段时安装成功且 lockfile 记录哈希
 *   3. integrity 不匹配时抛出错误
 *   4. 多次重装 lockfile 完整性字段保持稳定
 *   5. 无 integrity 字段的 lockfile 条目无哈希字段（不虚构）
 */
import { describe, expect, test } from 'vitest'
import { installFromManifest } from '../../../packages/bun-web-installer/src'

// ─── Tar helpers ────────────────────────────────────────────────────────────

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number): void {
  const octal = value.toString(8).padStart(width - 1, '0')
  writeAscii(target, offset, octal)
  target[offset + width - 1] = 0
}

function createTar(entries: Array<{ path: string; data?: string; type?: 'file' | 'directory' }>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const isDir = entry.type === 'directory'
    const content = isDir ? new Uint8Array() : new TextEncoder().encode(entry.data ?? '')
    const header = new Uint8Array(512)
    const normalizedPath = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
    writeAscii(header, 0, normalizedPath)
    writeOctal(header, 100, 8, isDir ? 0o755 : 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, content.length)
    writeOctal(header, 136, 12, 0)
    header[156] = isDir ? '5'.charCodeAt(0) : '0'.charCodeAt(0)
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
  const total = blocks.reduce((sum, item) => sum + item.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

function toStrictUint8Array(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength)
  out.set(input)
  return out
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const compression = new CompressionStream('gzip')
  const writer = compression.writable.getWriter()
  await writer.write(toStrictUint8Array(data))
  await writer.close()
  return new Uint8Array(await new Response(compression.readable).arrayBuffer())
}

async function toSRI(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-512', toStrictUint8Array(data))
  return `sha512-${Buffer.from(digest).toString('base64')}`
}

// ─── Registry fetch helpers ──────────────────────────────────────────────────

function makeRegistryFetch(
  metadataMap: Record<string, unknown>,
  tarballMap: Record<string, Uint8Array>,
) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input)
    if (url in metadataMap) {
      return new Response(JSON.stringify(metadataMap[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url in tarballMap) {
      return new Response(toStrictUint8Array(tarballMap[url]), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
}

const REGISTRY = 'https://registry.example.test/'

describe('bun-install-tarball-integrity (web installer port)', () => {
  // Maps to: "should store integrity hash for tarball URL in text lockfile"
  test('stores integrity hash from dist field into lockfile entry', async () => {
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"0.0.3"}' }]))
    const tarballUrl = `${REGISTRY}baz/-/baz-0.0.3.tgz`
    const integrity = await toSRI(tarball)

    const result = await installFromManifest(
      { dependencies: { baz: '0.0.3' } },
      {
        registryUrl: REGISTRY,
        fetchFn: makeRegistryFetch(
          {
            [`${REGISTRY}baz`]: {
              name: 'baz',
              'dist-tags': { latest: '0.0.3' },
              versions: {
                '0.0.3': { dist: { tarball: tarballUrl, integrity } },
              },
            },
          },
          { [tarballUrl]: tarball },
        ),
      },
    )

    // Maps: "lockContent should match sha512-... integrity hash"
    expect(result.lockfile.packages['baz@0.0.3']?.integrity).toBe(integrity)
    expect(result.lockfile.packages['baz@0.0.3']?.integrity).toMatch(/^sha512-/)
  })

  // Maps to: "should store consistent integrity hash for tarball URL across reinstalls"
  test('integrity hash stable across repeated installs from same tarball', async () => {
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"0.0.3"}' }]))
    const tarballUrl = `${REGISTRY}baz/-/baz-0.0.3.tgz`
    const integrity = await toSRI(tarball)
    const metadata = {
      [`${REGISTRY}baz`]: {
        name: 'baz',
        'dist-tags': { latest: '0.0.3' },
        versions: { '0.0.3': { dist: { tarball: tarballUrl, integrity } } },
      },
    }
    const tarballs = { [tarballUrl]: tarball }
    const opts = { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadata, tarballs) }

    const result1 = await installFromManifest({ dependencies: { baz: '0.0.3' } }, opts)
    const result2 = await installFromManifest({ dependencies: { baz: '0.0.3' } }, opts)

    // Maps: "same integrity hash was computed" after second install from scratch
    expect(result1.lockfile.packages['baz@0.0.3']?.integrity).toBe(
      result2.lockfile.packages['baz@0.0.3']?.integrity,
    )
  })

  // Maps to: "should fail integrity check when tarball URL content changes"
  test('fails install when served tarball content does not match declared integrity', async () => {
    const goodTarball = await gzip(
      createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"0.0.3"}' }]),
    )
    const badTarball = await gzip(
      createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"0.0.5"}' }]),
    )
    const tarballUrl = `${REGISTRY}baz/-/baz-0.0.3.tgz`
    // Registry claims integrity of goodTarball but we serve badTarball
    const integrityOfGood = await toSRI(goodTarball)

    await expect(
      installFromManifest(
        { dependencies: { baz: '0.0.3' } },
        {
          registryUrl: REGISTRY,
          fetchFn: makeRegistryFetch(
            {
              [`${REGISTRY}baz`]: {
                name: 'baz',
                'dist-tags': { latest: '0.0.3' },
                versions: {
                  '0.0.3': { dist: { tarball: tarballUrl, integrity: integrityOfGood } },
                },
              },
            },
            // Deliberately serve badTarball for the URL
            { [tarballUrl]: badTarball },
          ),
        },
      ),
    ).rejects.toThrow(/integrity/i)
  })

  // Maps to: "should store integrity hash for tarball URL in text lockfile" (no-integrity variant)
  test('installs successfully when registry dist field omits integrity', async () => {
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"foo","version":"1.0.0"}' }]))
    const tarballUrl = `${REGISTRY}foo/-/foo-1.0.0.tgz`

    const result = await installFromManifest(
      { dependencies: { foo: '1.0.0' } },
      {
        registryUrl: REGISTRY,
        fetchFn: makeRegistryFetch(
          {
            [`${REGISTRY}foo`]: {
              name: 'foo',
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': { dist: { tarball: tarballUrl } },  // no integrity field
              },
            },
          },
          { [tarballUrl]: tarball },
        ),
      },
    )

    expect(result.lockfile.packages['foo@1.0.0']?.name).toBe('foo')
    // No integrity stored since registry did not provide one
    expect(result.lockfile.packages['foo@1.0.0']?.integrity).toBeUndefined()
  })

  // Maps to: "should store consistent integrity hash for tarball URL across reinstalls" (cache hit variant)
  test('integrity from cache hit matches integrity from fresh download', async () => {
    const tarball = await gzip(
      createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"0.0.3"}' }]),
    )
    const tarballUrl = `${REGISTRY}baz/-/baz-0.0.3.tgz`
    const integrity = await toSRI(tarball)
    const metadata = {
      [`${REGISTRY}baz`]: {
        name: 'baz',
        'dist-tags': { latest: '0.0.3' },
        versions: { '0.0.3': { dist: { tarball: tarballUrl, integrity } } },
      },
    }
    const tarballs = { [tarballUrl]: tarball }

    // Warm-up: install once to populate cache
    const cache = new Map<string, Uint8Array>()
    await installFromManifest(
      { dependencies: { baz: '0.0.3' } },
      {
        registryUrl: REGISTRY,
        fetchFn: makeRegistryFetch(metadata, tarballs),
        tarballCache: {
          getTarball: async (k) => cache.get(k) ?? null,
          setTarball: async (k, v) => { cache.set(k, v) },
        },
      },
    )

    // Second install: served from cache only (no network access needed)
    const fetchTracker: string[] = []
    const trackingFetch = async (input: string | URL): Promise<Response> => {
      fetchTracker.push(String(input))
      return makeRegistryFetch(metadata, tarballs)(input)
    }

    const result2 = await installFromManifest(
      { dependencies: { baz: '0.0.3' } },
      {
        registryUrl: REGISTRY,
        fetchFn: trackingFetch,
        tarballCache: {
          getTarball: async (k) => cache.get(k) ?? null,
          setTarball: async (k, v) => { cache.set(k, v) },
        },
      },
    )

    expect(result2.lockfile.packages['baz@0.0.3']?.integrity).toBe(integrity)
    // Tarball URL must NOT be fetched since it was in cache
    expect(fetchTracker).not.toContain(tarballUrl)
  })
})
