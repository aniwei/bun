import { describe, expect, test } from 'vitest'

import { installFromManifest, writeLockfile } from '../../../packages/bun-web-installer/src'

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

    for (let i = 148; i < 156; i++) {
      header[i] = 0x20
    }

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

type MetadataMap = Record<string, unknown>
type TarballMap = Record<string, Uint8Array>

function createRegistryFetch(metadata: MetadataMap, tarballs: TarballMap) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input)
    if (url in metadata) {
      return new Response(JSON.stringify(metadata[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (url in tarballs) {
      return new Response(toStrictUint8Array(tarballs[url]), { status: 200 })
    }

    return new Response('not found', { status: 404, statusText: 'Not Found' })
  }
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
      const chunk = data.slice(offset, end)
      controller.enqueue(toStrictUint8Array(chunk))
      offset = end
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
    },
  })
}

describe('bun-web M3 installer cli-install replay', () => {
  test('replay: resolves scoped package metadata from encoded registry path', async () => {
    const tarballUrl = 'https://registry.example.test/%40scope/pkg/-/pkg-1.0.0.tgz'
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"@scope/pkg"}' }]))

    const metadataByUrl = {
      'https://registry.example.test/%40scope%2Fpkg': {
        name: '@scope/pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: tarballUrl, integrity: await toSRI(tarball) },
          },
        },
      },
    }

    const result = await installFromManifest(
      {
        dependencies: { '@scope/pkg': 'latest' },
      },
      {
        registryUrl: 'https://registry.example.test/',
        fetchFn: createRegistryFetch(metadataByUrl, { [tarballUrl]: tarball }),
      },
    )

    expect(result.lockfile.packages['@scope/pkg@1.0.0']?.name).toBe('@scope/pkg')
    expect(result.resolvedRootDependencies['@scope/pkg']).toBe('1.0.0')
  })

  test('replay: resolves non-latest dist-tag for root dependency', async () => {
    const url = 'https://registry.example.test/pkg/-/pkg-2.0.0.tgz'
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"pkg","version":"2.0.0"}' }]))

    const metadata = {
      'https://registry.example.test/pkg': {
        name: 'pkg',
        'dist-tags': {
          latest: '1.0.0',
          beta: '2.0.0',
        },
        versions: {
          '1.0.0': {
            dist: { tarball: 'https://registry.example.test/pkg/-/pkg-1.0.0.tgz' },
          },
          '2.0.0': {
            dist: { tarball: url, integrity: await toSRI(tarball) },
          },
        },
      },
    }

    const result = await installFromManifest(
      {
        dependencies: { pkg: 'beta' },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, { [url]: tarball }),
      },
    )

    expect(result.resolvedRootDependencies.pkg).toBe('2.0.0')
    expect(result.lockfile.packages['pkg@2.0.0']?.version).toBe('2.0.0')
  })

  test('replay: bun-install-tarball-integrity mismatch on changed tarball content', async () => {
    const url = 'https://registry.example.test/baz/-/baz-1.0.0.tgz'
    const metadataUrl = 'https://registry.example.test/baz'

    const tarA = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"1.0.0"}' }]))
    const tarB = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"baz","version":"1.0.0","x":1}' }]))
    const integrityA = await toSRI(tarA)

    const metadata = {
      [metadataUrl]: {
        name: 'baz',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: {
              tarball: url,
              integrity: integrityA,
            },
          },
        },
      },
    }

    await installFromManifest(
      {
        dependencies: { baz: 'latest' },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, { [url]: tarA }),
      },
    )

    await expect(() =>
      installFromManifest(
        {
          dependencies: { baz: 'latest' },
        },
        {
          registryUrl: 'https://registry.example.test',
          fetchFn: createRegistryFetch(metadata, { [url]: tarB }),
        },
      ),
    ).rejects.toThrow('Integrity mismatch for sha512')
  })

  test('replay: bun-lock stable text lockfile across reinstall', async () => {
    const fooUrl = 'https://registry.example.test/foo/-/foo-1.0.0.tgz'
    const barUrl = 'https://registry.example.test/bar/-/bar-1.0.0.tgz'

    const fooTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"foo"}' }]))
    const barTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"bar"}' }]))

    const metadata = {
      'https://registry.example.test/foo': {
        name: 'foo',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: fooUrl, integrity: await toSRI(fooTar) },
            dependencies: { bar: '1.0.0' },
          },
        },
      },
      'https://registry.example.test/bar': {
        name: 'bar',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: barUrl, integrity: await toSRI(barTar) },
          },
        },
      },
    }

    const tarballs = {
      [fooUrl]: fooTar,
      [barUrl]: barTar,
    }

    const first = await installFromManifest(
      { dependencies: { foo: 'latest' } },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, tarballs),
      },
    )
    const lock1 = writeLockfile(first.lockfile)

    const second = await installFromManifest(
      { dependencies: { foo: 'latest' } },
      {
        lockfile: first.lockfile,
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, tarballs),
      },
    )
    const lock2 = writeLockfile(second.lockfile)

    expect(lock2).toBe(lock1)
  })

  test('replay: hoist shared transitive dependency to root node_modules', async () => {
    const app1Url = 'https://registry.example.test/app-1/-/app-1-1.0.0.tgz'
    const app2Url = 'https://registry.example.test/app-2/-/app-2-1.0.0.tgz'
    const reactUrl = 'https://registry.example.test/react/-/react-18.2.0.tgz'

    const app1Tar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"app-1"}' }]))
    const app2Tar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"app-2"}' }]))
    const reactTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"react"}' }]))

    const metadata = {
      'https://registry.example.test/app-1': {
        name: 'app-1',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: app1Url, integrity: await toSRI(app1Tar) },
            dependencies: { react: '18.2.0' },
          },
        },
      },
      'https://registry.example.test/app-2': {
        name: 'app-2',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: app2Url, integrity: await toSRI(app2Tar) },
            dependencies: { react: '18.2.0' },
          },
        },
      },
      'https://registry.example.test/react': {
        name: 'react',
        'dist-tags': { latest: '18.2.0' },
        versions: {
          '18.2.0': {
            dist: { tarball: reactUrl, integrity: await toSRI(reactTar) },
          },
        },
      },
    }

    const tarballs = {
      [app1Url]: app1Tar,
      [app2Url]: app2Tar,
      [reactUrl]: reactTar,
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'app-1': 'latest',
          'app-2': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, tarballs),
      },
    )

    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/react',
      packageKey: 'react@18.2.0',
    })

    const reactLinks = result.layoutPlan.links.filter(link => link.dependencyName === 'react')
    expect(reactLinks).toHaveLength(2)
    expect(reactLinks.every(link => link.toInstallPath === '/node_modules/react')).toBe(true)
  })

  test('replay: second install can reuse tarball cache when registry tarball is unavailable', async () => {
    const fooUrl = 'https://registry.example.test/foo/-/foo-1.0.0.tgz'
    const fooTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"foo"}' }]))
    const fooIntegrity = await toSRI(fooTar)

    const metadata = {
      'https://registry.example.test/foo': {
        name: 'foo',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: fooUrl, integrity: fooIntegrity },
          },
        },
      },
    }

    const cacheMap = new Map<string, Uint8Array>()
    const tarballCache = {
      async getTarball(cacheKey: string): Promise<Uint8Array | null> {
        return cacheMap.get(cacheKey) ?? null
      },
      async setTarball(cacheKey: string, tarball: Uint8Array): Promise<void> {
        cacheMap.set(cacheKey, new Uint8Array(tarball))
      },
    }

    await installFromManifest(
      {
        dependencies: { foo: 'latest' },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, { [fooUrl]: fooTar }),
        tarballCache,
      },
    )

    expect(cacheMap.has('foo@1.0.0')).toBe(true)

    const fetchWithoutTarball = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://registry.example.test/foo') {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: { foo: 'latest' },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: fetchWithoutTarball,
        tarballCache,
      },
    )

    expect(result.lockfile.packages['foo@1.0.0']?.resolved).toBe(fooUrl)
  })

  test('replay: lockfile-only does not request tarball urls', async () => {
    const bazMetadataUrl = 'https://registry.example.test/baz'
    const bazTarballUrl = 'https://registry.example.test/baz/-/baz-1.0.0.tgz'

    const requestedUrls: string[] = []
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requestedUrls.push(url)

      if (url === bazMetadataUrl) {
        return new Response(
          JSON.stringify({
            name: 'baz',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: { tarball: bazTarballUrl, integrity: 'sha512-demo' },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: { baz: 'latest' },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
        mode: 'lockfile-only',
      },
    )

    expect(result.lockfile.packages['baz@1.0.0']?.resolved).toBe(bazTarballUrl)
    expect(requestedUrls).toEqual([bazMetadataUrl])
  })

  test('replay: installs successfully from chunked streaming tarball response', async () => {
    const streamPkgUrl = 'https://registry.example.test/stream-pkg/-/stream-pkg-1.0.0.tgz'
    const tar = createTar([
      { path: 'package/package.json', data: '{"name":"stream-pkg","version":"1.0.0"}' },
      { path: 'package/index.js', data: 'module.exports = "ok"' },
      { path: 'package/lib/chunk-a.txt', data: 'a'.repeat(2048) },
      { path: 'package/lib/chunk-b.txt', data: 'b'.repeat(2048) },
      { path: 'package/lib/chunk-c.txt', data: 'c'.repeat(2048) },
    ])
    const tgz = await gzip(tar)

    const metadata = {
      'https://registry.example.test/stream-pkg': {
        name: 'stream-pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: {
              tarball: streamPkgUrl,
              integrity: await toSRI(tgz),
            },
          },
        },
      },
    }

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === streamPkgUrl) {
        return createChunkedResponse(tgz, 97)
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'stream-pkg': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
      },
    )

    expect(result.lockfile.packages['stream-pkg@1.0.0']?.integrity).toBeDefined()
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/stream-pkg',
      packageKey: 'stream-pkg@1.0.0',
    })
  })

  test('replay: installFromManifest uses explicit registryUrl over default registry', async () => {
    const tarballUrl = 'https://custom-registry.example.test/no-deps/-/no-deps-1.0.0.tgz'
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"no-deps"}' }]))

    const requestedUrls: string[] = []
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requestedUrls.push(url)

      if (url === 'https://custom-registry.example.test/no-deps') {
        return new Response(
          JSON.stringify({
            name: 'no-deps',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: { tarball: tarballUrl, integrity: await toSRI(tarball) },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (url === tarballUrl) {
        return new Response(toStrictUint8Array(tarball), { status: 200 })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: { 'no-deps': 'latest' },
      },
      {
        registryUrl: 'https://custom-registry.example.test',
        fetchFn,
      },
    )

    expect(result.lockfile.packages['no-deps@1.0.0']?.resolved).toBe(tarballUrl)
    expect(requestedUrls[0]).toBe('https://custom-registry.example.test/no-deps')
  })

  test('replay: lockfile-only updates lockfile incrementally without tarball fetch', async () => {
    const initial = {
      lockfileVersion: 1 as const,
      packages: {
        'left-pad@1.3.0': {
          name: 'left-pad',
          version: '1.3.0',
          resolved: 'https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz',
          integrity: 'sha512-left-pad',
        },
      },
    }

    const requestedUrls: string[] = []
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requestedUrls.push(url)

      if (url === 'https://registry.example.test/is-number') {
        return new Response(
          JSON.stringify({
            name: 'is-number',
            'dist-tags': { latest: '7.0.0' },
            versions: {
              '7.0.0': {
                dist: {
                  tarball: 'https://registry.example.test/is-number/-/is-number-7.0.0.tgz',
                  integrity: 'sha512-is-number',
                },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'is-number': 'latest',
        },
      },
      {
        lockfile: initial,
        registryUrl: 'https://registry.example.test',
        fetchFn,
        mode: 'lockfile-only',
      },
    )

    expect(result.lockfile.packages['left-pad@1.3.0']?.version).toBe('1.3.0')
    expect(result.lockfile.packages['is-number@7.0.0']?.resolved).toBe(
      'https://registry.example.test/is-number/-/is-number-7.0.0.tgz',
    )
    expect(requestedUrls).toEqual(['https://registry.example.test/is-number'])
  })

  test('replay: retries metadata fetch and succeeds on subsequent attempt', async () => {
    const tarballUrl = 'https://registry.example.test/retry-metadata/-/retry-metadata-1.0.0.tgz'
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"retry-metadata"}' }]))

    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)

      if (url === 'https://registry.example.test/retry-metadata') {
        metadataRequests += 1
        if (metadataRequests === 1) {
          return new Response('temporary failure', { status: 503, statusText: 'Service Unavailable' })
        }

        return new Response(
          JSON.stringify({
            name: 'retry-metadata',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: {
                  tarball: tarballUrl,
                  integrity: await toSRI(tarball),
                },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      if (url === tarballUrl) {
        return new Response(toStrictUint8Array(tarball), { status: 200 })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'retry-metadata': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
        retryCount: 1,
      },
    )

    expect(metadataRequests).toBe(2)
    expect(result.lockfile.packages['retry-metadata@1.0.0']?.resolved).toBe(tarballUrl)
  })

  test('replay: retries tarball download and succeeds on subsequent attempt', async () => {
    const tarballUrl = 'https://registry.example.test/retry-tarball/-/retry-tarball-1.0.0.tgz'
    const tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"retry-tarball"}' }]))
    const metadata = {
      'https://registry.example.test/retry-tarball': {
        name: 'retry-tarball',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: {
              tarball: tarballUrl,
              integrity: await toSRI(tarball),
            },
          },
        },
      },
    }

    let tarballRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)

      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === tarballUrl) {
        tarballRequests += 1
        if (tarballRequests === 1) {
          return new Response('temporary failure', { status: 502, statusText: 'Bad Gateway' })
        }
        return new Response(toStrictUint8Array(tarball), { status: 200 })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'retry-tarball': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
        retryCount: 1,
      },
    )

    expect(tarballRequests).toBe(2)
    expect(result.lockfile.packages['retry-tarball@1.0.0']?.resolved).toBe(tarballUrl)
  })

  test('replay: does not retry metadata on 4xx response', async () => {
    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://registry.example.test/no-such-pkg') {
        metadataRequests += 1
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        {
          dependencies: {
            'no-such-pkg': 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test',
          fetchFn,
          retryCount: 3,
        },
      ),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')

    expect(metadataRequests).toBe(1)
  })

  test('replay: does not retry tarball download on 4xx response', async () => {
    const tarballUrl = 'https://registry.example.test/no-tarball/-/no-tarball-1.0.0.tgz'
    const metadata = {
      'https://registry.example.test/no-tarball': {
        name: 'no-tarball',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: tarballUrl },
          },
        },
      },
    }

    let tarballRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === tarballUrl) {
        tarballRequests += 1
        return new Response('gone', { status: 404, statusText: 'Not Found' })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        {
          dependencies: {
            'no-tarball': 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test',
          fetchFn,
          retryCount: 3,
        },
      ),
    ).rejects.toThrow('Failed to download tarball: 404 Not Found')

    expect(tarballRequests).toBe(1)
  })

  test('replay: reports attempt count when metadata retries are exhausted', async () => {
    let metadataRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://registry.example.test/flaky-pkg') {
        metadataRequests += 1
        return new Response('unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        {
          dependencies: {
            'flaky-pkg': 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test',
          fetchFn,
          retryCount: 1,
        },
      ),
    ).rejects.toThrow('after 2 attempts')

    expect(metadataRequests).toBe(2)
  })

  test('replay: reports attempt count when tarball retries are exhausted', async () => {
    const tarballUrl = 'https://registry.example.test/flaky-tarball/-/flaky-tarball-1.0.0.tgz'
    const metadata = {
      'https://registry.example.test/flaky-tarball': {
        name: 'flaky-tarball',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: tarballUrl },
          },
        },
      },
    }

    let tarballRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === tarballUrl) {
        tarballRequests += 1
        return new Response('unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    await expect(() =>
      installFromManifest(
        {
          dependencies: {
            'flaky-tarball': 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test',
          fetchFn,
          retryCount: 1,
        },
      ),
    ).rejects.toThrow('after 2 attempts')

    expect(tarballRequests).toBe(2)
  })

  test('replay: applies overrides to transitive dependency resolution', async () => {
    const rootTarballUrl = 'https://registry.example.test/root-app/-/root-app-1.0.0.tgz'
    const leftPadV1TarballUrl = 'https://registry.example.test/left-pad/-/left-pad-1.0.0.tgz'
    const leftPadV2TarballUrl = 'https://registry.example.test/left-pad/-/left-pad-2.0.0.tgz'

    const rootTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"root-app","version":"1.0.0"}' }]))
    const leftPadV1Tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"left-pad","version":"1.0.0"}' }]))
    const leftPadV2Tarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"left-pad","version":"2.0.0"}' }]))

    const metadata = {
      'https://registry.example.test/root-app': {
        name: 'root-app',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: rootTarballUrl, integrity: await toSRI(rootTarball) },
            dependencies: {
              'left-pad': '2.0.0',
            },
          },
        },
      },
      'https://registry.example.test/left-pad': {
        name: 'left-pad',
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: leftPadV1TarballUrl, integrity: await toSRI(leftPadV1Tarball) },
          },
          '2.0.0': {
            dist: { tarball: leftPadV2TarballUrl, integrity: await toSRI(leftPadV2Tarball) },
          },
        },
      },
    }

    const result = await installFromManifest(
      {
        dependencies: { 'root-app': 'latest' },
        overrides: {
          'left-pad': '1.0.0',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, {
          [rootTarballUrl]: rootTarball,
          [leftPadV1TarballUrl]: leftPadV1Tarball,
          [leftPadV2TarballUrl]: leftPadV2Tarball,
        }),
      },
    )

    expect(result.lockfile.packages['left-pad@1.0.0']?.version).toBe('1.0.0')
    expect(result.lockfile.packages['left-pad@2.0.0']).toBeUndefined()
  })

  test('replay: installs optionalDependencies when available', async () => {
    const appTarballUrl = 'https://registry.example.test/app-with-optional/-/app-with-optional-1.0.0.tgz'
    const optTarballUrl = 'https://registry.example.test/opt-dep/-/opt-dep-1.0.0.tgz'

    const appTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"app-with-optional","version":"1.0.0"}' }]))
    const optTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"opt-dep","version":"1.0.0"}' }]))

    const metadata = {
      'https://registry.example.test/app-with-optional': {
        name: 'app-with-optional',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: appTarballUrl, integrity: await toSRI(appTarball) },
          },
        },
      },
      'https://registry.example.test/opt-dep': {
        name: 'opt-dep',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: optTarballUrl, integrity: await toSRI(optTarball) },
          },
        },
      },
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'app-with-optional': 'latest',
        },
        optionalDependencies: {
          'opt-dep': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, {
          [appTarballUrl]: appTarball,
          [optTarballUrl]: optTarball,
        }),
      },
    )

    expect(result.lockfile.packages['app-with-optional@1.0.0']?.version).toBe('1.0.0')
    expect(result.lockfile.packages['opt-dep@1.0.0']?.version).toBe('1.0.0')
    expect(result.resolvedRootDependencies['opt-dep']).toBe('1.0.0')
  })

  test('replay: skips failing optionalDependencies without failing install', async () => {
    const appTarballUrl = 'https://registry.example.test/app-optional-fallback/-/app-optional-fallback-1.0.0.tgz'
    const appTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"app-optional-fallback","version":"1.0.0"}' }]))

    const metadata = {
      'https://registry.example.test/app-optional-fallback': {
        name: 'app-optional-fallback',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: appTarballUrl, integrity: await toSRI(appTarball) },
          },
        },
      },
    }

    let missingOptionalRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === appTarballUrl) {
        return new Response(toStrictUint8Array(appTarball), { status: 200 })
      }

      if (url === 'https://registry.example.test/missing-optional') {
        missingOptionalRequests += 1
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'app-optional-fallback': 'latest',
        },
        optionalDependencies: {
          'missing-optional': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
      },
    )

    expect(result.lockfile.packages['app-optional-fallback@1.0.0']?.version).toBe('1.0.0')
    expect(result.lockfile.packages['missing-optional@1.0.0']).toBeUndefined()
    expect(result.resolvedRootDependencies['missing-optional']).toBeUndefined()
    expect(missingOptionalRequests).toBe(1)
  })

  test('replay: skips failing transitive optionalDependencies without layout failure', async () => {
    const appTarballUrl = 'https://registry.example.test/app-with-transitive-optional/-/app-with-transitive-optional-1.0.0.tgz'
    const coreTarballUrl = 'https://registry.example.test/core-dep/-/core-dep-1.0.0.tgz'
    const appTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"app-with-transitive-optional","version":"1.0.0"}' }]))
    const coreTarball = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"core-dep","version":"1.0.0"}' }]))

    const metadata = {
      'https://registry.example.test/app-with-transitive-optional': {
        name: 'app-with-transitive-optional',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: appTarballUrl, integrity: await toSRI(appTarball) },
            dependencies: {
              'core-dep': '1.0.0',
            },
          },
        },
      },
      'https://registry.example.test/core-dep': {
        name: 'core-dep',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            dist: { tarball: coreTarballUrl, integrity: await toSRI(coreTarball) },
            optionalDependencies: {
              'missing-transitive-optional': 'latest',
            },
          },
        },
      },
    }

    let missingOptionalRequests = 0
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url in metadata) {
        return new Response(JSON.stringify(metadata[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === appTarballUrl) {
        return new Response(toStrictUint8Array(appTarball), { status: 200 })
      }

      if (url === coreTarballUrl) {
        return new Response(toStrictUint8Array(coreTarball), { status: 200 })
      }

      if (url === 'https://registry.example.test/missing-transitive-optional') {
        missingOptionalRequests += 1
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }

    const result = await installFromManifest(
      {
        dependencies: {
          'app-with-transitive-optional': 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn,
      },
    )

    expect(result.lockfile.packages['app-with-transitive-optional@1.0.0']?.version).toBe('1.0.0')
    expect(result.lockfile.packages['core-dep@1.0.0']?.version).toBe('1.0.0')
    expect(result.lockfile.packages['core-dep@1.0.0']?.dependencies?.['missing-transitive-optional']).toBeUndefined()
    expect(missingOptionalRequests).toBe(1)
  })
})