import { describe, expect, test } from 'vitest'
import {
  createBuiltinCommandRegistry,
  createInMemoryFS,
  parseShellPipeline,
  runShellCommandSync,
} from '../../../packages/bun-web-shell/src'
import { spawnSync } from '../../../packages/bun-web-runtime/src/spawn'
import { stableSnapshot } from './snapshot-utils'

describe('M5 shell parser and builtins', () => {
  test('parser handles pipeline and redirect metadata', () => {
    const parsed = parseShellPipeline("cat a.txt | grep hello > out.txt")

    expect(parsed.commands).toHaveLength(2)
    expect(stableSnapshot(parsed.commands)).toMatchInlineSnapshot(`
      "[
        {
          \"appendOut\": \"undefined\",
          \"args\": [
            \"a.txt\"
          ],
          \"command\": \"cat\",
          \"redirectIn\": \"undefined\",
          \"redirectOut\": \"undefined\"
        },
        {
          \"appendOut\": \"undefined\",
          \"args\": [
            \"hello\"
          ],
          \"command\": \"grep\",
          \"redirectIn\": \"undefined\",
          \"redirectOut\": \"out.txt\"
        }
      ]"
    `)
  })

  test('shell builtins support cat|grep|jq pipeline', () => {
    const fs = createInMemoryFS({
      kind: 'dir',
      children: {
        logs: {
          kind: 'dir',
          children: {
            'a.log': { kind: 'file', content: 'ok line\nwarn line' },
            'b.log': { kind: 'file', content: 'ok again' },
          },
        },
        'data.json': { kind: 'file', content: '{"name":"bun","meta":{"phase":"m5"}}' },
      },
    })

    const grepResult = runShellCommandSync('cd logs | cat *.log | grep warn', {
      cwd: '/',
      fs,
      registry: createBuiltinCommandRegistry(),
    })

    expect(grepResult.exitCode).toBe(0)
    expect(grepResult.stdout).toContain('warn line')
    expect(grepResult.cwd).toBe('/logs')

    const jqResult = runShellCommandSync('cat data.json | jq .meta.phase', {
      cwd: '/',
      fs,
      registry: createBuiltinCommandRegistry(),
    })

    expect(jqResult.exitCode).toBe(0)
    expect(jqResult.stdout).toBe('"m5"')
  })

  test('spawnSync executes shell command line', () => {
    const result = spawnSync({
      cmd: ['sh', '-c', 'jq .phase'],
      stdin: '{"phase":"m5"}',
    })

    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('"m5"')
    expect(new TextDecoder().decode(result.stderr)).toBe('')
  })

  test('command registry supports register/unregister/tryExecute/execute/has', () => {
    const registry = createBuiltinCommandRegistry()

    expect(registry.has('hello')).toBe(false)
    expect(registry.tryExecute('hello', [], { cwd: '/', stdin: '', env: {}, setCwd() {} })).toBeNull()

    registry.register('hello', () => ({ stdout: 'world', stderr: '', exitCode: 0 }))
    expect(registry.has('hello')).toBe(true)

    const executed = registry.execute('hello', [], {
      cwd: '/',
      stdin: '',
      env: {},
      setCwd() {},
    })
    expect(stableSnapshot(executed)).toMatchInlineSnapshot(`
      "{
        \"exitCode\": 0,
        \"stderr\": \"\",
        \"stdout\": \"world\"
      }"
    `)

    expect(registry.unregister('hello')).toBe(true)
    expect(registry.has('hello')).toBe(false)

    const missing = registry.execute('hello', [], {
      cwd: '/',
      stdin: '',
      env: {},
      setCwd() {},
    })
    expect(missing.exitCode).toBe(127)
  })

  test('runner can execute hook-registered commands', () => {
    const result = runShellCommandSync('hello bun', {
      registry: createBuiltinCommandRegistry(),
      hooks: [
        registry => {
          registry.register('hello', args => ({
            stdout: `hi:${args.join(',')}`,
            stderr: '',
            exitCode: 0,
          }))
        },
      ],
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hi:bun')
  })
})
