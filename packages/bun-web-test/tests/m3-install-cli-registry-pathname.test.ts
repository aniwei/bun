/**
 * 真实目录门禁适配 — bun-install-pathname-trailing-slash.test.ts
 *
 * 覆盖点：
 * 1. custom registry 带 prefixed route + 尾斜杠时，请求路径不出现双斜杠
 * 2. custom registry 带多个尾斜杠时，仍不出现双斜杠
 * 3. scoped package 在 prefixed route 下保持 encodeURIComponent 语义
 */
import { describe, expect, test } from 'vitest'
import { installFromManifest } from '../../../packages/bun-web-installer/src'

describe('registry pathname trailing slash (web installer port)', () => {
  test('single trailing slash on prefixed route does not generate double slash', async () => {
    const requested: string[] = []

    await expect(
      installFromManifest(
        {
          dependencies: {
            react: 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test/prefixed-route/',
          fetchFn: async (input: string | URL) => {
            const url = String(input)
            requested.push(url)
            return new Response('not found', { status: 404, statusText: 'Not Found' })
          },
        },
      ),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')

    expect(requested).toEqual(['https://registry.example.test/prefixed-route/react'])
  })

  test('multiple trailing slashes are normalized and still avoid double slash', async () => {
    const requested: string[] = []

    await expect(
      installFromManifest(
        {
          dependencies: {
            react: 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test/prefixed-route///',
          fetchFn: async (input: string | URL) => {
            const url = String(input)
            requested.push(url)
            return new Response('not found', { status: 404, statusText: 'Not Found' })
          },
        },
      ),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')

    expect(requested).toEqual(['https://registry.example.test/prefixed-route/react'])
  })

  test('scoped package stays encoded under prefixed route', async () => {
    const requested: string[] = []

    await expect(
      installFromManifest(
        {
          dependencies: {
            '@scope/pkg': 'latest',
          },
        },
        {
          registryUrl: 'https://registry.example.test/prefixed-route/',
          fetchFn: async (input: string | URL) => {
            const url = String(input)
            requested.push(url)
            return new Response('not found', { status: 404, statusText: 'Not Found' })
          },
        },
      ),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')

    expect(requested).toEqual(['https://registry.example.test/prefixed-route/%40scope%2Fpkg'])
  })
})
