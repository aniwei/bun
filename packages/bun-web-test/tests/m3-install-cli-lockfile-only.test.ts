/**
 * 真实目录门禁适配 — lockfile-only.test.ts
 *
 * 覆盖点：
 * 1. lockfile-only 安装只请求 metadata，不请求 tarball
 * 2. 含 transitive 依赖时，仍只请求各层 metadata
 * 3. metadata 5xx 重试恢复后依旧不请求 tarball
 * 4. optionalDependencies 在 lockfile-only 下失败可跳过且不触发 tarball 请求
 */
import { describe, expect, test } from 'vitest'
import { installFromManifest } from '../../../packages/bun-web-installer/src'

const REGISTRY = 'https://registry.example.test'

describe('lockfile-only semantics (web installer port)', () => {
  test('root dependency in lockfile-only fetches only metadata', async () => {
    const requested: string[] = []
    const tarballUrl = `${REGISTRY}/baz/-/baz-1.0.0.tgz`

    const result = await installFromManifest(
      {
        dependencies: {
          baz: 'latest',
        },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/baz`) {
            return new Response(
              JSON.stringify({
                name: 'baz',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': {
                    dist: { tarball: tarballUrl, integrity: 'sha512-demo' },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['baz@1.0.0']).toBeDefined()
    expect(requested).toEqual([`${REGISTRY}/baz`])
  })

  test('transitive dependency in lockfile-only still fetches metadata only', async () => {
    const requested: string[] = []
    const appTarballUrl = `${REGISTRY}/app/-/app-1.0.0.tgz`
    const depTarballUrl = `${REGISTRY}/dep/-/dep-2.0.0.tgz`

    const result = await installFromManifest(
      {
        dependencies: {
          app: 'latest',
        },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/app`) {
            return new Response(
              JSON.stringify({
                name: 'app',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': {
                    dist: { tarball: appTarballUrl },
                    dependencies: {
                      dep: '^2.0.0',
                    },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/dep`) {
            return new Response(
              JSON.stringify({
                name: 'dep',
                'dist-tags': { latest: '2.0.0' },
                versions: {
                  '2.0.0': {
                    dist: { tarball: depTarballUrl },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['app@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['dep@2.0.0']).toBeDefined()
    expect([...requested].sort()).toEqual([`${REGISTRY}/app`, `${REGISTRY}/dep`])
  })

  test('lockfile-only metadata retry succeeds without tarball requests', async () => {
    const requested: string[] = []
    let appRequests = 0

    const result = await installFromManifest(
      {
        dependencies: {
          retrymeta: 'latest',
        },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        retryCount: 2,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/retrymeta`) {
            appRequests += 1
            if (appRequests < 3) {
              return new Response('unavailable', {
                status: 503,
                statusText: 'Service Unavailable',
              })
            }
            return new Response(
              JSON.stringify({
                name: 'retrymeta',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': {
                    dist: { tarball: `${REGISTRY}/retrymeta/-/retrymeta-1.0.0.tgz` },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['retrymeta@1.0.0']).toBeDefined()
    expect(appRequests).toBe(3)
    expect(requested.every(url => !url.endsWith('.tgz'))).toBe(true)
  })

  test('lockfile-only skips failing optional dependency and keeps install successful', async () => {
    const requested: string[] = []

    const result = await installFromManifest(
      {
        dependencies: {
          root: 'latest',
        },
        optionalDependencies: {
          missingopt: 'latest',
        },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/root`) {
            return new Response(
              JSON.stringify({
                name: 'root',
                'dist-tags': { latest: '1.0.0' },
                versions: {
                  '1.0.0': {
                    dist: { tarball: `${REGISTRY}/root/-/root-1.0.0.tgz` },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/missingopt`) {
            return new Response('not found', { status: 404, statusText: 'Not Found' })
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['root@1.0.0']).toBeDefined()
    expect(result.lockfile.packages['missingopt@1.0.0']).toBeUndefined()
    expect([...requested].sort()).toEqual([`${REGISTRY}/missingopt`, `${REGISTRY}/root`])
    expect(requested.every(url => !url.endsWith('.tgz'))).toBe(true)
  })

  test('lockfile-only honors npm alias override and still avoids tarball requests', async () => {
    const requested: string[] = []

    const result = await installFromManifest(
      {
        dependencies: { express: 'latest' },
        overrides: { bytes: 'npm:lodash@4.0.0' },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/express`) {
            return new Response(
              JSON.stringify({
                name: 'express',
                'dist-tags': { latest: '4.18.2' },
                versions: {
                  '4.18.2': {
                    dist: { tarball: `${REGISTRY}/express/-/express-4.18.2.tgz` },
                    dependencies: { bytes: '3.0.0' },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/lodash`) {
            return new Response(
              JSON.stringify({
                name: 'lodash',
                'dist-tags': { latest: '4.0.0' },
                versions: {
                  '4.0.0': {
                    dist: { tarball: `${REGISTRY}/lodash/-/lodash-4.0.0.tgz` },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/bytes`) {
            return new Response('should not fetch original dependency', { status: 500 })
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['express@4.18.2']).toBeDefined()
    expect(result.lockfile.packages['bytes@4.0.0']).toBeDefined()
    expect(result.lockfile.packages['bytes@3.0.0']).toBeUndefined()
    expect(requested).toContain(`${REGISTRY}/lodash`)
    expect(requested).not.toContain(`${REGISTRY}/bytes`)
    expect(requested.every(url => !url.endsWith('.tgz'))).toBe(true)
  })

  test('lockfile-only with frozen lockfile passes when manifest is unchanged', async () => {
    const requested: string[] = []

    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      requested.push(url)

      if (url === `${REGISTRY}/stable`) {
        return new Response(
          JSON.stringify({
            name: 'stable',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: { tarball: `${REGISTRY}/stable/-/stable-1.0.0.tgz` },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response('unexpected request', { status: 500 })
    }

    const first = await installFromManifest(
      { dependencies: { stable: 'latest' } },
      { mode: 'lockfile-only', registryUrl: REGISTRY, fetchFn },
    )

    const second = await installFromManifest(
      { dependencies: { stable: 'latest' } },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn,
        lockfile: first.lockfile,
        frozenLockfile: true,
      },
    )

    expect(second.lockfile.packages['stable@1.0.0']).toBeDefined()
    expect(requested.every(url => !url.endsWith('.tgz'))).toBe(true)
  })

  test('lockfile-only honors scoped npm alias override and still avoids tarball requests', async () => {
    const requested: string[] = []

    const result = await installFromManifest(
      {
        dependencies: { express: 'latest' },
        overrides: { bytes: 'npm:@scope/lodashish@1.2.3' },
      },
      {
        mode: 'lockfile-only',
        registryUrl: REGISTRY,
        fetchFn: async (input: string | URL) => {
          const url = String(input)
          requested.push(url)

          if (url === `${REGISTRY}/express`) {
            return new Response(
              JSON.stringify({
                name: 'express',
                'dist-tags': { latest: '4.18.2' },
                versions: {
                  '4.18.2': {
                    dist: { tarball: `${REGISTRY}/express/-/express-4.18.2.tgz` },
                    dependencies: { bytes: '3.0.0' },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/${encodeURIComponent('@scope/lodashish')}`) {
            return new Response(
              JSON.stringify({
                name: '@scope/lodashish',
                'dist-tags': { latest: '1.2.3' },
                versions: {
                  '1.2.3': {
                    dist: { tarball: `${REGISTRY}/@scope/lodashish/-/lodashish-1.2.3.tgz` },
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }

          if (url === `${REGISTRY}/bytes`) {
            return new Response('should not fetch original dependency', { status: 500 })
          }

          return new Response('unexpected request', { status: 500 })
        },
      },
    )

    expect(result.lockfile.packages['express@4.18.2']).toBeDefined()
    expect(result.lockfile.packages['bytes@1.2.3']).toBeDefined()
    expect(result.lockfile.packages['bytes@3.0.0']).toBeUndefined()
    expect(requested).toContain(`${REGISTRY}/${encodeURIComponent('@scope/lodashish')}`)
    expect(requested).not.toContain(`${REGISTRY}/bytes`)
    expect(requested.every(url => !url.endsWith('.tgz'))).toBe(true)
  })

  test('lockfile-only with frozen lockfile still passes when optional dependency fails', async () => {
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)

      if (url === `${REGISTRY}/root`) {
        return new Response(
          JSON.stringify({
            name: 'root',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: { tarball: `${REGISTRY}/root/-/root-1.0.0.tgz` },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (url === `${REGISTRY}/missing-opt`) {
        return new Response('not found', { status: 404, statusText: 'Not Found' })
      }

      return new Response('unexpected request', { status: 500 })
    }

    const first = await installFromManifest(
      {
        dependencies: { root: 'latest' },
        optionalDependencies: { 'missing-opt': 'latest' },
      },
      { mode: 'lockfile-only', registryUrl: REGISTRY, fetchFn },
    )

    await expect(
      installFromManifest(
        {
          dependencies: { root: 'latest' },
          optionalDependencies: { 'missing-opt': 'latest' },
        },
        {
          mode: 'lockfile-only',
          registryUrl: REGISTRY,
          fetchFn,
          lockfile: first.lockfile,
          frozenLockfile: true,
        },
      ),
    ).resolves.toBeDefined()
  })

  test('lockfile-only with frozen lockfile fails when optional dependency becomes resolvable', async () => {
    let allowOptional = false
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const url = String(input)

      if (url === `${REGISTRY}/root`) {
        return new Response(
          JSON.stringify({
            name: 'root',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: { tarball: `${REGISTRY}/root/-/root-1.0.0.tgz` },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (url === `${REGISTRY}/optional-now`) {
        if (!allowOptional) {
          return new Response('not found', { status: 404, statusText: 'Not Found' })
        }

        return new Response(
          JSON.stringify({
            name: 'optional-now',
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '2.0.0': {
                dist: { tarball: `${REGISTRY}/optional-now/-/optional-now-2.0.0.tgz` },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response('unexpected request', { status: 500 })
    }

    const first = await installFromManifest(
      {
        dependencies: { root: 'latest' },
        optionalDependencies: { 'optional-now': 'latest' },
      },
      { mode: 'lockfile-only', registryUrl: REGISTRY, fetchFn },
    )

    allowOptional = true

    await expect(() =>
      installFromManifest(
        {
          dependencies: { root: 'latest' },
          optionalDependencies: { 'optional-now': 'latest' },
        },
        {
          mode: 'lockfile-only',
          registryUrl: REGISTRY,
          fetchFn,
          lockfile: first.lockfile,
          frozenLockfile: true,
        },
      ),
    ).rejects.toThrow('Frozen lockfile mismatch')
  })
})
