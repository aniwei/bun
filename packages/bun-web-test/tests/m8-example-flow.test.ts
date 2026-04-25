import { describe, expect, it } from 'vitest'
import { BunContainer, PreviewManager } from '@mars/web-client'
import {
  createBunWebExampleFiles,
  listBunWebExampleScenarios,
  runBunWebExample,
} from '@mars/web-example'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('M8 example flow', () => {
  it('generates a Vite + React + TypeScript example file tree', () => {
    const files = createBunWebExampleFiles('hello vite react ts')

    expect(files['/index.html']).toContain("<script type='module' src='/src/main.tsx'></script>")
    expect(files['/src/main.tsx']).toContain("import ReactDOM from 'react-dom/client'")
    expect(files['/src/App.tsx']).toContain('Dify 风格示例工作台')
    expect(files['/src/example-run.ts']).toContain('hello vite react ts')
    expect(files['/vite.config.ts']).toContain("import react from '@vitejs/plugin-react'")
  })

  it('runs the bun-web-example from BunContainer boot to code execution', async () => {
    const result = await runBunWebExample({
      boot: {
        workerType: 'shared',
        files: createBunWebExampleFiles('hello e2e'),
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('hello e2e\n')
    expect(result.previewURL).toBeNull()

    await result.container.shutdown()
  })

  it('runs selectable use-case scenarios from the example platform registry', async () => {
    const scenarios = listBunWebExampleScenarios()
    expect(scenarios.map(item => item.id)).toContain('express')

    const result = await runBunWebExample({
      useCase: 'express',
      message: 'platform express run',
    })

    expect(result.useCase).toBe('express')
    expect(result.entrypoint).toBe('/src/express-run.ts')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('platform express run')

    await result.container.shutdown()
  })

  it('runBunWebExample returns previewURL when entrypoint starts Bun.serve', async () => {
    const files = createBunWebExampleFiles('hello preview')
    files['/src/serve-run.ts'] = `
      Bun.serve({
        port: 4588,
        fetch() {
          return new Response('ok')
        },
      })
      console.log('serve-ready')
    `

    const result = await runBunWebExample({
      files,
      entrypoint: '/src/serve-run.ts',
    })

    expect(result.exitCode).toBe(0)
    expect(result.previewURL).toBe('http://localhost:4588')

    await result.container.shutdown()
  })

  it('supports the object-form spawn API and mounted script execution', async () => {
    const container = await BunContainer.boot()
    await container.mount({
      '/index.ts': 'console.log("spawn object form")',
    })

    const proc = await container.spawn({ argv: ['bun', 'run', '/index.ts'] })
    const output = await new Response(proc.output).text()

    expect(output).toBe('spawn object form\n')
    expect(await proc.waitForExit()).toBe(0)

    await container.shutdown()
  })

  it('emits server-ready on Bun.serve spawn and preview manager can bind it', async () => {
    const container = await BunContainer.boot()
    const preview = new PreviewManager()
    const unbind = preview.bind(container)

    let seenUrl: string | null = null
    const offReady = preview.onServerReady(event => {
      seenUrl = event.url
    })

    await container.mount({
      '/serve.ts': `
        Bun.serve({
          port: 4321,
          fetch() {
            return new Response('ok')
          },
        })
        console.log('ready')
      `,
    })

    const proc = await container.spawn({ argv: ['bun', 'run', '/serve.ts'] })
    expect(await proc.waitForExit()).toBe(0)

    expect(seenUrl).toBe('http://localhost:4321')
    expect(preview.getCurrentURL()).toBe('http://localhost:4321')

    offReady()
    unbind()
    await container.shutdown()
  })

  it('propagates server-ready host and protocol from Bun.serve options', async () => {
    const container = await BunContainer.boot()
    const seen: Array<{ url: string; host: string; protocol: 'http' | 'https' }> = []

    const off = container.on('server-ready', event => {
      seen.push({
        url: event.url,
        host: event.host,
        protocol: event.protocol,
      })
    })

    await container.mount({
      '/serve-meta.ts': `
        Bun.serve({
          port: 3443,
          hostname: '127.0.0.1',
          tls: true,
          fetch() {
            return new Response('ok')
          },
        })
        console.log('ready')
      `,
    })

    const proc = await container.spawn({ argv: ['bun', 'run', '/serve-meta.ts'] })
    expect(await proc.waitForExit()).toBe(0)

    expect(seen).toContainEqual({
      url: 'https://127.0.0.1:3443',
      host: '127.0.0.1',
      protocol: 'https',
    })

    off()
    await container.shutdown()
  })

  it('wires runBunWebExample inside the example app UI', () => {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const appSource = readFileSync(resolve(currentDir, '../../bun-web-example/src/App.tsx'), 'utf8')

    expect(appSource).toContain('listBunWebExampleScenarios')
    expect(appSource).toContain("const [selectedUseCase, setSelectedUseCase] = useState<BunWebExampleUseCase>('vite-react-ts')")
    expect(appSource).toContain('const handleRunExample = async () =>')
    expect(appSource).toContain('await runBunWebExample({')
    expect(appSource).toContain('useCase: selectedUseCase')
    expect(appSource).toContain("id='example-use-case'")
    expect(appSource).toContain('onClick={handleRunExample}')
  })
})