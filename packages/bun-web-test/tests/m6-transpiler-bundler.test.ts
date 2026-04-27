import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { WebTranspiler, scanImports } from '../../../packages/bun-web-transpiler/src/swc'
import { build } from '../../../packages/bun-web-bundler/src/build'

describe('M6 transpiler and bundler baseline', () => {
  test('transpiler transforms TypeScript and scans imports', () => {
    const transpiler = new WebTranspiler()
    const source = "import { x } from './x'; const fn = (value: number): number => value + 1; export { fn }"

    const output = transpiler.transform(source, { loader: 'ts' })
    const imports = scanImports(source)

    expect(output).toContain('value + 1')
    expect(imports).toEqual([{ path: './x', kind: 'import' }])
  })

  test('bundler build produces bundled output file', async () => {
    const root = join(tmpdir(), `m6-bundler-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const helper = join(root, 'helper.ts')
    const outdir = join(root, 'dist')

    writeFileSync(helper, 'export const answer = 42')
    writeFileSync(entry, "import { answer } from './helper'; console.log(answer)")

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      minify: false,
    })

    expect(result.success).toBe(true)
    expect(result.outputs.length).toBeGreaterThan(0)

    const firstOutput = result.outputs[0]
    const content = readFileSync(firstOutput, 'utf8')
    expect(content).toContain('42')

    rmSync(root, { recursive: true, force: true })
  })
})
