import { describe, expect, test } from 'vitest'
import { BunContainer } from '@mars/web-client'
import { installFromManifest } from '../../../packages/bun-web-installer/src'
import {
  createBunWebExampleFiles,
  createBunWebExpressExampleFiles,
  createBunWebFastifyExampleFiles,
  createBunWebHonoExampleFiles,
  createBunWebKoaExampleFiles,
  createBunWebServeRoutesExampleFiles,
  runBunWebExample,
} from '@mars/web-example'

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

function createRegistryFetch(
  metadata: Record<string, unknown>,
  tarballs: Record<string, Uint8Array>,
): (input: string | URL) => Promise<Response> {
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

describe('M8 ecosystem acceptance (Vite + React + TS)', () => {
  test('vite/react/typescript scaffold contract is present', () => {
    const files = createBunWebExampleFiles('eco vite react ts')
    const pkg = JSON.parse(files['/package.json'] as string) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(pkg.scripts.dev).toBe('vite')
    expect(pkg.scripts.build).toBe('vite build')
    expect(pkg.scripts.preview).toBe('vite preview')

    expect(pkg.dependencies.react).toBeDefined()
    expect(pkg.dependencies['react-dom']).toBeDefined()
    expect(pkg.devDependencies.vite).toBeDefined()
    expect(pkg.devDependencies['@vitejs/plugin-react']).toBeDefined()

    expect(files['/index.html']).toContain("/src/main.tsx")
    expect(files['/src/main.tsx']).toContain("import ReactDOM from 'react-dom/client'")
    expect(files['/src/App.tsx']).toContain('Dify 风格示例工作台')
  })

  test('runBunWebExample keeps vite template execution path green', async () => {
    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files: createBunWebExampleFiles('ecosystem acceptance ok'),
      },
    })

    expect(result.entrypoint).toBe('/src/example-run.ts')
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('tsx entrypoint path works in ecosystem flow', async () => {
    const files = createBunWebExampleFiles('tsx placeholder')
    files['/src/example-run.tsx'] = "console.log('tsx ecosystem acceptance ok')"

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/example-run.tsx',
    })

    expect(result.entrypoint).toBe('/src/example-run.tsx')
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('tsx ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('shell-style command echo is available in container spawn', async () => {
    const container = await BunContainer.boot({ workerType: 'shared' })

    const proc = await container.spawn({ argv: ['echo', 'shell ecosystem acceptance ok'] })
    const output = await new Response(proc.output).text()
    const exitCode = await proc.waitForExit()

    expect(output).toBe('shell ecosystem acceptance ok\n')
    expect(exitCode).toBe(0)

    await container.shutdown()
  })

  test('express ecosystem scaffold + execution smoke works', async () => {
    const files = createBunWebExpressExampleFiles('express ecosystem acceptance ok')
    const pkg = JSON.parse(files['/package.json'] as string) as {
      dependencies: Record<string, string>
    }

    expect(pkg.dependencies.express).toBeDefined()
    expect(files['/src/express-run.ts']).toContain("app.get('/health'")
    expect(files['/src/express-run.ts']).toContain('mw:logger')

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/express-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/health:200:ok|/missing:404:not-found')
    expect(result.output).toContain('mw:logger>route:health')
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('express ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('koa ecosystem scaffold + execution smoke works', async () => {
    const files = createBunWebKoaExampleFiles('koa ecosystem acceptance ok')
    const pkg = JSON.parse(files['/package.json'] as string) as {
      dependencies: Record<string, string>
    }

    expect(pkg.dependencies.koa).toBeDefined()
    expect(files['/src/koa-run.ts']).toContain('compose(')
    expect(files['/src/koa-run.ts']).toContain('mw:before')

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/koa-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/health:200:ok|/missing:404:not-found')
    expect(result.output).toContain('mw:before>route:health>mw:after')
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('koa ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('fastify ecosystem scaffold + execution smoke works', async () => {
    const files = createBunWebFastifyExampleFiles('fastify ecosystem acceptance ok')
    const pkg = JSON.parse(files['/package.json'] as string) as {
      dependencies: Record<string, string>
    }

    expect(pkg.dependencies.fastify).toBeDefined()
    expect(files['/src/fastify-run.ts']).toContain("addHook('onRequest'")
    expect(files['/src/fastify-run.ts']).toContain("app.get('/health'")

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/fastify-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/health:200:ok|/missing:404:not-found')
    expect(result.output).toContain('hook:onRequest>route:health')
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('fastify ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('hono ecosystem scaffold + execution smoke works', async () => {
    const files = createBunWebHonoExampleFiles('hono ecosystem acceptance ok')
    const pkg = JSON.parse(files['/package.json'] as string) as {
      dependencies: Record<string, string>
    }

    expect(pkg.dependencies.hono).toBeDefined()
    expect(files['/src/hono-run.ts']).toContain("app.use('/api'")
    expect(files['/src/hono-run.ts']).toContain("app.get('/api/health'")

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/hono-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/api/health:200:ok|/api/missing:404:not-found')
    expect(result.output).toContain('mw:api>route:health')
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('hono ecosystem acceptance ok\n')

    await result.container.shutdown()
  })

  test('bun serve routes style scaffold + execution smoke works', async () => {
    const files = createBunWebServeRoutesExampleFiles('bun serve routes acceptance ok')

    expect(files['/src/serve-routes-run.ts']).toContain("server.route('/ok'")
    expect(files['/src/serve-routes-run.ts']).toContain("server.fetch('/missing')")

    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files,
      },
      entrypoint: '/src/serve-routes-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/ok:200:ok|/json:200:{"ok":true}|/missing:404:not-found')
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('bun serve routes acceptance ok\n')

    await result.container.shutdown()
  })

  test('installer replay installs express/koa/vite dependencies via mock registry', async () => {
    const expressUrl = 'https://registry.example.test/express/-/express-4.21.2.tgz'
    const koaUrl = 'https://registry.example.test/koa/-/koa-2.15.4.tgz'
    const viteUrl = 'https://registry.example.test/vite/-/vite-5.4.19.tgz'
    const acceptsUrl = 'https://registry.example.test/accepts/-/accepts-1.3.8.tgz'
    const cookiesUrl = 'https://registry.example.test/cookies/-/cookies-0.9.1.tgz'
    const esbuildUrl = 'https://registry.example.test/esbuild/-/esbuild-0.21.5.tgz'

    const expressTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"express","version":"4.21.2"}' }]))
    const koaTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"koa","version":"2.15.4"}' }]))
    const viteTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"vite","version":"5.4.19"}' }]))
    const acceptsTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"accepts","version":"1.3.8"}' }]))
    const cookiesTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"cookies","version":"0.9.1"}' }]))
    const esbuildTar = await gzip(createTar([{ path: 'package/package.json', data: '{"name":"esbuild","version":"0.21.5"}' }]))

    const metadata = {
      'https://registry.example.test/express': {
        name: 'express',
        'dist-tags': { latest: '4.21.2' },
        versions: {
          '4.21.2': {
            dependencies: { accepts: '^1.3.8' },
            dist: { tarball: expressUrl, integrity: await toSRI(expressTar) },
          },
        },
      },
      'https://registry.example.test/koa': {
        name: 'koa',
        'dist-tags': { latest: '2.15.4' },
        versions: {
          '2.15.4': {
            dependencies: { cookies: '^0.9.1' },
            dist: { tarball: koaUrl, integrity: await toSRI(koaTar) },
          },
        },
      },
      'https://registry.example.test/vite': {
        name: 'vite',
        'dist-tags': { latest: '5.4.19' },
        versions: {
          '5.4.19': {
            dependencies: { esbuild: '^0.21.5' },
            dist: { tarball: viteUrl, integrity: await toSRI(viteTar) },
          },
        },
      },
      'https://registry.example.test/accepts': {
        name: 'accepts',
        'dist-tags': { latest: '1.3.8' },
        versions: {
          '1.3.8': {
            dist: { tarball: acceptsUrl, integrity: await toSRI(acceptsTar) },
          },
        },
      },
      'https://registry.example.test/cookies': {
        name: 'cookies',
        'dist-tags': { latest: '0.9.1' },
        versions: {
          '0.9.1': {
            dist: { tarball: cookiesUrl, integrity: await toSRI(cookiesTar) },
          },
        },
      },
      'https://registry.example.test/esbuild': {
        name: 'esbuild',
        'dist-tags': { latest: '0.21.5' },
        versions: {
          '0.21.5': {
            dist: { tarball: esbuildUrl, integrity: await toSRI(esbuildTar) },
          },
        },
      },
    }

    const result = await installFromManifest(
      {
        dependencies: {
          express: 'latest',
          koa: 'latest',
          vite: 'latest',
        },
      },
      {
        registryUrl: 'https://registry.example.test',
        fetchFn: createRegistryFetch(metadata, {
          [expressUrl]: expressTar,
          [koaUrl]: koaTar,
          [viteUrl]: viteTar,
          [acceptsUrl]: acceptsTar,
          [cookiesUrl]: cookiesTar,
          [esbuildUrl]: esbuildTar,
        }),
      },
    )

    expect(result.resolvedRootDependencies.express).toBe('4.21.2')
    expect(result.resolvedRootDependencies.koa).toBe('2.15.4')
    expect(result.resolvedRootDependencies.vite).toBe('5.4.19')

    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/express',
      packageKey: 'express@4.21.2',
    })
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/koa',
      packageKey: 'koa@2.15.4',
    })
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/vite',
      packageKey: 'vite@5.4.19',
    })
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/accepts',
      packageKey: 'accepts@1.3.8',
    })
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/cookies',
      packageKey: 'cookies@0.9.1',
    })
    expect(result.layoutPlan.entries).toContainEqual({
      installPath: '/node_modules/esbuild',
      packageKey: 'esbuild@0.21.5',
    })
  })
})