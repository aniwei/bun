/**
 * 真实目录门禁适配 — overrides.test.ts
 *
 * 映射来源：test/cli/install/overrides.test.ts
 * 原始用例：overrides affect own packages、overrides affect all dependencies、
 *   overrides being set later、overrides reset when removed、multiple overrides
 *
 * 本文件验证 @mars/web-installer installFromManifest() 的 overrides 字段语义：
 *   1. overrides 替换根依赖版本
 *   2. overrides 影响所有 transitive 依赖
 *   3. 无 overrides 时解析原始版本
 *   4. 多个 overrides 同时生效
 *   5. overrides 被移除后恢复原始版本
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

// ─── Per-package tarball builders ───────────────────────────────────────────

async function makePkg(name: string, version: string, deps: Record<string, string> = {}) {
  const pkgJson = JSON.stringify({ name, version, dependencies: Object.keys(deps).length ? deps : undefined })
  const tarball = await gzip(createTar([{ path: 'package/package.json', data: pkgJson }]))
  const integrity = await toSRI(tarball)
  const url = `${REGISTRY}${encodeURIComponent(name)}/-/${name.replace('@', '').replace('/', '-')}-${version}.tgz`
  return { name, version, tarball, integrity, url, deps }
}

type PkgInfo = Awaited<ReturnType<typeof makePkg>>

function buildRegistry(pkgs: PkgInfo[]) {
  const metadataMap: Record<string, unknown> = {}
  const tarballMap: Record<string, Uint8Array> = {}

  for (const pkg of pkgs) {
    const metaUrl = `${REGISTRY}${encodeURIComponent(pkg.name)}`
    const existing = metadataMap[metaUrl] as any
    if (existing) {
      existing.versions[pkg.version] = {
        dist: { tarball: pkg.url, integrity: pkg.integrity },
        dependencies: pkg.deps,
      }
      existing['dist-tags'].latest = pkg.version
    } else {
      metadataMap[metaUrl] = {
        name: pkg.name,
        'dist-tags': { latest: pkg.version },
        versions: {
          [pkg.version]: {
            dist: { tarball: pkg.url, integrity: pkg.integrity },
            dependencies: pkg.deps,
          },
        },
      }
    }
    tarballMap[pkg.url] = pkg.tarball
  }

  return { metadataMap, tarballMap }
}

describe('overrides (web installer port of test/cli/install/overrides.test.ts)', () => {
  // Maps to: "overrides affect your own packages"
  test('overrides replace root dependency version spec', async () => {
    const lodash400 = await makePkg('lodash', '4.0.0')
    const lodash417 = await makePkg('lodash', '4.17.0')

    const { metadataMap, tarballMap } = buildRegistry([lodash400, lodash417])
    // Expose both versions under the same metadata entry
    const metaUrl = `${REGISTRY}lodash`
    ;(metadataMap[metaUrl] as any).versions['4.0.0'] = {
      dist: { tarball: lodash400.url, integrity: lodash400.integrity },
    }
    ;(metadataMap[metaUrl] as any).versions['4.17.0'] = {
      dist: { tarball: lodash417.url, integrity: lodash417.integrity },
    }
    ;(metadataMap[metaUrl] as any)['dist-tags'].latest = '4.17.0'
    tarballMap[lodash400.url] = lodash400.tarball

    // Without override: resolves latest (4.17.0)
    const withoutOverride = await installFromManifest(
      { dependencies: { lodash: 'latest' } },
      { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadataMap, tarballMap) },
    )
    expect(withoutOverride.resolvedRootDependencies.lodash).toBe('4.17.0')

    // With override: resolves 4.0.0 regardless of spec
    const withOverride = await installFromManifest(
      { dependencies: { lodash: 'latest' }, overrides: { lodash: '4.0.0' } },
      { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadataMap, tarballMap) },
    )
    expect(withOverride.resolvedRootDependencies.lodash).toBe('4.0.0')
  })

  // Maps to: "overrides affects all dependencies" — transitive dep is overridden
  test('overrides affect transitive dependency version', async () => {
    const bytes100 = await makePkg('bytes', '1.0.0')
    const bytes300 = await makePkg('bytes', '3.0.0')
    const express = await makePkg('express', '4.18.2', { bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([bytes100, bytes300, express])
    // Register both bytes versions under same metadata entry
    const bytesMetaUrl = `${REGISTRY}bytes`
    ;(metadataMap[bytesMetaUrl] as any).versions['1.0.0'] = {
      dist: { tarball: bytes100.url, integrity: bytes100.integrity },
    }
    ;(metadataMap[bytesMetaUrl] as any).versions['3.0.0'] = {
      dist: { tarball: bytes300.url, integrity: bytes300.integrity },
    }
    ;(metadataMap[bytesMetaUrl] as any)['dist-tags'].latest = '3.0.0'
    tarballMap[bytes100.url] = bytes100.tarball

    // Without override: express resolves bytes@3.0.0 (its declared transitive dep)
    const withoutOverride = await installFromManifest(
      { dependencies: { express: '4.18.2' } },
      { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadataMap, tarballMap) },
    )
    expect(withoutOverride.lockfile.packages['bytes@3.0.0']).toBeDefined()
    expect(withoutOverride.lockfile.packages['bytes@1.0.0']).toBeUndefined()

    // With override: bytes forced to 1.0.0 even though express declared 3.0.0
    const withOverride = await installFromManifest(
      { dependencies: { express: '4.18.2' }, overrides: { bytes: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadataMap, tarballMap) },
    )
    expect(withOverride.lockfile.packages['bytes@1.0.0']).toBeDefined()
    expect(withOverride.lockfile.packages['bytes@3.0.0']).toBeUndefined()
  })

  // Maps to: "overrides being set later affects all dependencies"
  test('adding overrides on reinstall changes resolved transitive versions', async () => {
    const bytes100 = await makePkg('bytes', '1.0.0')
    const bytes300 = await makePkg('bytes', '3.0.0')
    const express = await makePkg('express', '4.18.2', { bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([bytes100, bytes300, express])
    const bytesMetaUrl = `${REGISTRY}bytes`
    ;(metadataMap[bytesMetaUrl] as any).versions['1.0.0'] = {
      dist: { tarball: bytes100.url, integrity: bytes100.integrity },
    }
    ;(metadataMap[bytesMetaUrl] as any)['dist-tags'].latest = '3.0.0'
    tarballMap[bytes100.url] = bytes100.tarball

    const fetchFn = makeRegistryFetch(metadataMap, tarballMap)

    // First install without override
    const first = await installFromManifest(
      { dependencies: { express: '4.18.2' } },
      { registryUrl: REGISTRY, fetchFn },
    )
    expect(first.lockfile.packages['bytes@3.0.0']).toBeDefined()

    // Reinstall with override added (simulates editing package.json overrides + bun install)
    const second = await installFromManifest(
      { dependencies: { express: '4.18.2' }, overrides: { bytes: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )
    expect(second.lockfile.packages['bytes@1.0.0']).toBeDefined()
    expect(second.lockfile.packages['bytes@3.0.0']).toBeUndefined()
  })

  // Maps to: "overrides reset when removed"
  test('removing overrides restores original transitive version on reinstall', async () => {
    const bytes100 = await makePkg('bytes', '1.0.0')
    const bytes300 = await makePkg('bytes', '3.0.0')
    const express = await makePkg('express', '4.18.2', { bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([bytes100, bytes300, express])
    const bytesMetaUrl = `${REGISTRY}bytes`
    ;(metadataMap[bytesMetaUrl] as any).versions['1.0.0'] = {
      dist: { tarball: bytes100.url, integrity: bytes100.integrity },
    }
    ;(metadataMap[bytesMetaUrl] as any)['dist-tags'].latest = '3.0.0'
    tarballMap[bytes100.url] = bytes100.tarball

    const fetchFn = makeRegistryFetch(metadataMap, tarballMap)

    // Install with override
    const withOverride = await installFromManifest(
      { dependencies: { express: '4.18.2' }, overrides: { bytes: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )
    expect(withOverride.lockfile.packages['bytes@1.0.0']).toBeDefined()

    // Reinstall without override (simulates removing overrides key from package.json)
    const withoutOverride = await installFromManifest(
      { dependencies: { express: '4.18.2' } },
      { registryUrl: REGISTRY, fetchFn },
    )
    expect(withoutOverride.lockfile.packages['bytes@3.0.0']).toBeDefined()
    expect(withoutOverride.lockfile.packages['bytes@1.0.0']).toBeUndefined()
  })

  // Maps to: "overrides affects all dependencies" (multiple simultaneous overrides)
  test('multiple overrides applied simultaneously each affect their respective packages', async () => {
    const lodash400 = await makePkg('lodash', '4.0.0')
    const lodash417 = await makePkg('lodash', '4.17.0')
    const bytes100 = await makePkg('bytes', '1.0.0')
    const bytes300 = await makePkg('bytes', '3.0.0')
    // express depends on both lodash and bytes transitively
    const express = await makePkg('express', '4.18.2', { lodash: '4.17.0', bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([lodash400, lodash417, bytes100, bytes300, express])

    // Expose non-latest versions
    const lodashMeta = `${REGISTRY}lodash`
    ;(metadataMap[lodashMeta] as any).versions['4.0.0'] = {
      dist: { tarball: lodash400.url, integrity: lodash400.integrity },
    }
    tarballMap[lodash400.url] = lodash400.tarball

    const bytesMeta = `${REGISTRY}bytes`
    ;(metadataMap[bytesMeta] as any).versions['1.0.0'] = {
      dist: { tarball: bytes100.url, integrity: bytes100.integrity },
    }
    tarballMap[bytes100.url] = bytes100.tarball

    const result = await installFromManifest(
      {
        dependencies: { express: '4.18.2' },
        overrides: { lodash: '4.0.0', bytes: '1.0.0' },
      },
      { registryUrl: REGISTRY, fetchFn: makeRegistryFetch(metadataMap, tarballMap) },
    )

    expect(result.lockfile.packages['lodash@4.0.0']).toBeDefined()
    expect(result.lockfile.packages['lodash@4.17.0']).toBeUndefined()
    expect(result.lockfile.packages['bytes@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['bytes@3.0.0']).toBeUndefined()
  })

  // Maps to: "overrides to npm specifier"
  test('override supports npm alias specifier for transitive dependency', async () => {
    const lodash400 = await makePkg('lodash', '4.0.0')
    const bytes300 = await makePkg('bytes', '3.0.0')
    const express = await makePkg('express', '4.18.2', { bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([lodash400, bytes300, express])
    const requested: string[] = []

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requested.push(url)
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

    const result = await installFromManifest(
      {
        dependencies: { express: '4.18.2' },
        overrides: { bytes: 'npm:lodash@4.0.0' },
      },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.lockfile.packages['bytes@4.0.0']).toBeDefined()
    expect(result.lockfile.packages['bytes@3.0.0']).toBeUndefined()
    expect(requested).toContain(`${REGISTRY}lodash`)
    expect(requested).not.toContain(`${REGISTRY}bytes`)
  })

  test('override supports scoped npm alias specifier for transitive dependency', async () => {
    const scoped = await makePkg('@scope/lodashish', '1.2.3')
    const bytes300 = await makePkg('bytes', '3.0.0')
    const express = await makePkg('express', '4.18.2', { bytes: '3.0.0' })

    const { metadataMap, tarballMap } = buildRegistry([scoped, bytes300, express])
    const requested: string[] = []

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requested.push(url)
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

    const result = await installFromManifest(
      {
        dependencies: { express: '4.18.2' },
        overrides: { bytes: 'npm:@scope/lodashish@1.2.3' },
      },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.lockfile.packages['bytes@1.2.3']).toBeDefined()
    expect(result.lockfile.packages['bytes@3.0.0']).toBeUndefined()
    expect(requested).toContain(`${REGISTRY}${encodeURIComponent('@scope/lodashish')}`)
    expect(requested).not.toContain(`${REGISTRY}bytes`)
  })
})
