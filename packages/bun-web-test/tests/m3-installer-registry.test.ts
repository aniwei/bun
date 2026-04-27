import { describe, expect, test } from 'vitest'

import {
  fetchPackageMetadata,
  resolveVersion,
} from '../../../packages/bun-web-installer/src/registry'

describe('bun-web M3 installer registry metadata', () => {
  test('fetchPackageMetadata parses valid metadata payload', async () => {
    let requestedUrl = ''

    const metadata = await fetchPackageMetadata('@scope/demo', {
      registryUrl: 'https://registry.example.com/',
      fetchFn: async (input) => {
        requestedUrl = String(input)
        return new Response(
          JSON.stringify({
            name: '@scope/demo',
            'dist-tags': { latest: '1.2.3' },
            versions: {
              '1.2.3': { name: '@scope/demo', version: '1.2.3' },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    })

    expect(requestedUrl).toBe('https://registry.example.com/%40scope%2Fdemo')
    expect(metadata.name).toBe('@scope/demo')
    expect(resolveVersion(metadata)).toBe('1.2.3')
  })

  test('fetchPackageMetadata throws on non-ok response', async () => {
    await expect(
      fetchPackageMetadata('left-pad', {
        fetchFn: async () => new Response('not found', { status: 404, statusText: 'Not Found' }),
      }),
    ).rejects.toThrow('Failed to fetch package metadata: 404 Not Found')
  })

  test('fetchPackageMetadata validates payload shape', async () => {
    await expect(
      fetchPackageMetadata('left-pad', {
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              name: 'left-pad',
              versions: {},
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow('Invalid package metadata: missing dist-tags')
  })

  test('resolveVersion throws when dist-tag is missing', () => {
    expect(() =>
      resolveVersion(
        {
          name: 'left-pad',
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': {} },
        },
        'beta',
      ),
    ).toThrow("dist-tag 'beta' not found")
  })
})
