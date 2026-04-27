/**
 * 真实目录门禁适配 — semver range 解析 + registry resolveVersion + install 端到端
 *
 * 映射来源：test/cli/install/semver.test.ts (Bun.semver.order / Bun.semver.satisfies)
 * 补充覆盖：M3-1 registry.ts resolveVersion 语义 + M3-6 range 端到端安装
 *
 * 本文件验证:
 *   1. compareVersions: 版本字符串排序 (order 语义映射)
 *   2. satisfiesRange: 版本范围判断 (satisfies 语义映射)
 *   3. maxSatisfying: 从候选列表选最高满足版本
 *   4. resolveVersion: dist-tag / exact / range 三种规格解析
 *   5. installFromManifest: 用 ^/~ 范围规格安装包 (端到端)
 */
import { describe, expect, test } from 'vitest'
import { compareVersions, satisfiesRange, maxSatisfying } from '../../../packages/bun-web-installer/src'
import { resolveVersion } from '../../../packages/bun-web-installer/src/registry'
import type { NpmPackageMetadata } from '../../../packages/bun-web-installer/src'
import { installFromManifest } from '../../../packages/bun-web-installer/src'

// ─── Tar helpers (standard boilerplate) ─────────────────────────────────────

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

const REGISTRY = 'https://registry.example.test/'

async function makePackage(name: string, version: string, deps: Record<string, string> = {}) {
  const pkgJson = JSON.stringify({
    name,
    version,
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
  })
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMetadata(
  name: string,
  versions: string[],
  distTags: Record<string, string> = {},
): NpmPackageMetadata {
  const latestTag = distTags.latest ?? versions[versions.length - 1]
  return {
    name,
    'dist-tags': { latest: latestTag, ...distTags },
    versions: Object.fromEntries(versions.map(v => [v, {}])),
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('semver — compareVersions (映射 Bun.semver.order comparisons)', () => {
  // 映射 semver.test.ts > describe("Bun.semver.order()") > test("comparisons")
  test('standard version ordering follows semver spec', () => {
    const ordered: Array<[string, string]> = [
      ['0.0.0', '0.0.0-foo'], // release > prerelease
      ['0.0.1', '0.0.0'],
      ['1.0.0', '0.9.9'],
      ['0.10.0', '0.9.0'],
      ['2.0.0', '1.2.3'],
      ['1.2.3', '1.2.3-asdf'],
      ['1.2.3', '1.2.3-4'],
      ['1.2.3-5', '1.2.3-4'],
      ['1.2.3-a.10', '1.2.3-a.5'],   // numeric identifier compare
      ['1.2.3-a.b', '1.2.3-a.5'],    // alphanumeric > numeric
      ['1.2.3-a.b', '1.2.3-a'],      // more identifiers > fewer
    ]
    for (const [greater, lesser] of ordered) {
      expect(compareVersions(greater, lesser), `${greater} > ${lesser}`).toBe(1)
      expect(compareVersions(lesser, greater), `${lesser} < ${greater}`).toBe(-1)
      expect(compareVersions(greater, greater), `${greater} === ${greater}`).toBe(0)
    }
  })

  // 映射 semver.test.ts > test("equality")
  test('v-prefix and build metadata are ignored in comparison', () => {
    const equal: Array<[string, string]> = [
      ['1.2.3', 'v1.2.3'],
      ['1.2.3', '1.2.3'],
      ['1.2.3-beta', '1.2.3-beta'],
      ['1.2.3+build', '1.2.3+otherbuild'], // build metadata ignored
      ['1.2.3-beta+build', '1.2.3-beta+otherbuild'],
      ['1.1.1-next.0', '1.1.1-next.0'],
    ]
    for (const [a, b] of equal) {
      expect(compareVersions(a, b), `${a} == ${b}`).toBe(0)
    }
  })
})

describe('semver — satisfiesRange (映射 Bun.semver.satisfies ranges)', () => {
  // 映射 semver.test.ts > describe("Bun.semver.satisfies()") > test("exact versions")
  test('exact version match', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('4.0.0', '4.0.0')).toBe(true)
    expect(satisfiesRange('5.0.0-beta.1', '5.0.0-beta.1')).toBe(true)
    expect(satisfiesRange('5.0.0-beta.1', '5.0.0-beta.2')).toBe(false)
    expect(satisfiesRange('5.0.0', '5.0.0-beta.1')).toBe(false) // release != prerelease
  })

  // 映射 semver.test.ts > test("ranges") — tilde
  test('tilde ranges (~) match patch-level within minor', () => {
    expect(satisfiesRange('1.2.3', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.99', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.0', '~1.2')).toBe(true)
    expect(satisfiesRange('1.2.1', '~1.2')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2')).toBe(false)
    expect(satisfiesRange('1.0.0', '~1')).toBe(true)
    expect(satisfiesRange('1.2.999', '~1')).toBe(true)
    expect(satisfiesRange('2.0.0', '~1')).toBe(false)
    expect(satisfiesRange('0.2.3', '~0.2.3')).toBe(true)
    expect(satisfiesRange('0.3.0', '~0.2.3')).toBe(false)
  })

  // 映射 semver.test.ts > test("ranges") — caret
  test('caret ranges (^) match compatible versions', () => {
    expect(satisfiesRange('1.1.4', '^1.1.4')).toBe(true)
    expect(satisfiesRange('1.2.0', '^1.1.4')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.1.4')).toBe(false)
    expect(satisfiesRange('1.1.3', '^1.1.4')).toBe(false)
    expect(satisfiesRange('0.1.2', '^0.1.2')).toBe(true)
    expect(satisfiesRange('0.1.3', '^0.1.2')).toBe(true)
    expect(satisfiesRange('0.2.0', '^0.1.2')).toBe(false) // minor lock when major=0
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false) // patch lock when major=minor=0
  })

  // 映射 semver.test.ts > test("ranges") — comparison operators + AND
  test('comparison operators and AND ranges', () => {
    expect(satisfiesRange('3.5.0', '>=3')).toBe(true)
    expect(satisfiesRange('2.9.9', '>=3')).toBe(false)
    expect(satisfiesRange('5.0.0', '<6 >= 5')).toBe(true)
    expect(satisfiesRange('4.0.0', '<6 >= 5')).toBe(false)
    expect(satisfiesRange('6.0.0', '<6 >= 5')).toBe(false)
    expect(satisfiesRange('1.0.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('1.9.9', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
  })

  // 映射 semver.test.ts > test("ranges") — OR
  test('OR ranges (||)', () => {
    expect(satisfiesRange('1.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
    expect(satisfiesRange('0.9.0', '^1.0.0 || ^2.0.0')).toBe(false)
  })
})

describe('semver — maxSatisfying (从候选列表选最高满足版本)', () => {
  test('selects highest matching version for caret range', () => {
    const candidates = ['1.0.0', '1.1.0', '1.2.0', '2.0.0']
    expect(maxSatisfying(candidates, '^1.0.0')).toBe('1.2.0')
  })

  test('selects highest matching version for tilde range', () => {
    const candidates = ['1.2.0', '1.2.1', '1.3.0', '2.0.0']
    expect(maxSatisfying(candidates, '~1.2')).toBe('1.2.1')
  })

  test('returns null when no version satisfies the range', () => {
    expect(maxSatisfying(['1.0.0', '1.1.0'], '^2.0.0')).toBeNull()
  })

  test('excludes prereleases when range has no prerelease tag', () => {
    const candidates = ['1.0.0', '1.1.0', '1.2.0-beta.1']
    // 1.2.0-beta.1 is excluded because range has no prerelease
    expect(maxSatisfying(candidates, '^1.0.0')).toBe('1.1.0')
  })

  test('includes prereleases when range has a prerelease tag', () => {
    const candidates = ['1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0']
    expect(maxSatisfying(candidates, '>=1.0.0-alpha.1')).toBe('1.0.0')
  })
})

describe('resolveVersion — dist-tag / exact / range (映射 M3-1 registry 语义)', () => {
  test('resolves dist-tag "latest" when spec is latest', () => {
    const meta = makeMetadata('pkg', ['1.0.0', '2.0.0'], { latest: '2.0.0' })
    expect(resolveVersion(meta, 'latest')).toBe('2.0.0')
  })

  test('resolves custom dist-tag', () => {
    const meta = makeMetadata('pkg', ['1.0.0', '2.0.0-beta.1'], { latest: '1.0.0', next: '2.0.0-beta.1' })
    expect(resolveVersion(meta, 'next')).toBe('2.0.0-beta.1')
  })

  test('resolves exact version spec', () => {
    const meta = makeMetadata('pkg', ['1.0.0', '1.1.0', '2.0.0'])
    expect(resolveVersion(meta, '1.1.0')).toBe('1.1.0')
  })

  test('resolves semver caret range to highest compatible version', () => {
    const meta = makeMetadata('lodash', ['4.10.0', '4.17.21', '5.0.0'])
    expect(resolveVersion(meta, '^4.10.0')).toBe('4.17.21')
  })

  test('resolves semver tilde range', () => {
    const meta = makeMetadata('react', ['16.0.0', '16.8.0', '17.0.0'])
    expect(resolveVersion(meta, '~16.8')).toBe('16.8.0')
  })

  test('throws when no matching version exists', () => {
    const meta = makeMetadata('pkg', ['1.0.0', '1.1.0'])
    expect(() => resolveVersion(meta, '^2.0.0')).toThrow(/No version matching/)
  })
})

describe('installFromManifest — semver range端到端 (映射 M3-6 范围解析安装)', () => {
  // 验证安装器能用 ^ 范围从多版本中选出最高兼容版本并安装
  test('installs package by caret range, resolves to highest compatible version', async () => {
    const v100 = await makePackage('semver-dep', '1.0.0')
    const v110 = await makePackage('semver-dep', '1.1.0')
    const v200 = await makePackage('semver-dep', '2.0.0')

    const metaUrl = `${REGISTRY}${encodeURIComponent('semver-dep')}`
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === metaUrl) {
        return new Response(
          JSON.stringify({
            name: 'semver-dep',
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '1.0.0': { dist: { tarball: v100.url, integrity: v100.integrity } },
              '1.1.0': { dist: { tarball: v110.url, integrity: v110.integrity } },
              '2.0.0': { dist: { tarball: v200.url, integrity: v200.integrity } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // serve tarballs
      const tarballMap: Record<string, Uint8Array> = {
        [v100.url]: v100.tarball,
        [v110.url]: v110.tarball,
        [v200.url]: v200.tarball,
      }
      if (url in tarballMap) return new Response(toStrict(tarballMap[url]), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    // Request ^1.0.0 — should resolve to 1.1.0 (highest in ^1.x.x), NOT 2.0.0
    const result = await installFromManifest(
      { dependencies: { 'semver-dep': '^1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.resolvedRootDependencies['semver-dep']).toBe('1.1.0')
    expect(result.lockfile.packages['semver-dep@1.1.0']).toBeDefined()
    expect(result.lockfile.packages['semver-dep@2.0.0']).toBeUndefined()
  })

  // 验证 ~ 范围只选择 patch 级别的最高版本
  test('installs package by tilde range, resolves to highest patch-level version', async () => {
    const v120 = await makePackage('tilde-dep', '1.2.0')
    const v121 = await makePackage('tilde-dep', '1.2.1')
    const v130 = await makePackage('tilde-dep', '1.3.0')

    const metaUrl = `${REGISTRY}${encodeURIComponent('tilde-dep')}`
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === metaUrl) {
        return new Response(
          JSON.stringify({
            name: 'tilde-dep',
            'dist-tags': { latest: '1.3.0' },
            versions: {
              '1.2.0': { dist: { tarball: v120.url, integrity: v120.integrity } },
              '1.2.1': { dist: { tarball: v121.url, integrity: v121.integrity } },
              '1.3.0': { dist: { tarball: v130.url, integrity: v130.integrity } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const tarballMap: Record<string, Uint8Array> = {
        [v120.url]: v120.tarball,
        [v121.url]: v121.tarball,
        [v130.url]: v130.tarball,
      }
      if (url in tarballMap) return new Response(toStrict(tarballMap[url]), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    // Request ~1.2 — should resolve to 1.2.1, NOT 1.3.0
    const result = await installFromManifest(
      { dependencies: { 'tilde-dep': '~1.2' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    expect(result.resolvedRootDependencies['tilde-dep']).toBe('1.2.1')
    expect(result.lockfile.packages['tilde-dep@1.2.1']).toBeDefined()
    expect(result.lockfile.packages['tilde-dep@1.3.0']).toBeUndefined()
  })

  // 验证 transitive 依赖也支持范围规格
  test('resolves transitive dependency ranges correctly', async () => {
    const dep200 = await makePackage('shared-dep', '2.0.0')
    const dep210 = await makePackage('shared-dep', '2.1.0')
    const root = await makePackage('root-pkg', '1.0.0', { 'shared-dep': '^2.0.0' })

    const metaUrlShared = `${REGISTRY}${encodeURIComponent('shared-dep')}`
    const metaUrlRoot = `${REGISTRY}${encodeURIComponent('root-pkg')}`
    const tarballMap: Record<string, Uint8Array> = {
      [dep200.url]: dep200.tarball,
      [dep210.url]: dep210.tarball,
      [root.url]: root.tarball,
    }
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === metaUrlShared) {
        return new Response(
          JSON.stringify({
            name: 'shared-dep',
            'dist-tags': { latest: '2.1.0' },
            versions: {
              '2.0.0': { dist: { tarball: dep200.url, integrity: dep200.integrity } },
              '2.1.0': { dist: { tarball: dep210.url, integrity: dep210.integrity } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === metaUrlRoot) {
        return new Response(JSON.stringify({
          name: 'root-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              dist: { tarball: root.url, integrity: root.integrity },
              dependencies: { 'shared-dep': '^2.0.0' },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url in tarballMap) return new Response(toStrict(tarballMap[url]), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const result = await installFromManifest(
      { dependencies: { 'root-pkg': '1.0.0' } },
      { registryUrl: REGISTRY, fetchFn },
    )

    // root-pkg 1.0.0 has dep on ^2.0.0 → should pick 2.1.0
    expect(result.resolvedRootDependencies['root-pkg']).toBe('1.0.0')
    // transitive dep resolved via lockfile
    expect(result.lockfile.packages['shared-dep@2.1.0']).toBeDefined()
    expect(result.lockfile.packages['shared-dep@2.0.0']).toBeUndefined()
  })
})
