/**
 * 真实目录门禁适配 — bun-lock.test.ts
 *
 * 映射来源：test/cli/install/bun-lock.test.ts
 * 原始用例：plaintext lockfile write、lockfile sorted、lockfile stable、
 *   lockfile captures transitive、lockfile incremental add、frozen-lockfile check
 *
 * 本文件验证 @mars/web-installer lockfile.ts 的序列化与完整性语义：
 *   1. installFromManifest 首次安装后产出 lockfile
 *   2. lockfile packages 键名按字母序排列（normalizeLockfile）
 *   3. lockfile 对同一 manifest 重复安装产出完全相同 JSON（幂等）
 *   4. lockfile 包含所有 transitive 依赖，不只根依赖
 *   5. lockfile-only 模式更新 lockfile 但不下载任何 tarball
 *   6. 写入后可通过 readLockfile 完整反序列化
 *   7. 增量 upsert：基于已有 lockfile 再安装新包，旧包保留
 */
import { describe, expect, test } from 'vitest'
import {
  installFromManifest,
  readLockfile,
  writeLockfile,
  upsertLockfilePackage,
  createEmptyLockfile,
} from '../../../packages/bun-web-installer/src'

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
  for (const b of blocks) { out.set(b, offset); offset += b.length }
  return out
}

function toStrict(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength); out.set(input); return out
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

// ─── Registry helpers ────────────────────────────────────────────────────────

const REGISTRY = 'https://registry.example.test/'

async function makePackage(name: string, version: string, deps: Record<string, string> = {}) {
  const pkgJson = JSON.stringify({ name, version, ...(Object.keys(deps).length ? { dependencies: deps } : {}) })
  const tarball = await gzip(createTar([{ path: 'package/package.json', data: pkgJson }]))
  const integrity = await toSRI(tarball)
  const url = `${REGISTRY}${encodeURIComponent(name)}/-/${name.replace('@', '').replace('/', '-')}-${version}.tgz`
  return { name, version, tarball, integrity, url, deps }
}

type PkgInfo = Awaited<ReturnType<typeof makePackage>>

function buildRegistryFetch(pkgs: PkgInfo[]) {
  const metadataMap: Record<string, unknown> = {}
  const tarballMap: Record<string, Uint8Array> = {}

  for (const pkg of pkgs) {
    const metaUrl = `${REGISTRY}${encodeURIComponent(pkg.name)}`
    const existing = metadataMap[metaUrl] as any
    const versionEntry = {
      dist: { tarball: pkg.url, integrity: pkg.integrity },
      ...(Object.keys(pkg.deps).length ? { dependencies: pkg.deps } : {}),
    }
    if (existing) {
      existing.versions[pkg.version] = versionEntry
      existing['dist-tags'].latest = pkg.version
    } else {
      metadataMap[metaUrl] = {
        name: pkg.name,
        'dist-tags': { latest: pkg.version },
        versions: { [pkg.version]: versionEntry },
      }
    }
    tarballMap[pkg.url] = pkg.tarball
  }

  return async (input: string | URL): Promise<Response> => {
    const url = String(input)
    if (url in metadataMap) {
      return new Response(JSON.stringify(metadataMap[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url in tarballMap) {
      return new Response(toStrict(tarballMap[url]), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
}

describe('bun-lock (web installer port of test/cli/install/bun-lock.test.ts)', () => {
  // Maps to: "should write plaintext lockfiles" — lockfile created on first install
  test('install produces a lockfile with lockfileVersion and packages', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const fetchFn = buildRegistryFetch([noDeps])

    const result = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.lockfile.lockfileVersion).toBe(1)
    expect(typeof result.lockfile.packages).toBe('object')
    expect(result.lockfile.packages['no-deps@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['no-deps@1.0.0'].name).toBe('no-deps')
    expect(result.lockfile.packages['no-deps@1.0.0'].version).toBe('1.0.0')
  })

  // Maps to: "should not change formatting unexpectedly" — lockfile keys sorted
  test('lockfile package keys are sorted alphabetically (normalizeLockfile)', async () => {
    const pkgZ = await makePackage('zzz-pkg', '1.0.0')
    const pkgA = await makePackage('aaa-pkg', '1.0.0')
    const pkgM = await makePackage('mmm-pkg', '1.0.0')
    const fetchFn = buildRegistryFetch([pkgZ, pkgA, pkgM])

    const result = await installFromManifest(
      { dependencies: { 'zzz-pkg': '1.0.0', 'aaa-pkg': '1.0.0', 'mmm-pkg': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    const keys = Object.keys(result.lockfile.packages)
    expect(keys).toEqual([...keys].sort())
  })

  // Maps to: "should be the default save format" (idempotent serialize/deserialize cycle)
  test('lockfile round-trips through writeLockfile and readLockfile stably', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const aDep = await makePackage('a-dep', '1.0.0')
    const fetchFn = buildRegistryFetch([noDeps, aDep])

    const result = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0', 'a-dep': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    // Serialize to JSON
    const serialized = writeLockfile(result.lockfile)
    expect(typeof serialized).toBe('string')

    // Deserialize back
    const roundTripped = readLockfile(serialized)
    expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(result.lockfile))
  })

  // Maps to: "should not change formatting unexpectedly" — stable across reinstalls
  test('installing same manifest twice produces identical lockfile JSON', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const fetchFn = buildRegistryFetch([noDeps])
    const opts = { registryUrl: REGISTRY, fetchFn }

    const result1 = await installFromManifest({ dependencies: { 'no-deps': '1.0.0' } }, opts)
    const result2 = await installFromManifest({ dependencies: { 'no-deps': '1.0.0' } }, opts)

    expect(JSON.stringify(result1.lockfile)).toBe(JSON.stringify(result2.lockfile))
  })

  // Maps to: "should be the default save format" — lockfile captures transitive deps
  test('lockfile includes all transitive dependencies, not just root packages', async () => {
    const leaf = await makePackage('leaf', '1.0.0')
    const mid = await makePackage('mid', '1.0.0', { leaf: '1.0.0' })
    const fetchFn = buildRegistryFetch([leaf, mid])

    const result = await installFromManifest(
      { dependencies: { mid: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.lockfile.packages['mid@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['leaf@1.0.0']).toBeDefined()
    // Only 'mid' is a root dependency
    expect(result.resolvedRootDependencies.mid).toBe('1.0.0')
    expect(result.resolvedRootDependencies.leaf).toBeUndefined()
  })

  // Maps to: "lockfile-only mode" — no tarballs fetched, lockfile still updated
  test('lockfile-only mode updates lockfile without downloading tarballs', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')

    const fetchedUrls: string[] = []
    const trackingFetch = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      fetchedUrls.push(url)
      return buildRegistryFetch([noDeps])(input)
    }

    const result = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn: trackingFetch, mode: 'lockfile-only' },
    )

    // Lockfile should be populated
    expect(result.lockfile.packages['no-deps@1.0.0']).toBeDefined()

    // No tarball URLs should have been fetched — only metadata
    const tarballFetches = fetchedUrls.filter(u => u.endsWith('.tgz'))
    expect(tarballFetches).toHaveLength(0)
  })

  // Maps to: "adding a package will add to the text lockfile" — incremental upsert
  test('incremental install preserves existing lockfile entries when adding new package', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const aDep = await makePackage('a-dep', '2.0.0')
    const allPkgsFetch = buildRegistryFetch([noDeps, aDep])

    // First install: only no-deps
    const first = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn: allPkgsFetch },
    )
    expect(first.lockfile.packages['no-deps@1.0.0']).toBeDefined()
    expect(first.lockfile.packages['a-dep@2.0.0']).toBeUndefined()

    // Second install: pass first lockfile as base, add a-dep
    const second = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0', 'a-dep': '2.0.0' } },
      { registryUrl: REGISTRY, fetchFn: allPkgsFetch, lockfile: first.lockfile },
    )

    // Both packages present
    expect(second.lockfile.packages['no-deps@1.0.0']).toBeDefined()
    expect(second.lockfile.packages['a-dep@2.0.0']).toBeDefined()
  })

  // Maps to: "should sort overrides before comparing" — overrides key sort
  test('lockfile serializes dependency records with sorted keys', async () => {
    // Package with multiple transitive deps (will be sorted in lockfile entry.dependencies)
    const leaf1 = await makePackage('zzz-leaf', '1.0.0')
    const leaf2 = await makePackage('aaa-leaf', '1.0.0')
    const mid = await makePackage('mid', '1.0.0', { 'zzz-leaf': '1.0.0', 'aaa-leaf': '1.0.0' })
    const fetchFn = buildRegistryFetch([leaf1, leaf2, mid])

    const result = await installFromManifest(
      { dependencies: { mid: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    const midEntry = result.lockfile.packages['mid@1.0.0']
    expect(midEntry).toBeDefined()
    const depKeys = Object.keys(midEntry!.dependencies ?? {})
    expect(depKeys).toEqual([...depKeys].sort())
  })

  // Maps to: "frozen-lockfile check" — unchanged lockfile should pass
  test('frozenLockfile passes when computed lockfile is unchanged', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const fetchFn = buildRegistryFetch([noDeps])

    const first = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    const second = await installFromManifest(
      { dependencies: { 'no-deps': '1.0.0' } },
      {
        registryUrl: REGISTRY,
        fetchFn,
        lockfile: first.lockfile,
        frozenLockfile: true,
      },
    )

    expect(JSON.stringify(second.lockfile)).toBe(JSON.stringify(first.lockfile))
  })

  // Maps to: "frozen-lockfile check" — lockfile changes should fail
  test('frozenLockfile fails when manifest changes would modify lockfile', async () => {
    const bytes100 = await makePackage('bytes', '1.0.0')
    const bytes300 = await makePackage('bytes', '3.0.0')
    const express = await makePackage('express', '4.18.2', { bytes: '3.0.0' })

    const fetchFn = buildRegistryFetch([bytes100, bytes300, express])

    const first = await installFromManifest(
      { dependencies: { express: '4.18.2' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    await expect(() =>
      installFromManifest(
        {
          dependencies: { express: '4.18.2' },
          overrides: { bytes: '1.0.0' },
        },
        {
          registryUrl: REGISTRY,
          fetchFn,
          lockfile: first.lockfile,
          frozenLockfile: true,
        },
      ),
    ).rejects.toThrow('Frozen lockfile mismatch')
  })

  test('frozenLockfile rejects when no existing lockfile is provided', async () => {
    const noDeps = await makePackage('no-deps', '1.0.0')
    const fetchFn = buildRegistryFetch([noDeps])

    await expect(() =>
      installFromManifest(
        { dependencies: { 'no-deps': '1.0.0' } },
        {
          registryUrl: REGISTRY,
          fetchFn,
          frozenLockfile: true,
        },
      ),
    ).rejects.toThrow('Frozen lockfile requires an existing lockfile')
  })

  test('frozenLockfile also fails in lockfile-only mode when lockfile would change', async () => {
    const app100 = await makePackage('app', '1.0.0')
    const app200 = await makePackage('app', '2.0.0')
    const fetchFn = buildRegistryFetch([app100, app200])

    const first = await installFromManifest(
      { dependencies: { app: '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn, mode: 'lockfile-only' },
    )

    await expect(() =>
      installFromManifest(
        { dependencies: { app: '2.0.0' } },
        {
          registryUrl: REGISTRY,
          fetchFn,
          lockfile: first.lockfile,
          frozenLockfile: true,
          mode: 'lockfile-only',
        },
      ),
    ).rejects.toThrow('Frozen lockfile mismatch')
  })
})
