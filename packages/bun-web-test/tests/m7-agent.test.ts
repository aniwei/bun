/**
 * M7-7 — bun-web-agent 单元测试
 *
 * 覆盖：
 * - AgentShell 白名单允许/拒绝
 * - blocked=true 不抛异常
 * - 输出截断
 * - AuditOverlay log/tail
 * - capabilities 工具函数
 */

import { describe, it, expect } from 'vitest'
import { AgentShell, AuditOverlay, isCommandAllowed, isPathAllowed, truncateOutput } from '@mars/web-agent'
import type { AgentCapabilities, ShellExecutor, VFSWriter } from '@mars/web-agent'

// ── 测试用 InMemory VFSWriter ─────────────────────────────────────────────────

class InMemoryVFS implements VFSWriter {
  private store = new Map<string, Uint8Array>()

  async readFile(path: string): Promise<Uint8Array | null> {
    return this.store.get(path) ?? null
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.store.set(path, data)
  }
}

// ── 测试用 ShellExecutor ──────────────────────────────────────────────────────

function makeExecutor(
  fn: (cmd: string, argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): ShellExecutor {
  return { exec: (cmd, argv) => fn(cmd, argv) }
}

function echoExecutor(): ShellExecutor {
  return makeExecutor(async (cmd, argv) => ({
    exitCode: 0,
    stdout: `${cmd} ${argv.join(' ')}`.trim(),
    stderr: '',
  }))
}

function failExecutor(): ShellExecutor {
  return makeExecutor(async () => { throw new Error('exec-error') })
}

// ── 默认 capabilities ─────────────────────────────────────────────────────────

const defaultCaps: AgentCapabilities = {
  allowedCommands: ['ls', 'cat', 'echo'],
  allowedPaths: ['/workspace', '/tmp'],
  allowNetwork: false,
}

// ── isCommandAllowed ──────────────────────────────────────────────────────────

describe('capabilities – isCommandAllowed', () => {
  it('returns true for allowed command', () => {
    expect(isCommandAllowed('ls', defaultCaps)).toBe(true)
  })

  it('returns false for disallowed command', () => {
    expect(isCommandAllowed('rm', defaultCaps)).toBe(false)
  })

  it('empty allowedCommands blocks everything', () => {
    expect(isCommandAllowed('ls', { ...defaultCaps, allowedCommands: [] })).toBe(false)
  })
})

// ── isPathAllowed ─────────────────────────────────────────────────────────────

describe('capabilities – isPathAllowed', () => {
  it('allows path within allowed prefix', () => {
    expect(isPathAllowed('/workspace/src/app.ts', defaultCaps.allowedPaths)).toBe(true)
  })

  it('blocks path outside allowed prefixes', () => {
    expect(isPathAllowed('/etc/passwd', defaultCaps.allowedPaths)).toBe(false)
  })

  it('empty allowedPaths blocks everything', () => {
    expect(isPathAllowed('/workspace/file.ts', [])).toBe(false)
  })
})

// ── truncateOutput ────────────────────────────────────────────────────────────

describe('capabilities – truncateOutput', () => {
  it('does not modify short output', () => {
    const out = 'hello world'
    expect(truncateOutput(out, 1000)).toBe(out)
  })

  it('truncates output exceeding maxBytes', () => {
    const longOutput = 'a'.repeat(100)
    const result = truncateOutput(longOutput, 50)
    expect(result).toContain('[output truncated at 50 bytes]')
    expect(result.startsWith('a'.repeat(50))).toBe(true)
  })
})

// ── AgentShell – 允许命令 ─────────────────────────────────────────────────────

describe('AgentShell – allowed command', () => {
  it('executes allowed command and returns output', async () => {
    const shell = new AgentShell(echoExecutor(), defaultCaps)
    const result = await shell.exec('echo', ['hello'])

    expect(result.blocked).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('echo hello')
  })

  it('passes cwd and env to executor', async () => {
    let capturedCtx: { cwd: string; env: Record<string, string> } | null = null
    const executor = makeExecutor(async (cmd, argv, ...rest) => {
      // ctx is the third param via ShellExecutor interface
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    // Use real executor that captures context
    const capturingExecutor: ShellExecutor = {
      exec: async (cmd, argv, ctx) => {
        capturedCtx = ctx
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const shell = new AgentShell(capturingExecutor, defaultCaps)
    await shell.exec('ls', [], { cwd: '/workspace', env: { HOME: '/root' } })

    expect(capturedCtx?.cwd).toBe('/workspace')
    expect(capturedCtx?.env.HOME).toBe('/root')
  })
})

// ── AgentShell – 拒绝命令 ─────────────────────────────────────────────────────

describe('AgentShell – blocked command', () => {
  it('returns blocked=true for disallowed command without throwing', async () => {
    const shell = new AgentShell(echoExecutor(), defaultCaps)
    const result = await shell.exec('rm', ['-rf', '/'])

    expect(result.blocked).toBe(true)
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain('rm')
    expect(result.stdout).toBe('')
  })

  it('blocked result does not call baseExecutor', async () => {
    let executorCalled = false
    const executor = makeExecutor(async () => {
      executorCalled = true
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const shell = new AgentShell(executor, defaultCaps)
    await shell.exec('sudo', ['rm', '-rf', '/'])

    expect(executorCalled).toBe(false)
  })
})

// ── AgentShell – executor 异常容错 ──────────────────────────────────────────

describe('AgentShell – executor error resilience', () => {
  it('returns exitCode=1 with error message when executor throws', async () => {
    const shell = new AgentShell(failExecutor(), defaultCaps)
    const result = await shell.exec('ls', [])

    expect(result.blocked).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('exec-error')
  })
})

// ── AuditOverlay ──────────────────────────────────────────────────────────────

describe('AuditOverlay – log / tail', () => {
  it('logs a single entry', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs, '/logs/audit.jsonl')

    await audit.log({ ts: '2025-01-01T00:00:00.000Z', command: 'ls', argv: ['ls'], exitCode: 0, blocked: false })

    const entries = await audit.tail()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.command).toBe('ls')
    expect(entries[0]!.exitCode).toBe(0)
    expect(entries[0]!.blocked).toBe(false)
  })

  it('appends multiple entries in order', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs)

    await audit.log({ ts: '2025-01-01T00:00:00.000Z', command: 'ls', argv: ['ls'], exitCode: 0, blocked: false })
    await audit.log({ ts: '2025-01-01T00:00:01.000Z', command: 'cat', argv: ['cat', 'a.txt'], exitCode: 0, blocked: false })
    await audit.log({ ts: '2025-01-01T00:00:02.000Z', command: 'rm', argv: ['rm'], exitCode: 1, blocked: true })

    const entries = await audit.tail()
    expect(entries).toHaveLength(3)
    expect(entries[0]!.command).toBe('ls')
    expect(entries[2]!.blocked).toBe(true)
  })

  it('tail(n) returns at most n entries', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs)

    for (let i = 0; i < 10; i++) {
      await audit.log({ ts: new Date().toISOString(), command: 'echo', argv: [`echo ${i}`], exitCode: 0, blocked: false })
    }

    const entries = await audit.tail(3)
    expect(entries).toHaveLength(3)
  })

  it('tail on empty log returns empty array', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs)

    const entries = await audit.tail()
    expect(entries).toHaveLength(0)
  })
})

// ── AgentShell + AuditOverlay 集成 ───────────────────────────────────────────

describe('AgentShell + AuditOverlay integration', () => {
  it('allowed command is logged with blocked=false', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs)
    const shell = new AgentShell(echoExecutor(), defaultCaps, audit)

    await shell.exec('ls', [])

    const entries = await audit.tail()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.blocked).toBe(false)
    expect(entries[0]!.command).toBe('ls')
  })

  it('blocked command is logged with blocked=true', async () => {
    const vfs = new InMemoryVFS()
    const audit = new AuditOverlay(vfs)
    const shell = new AgentShell(echoExecutor(), defaultCaps, audit)

    await shell.exec('rm', ['-rf', '/'])

    const entries = await audit.tail()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.blocked).toBe(true)
    expect(entries[0]!.command).toBe('rm')
  })
})
