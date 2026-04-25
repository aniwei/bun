import type {
  AgentCapabilities,
  AgentExecResult,
  ShellContext,
  ShellExecutor,
} from './agent.types'
import { isCommandAllowed, truncateOutput } from './capabilities'
import type { AuditOverlay } from './audit-overlay'

const DEFAULT_CTX: ShellContext = { cwd: '/', env: {} }

/**
 * AgentShell — 受限 shell 执行器（RFC §22）
 *
 * 职责：
 * - 命令白名单检查（allowedCommands）
 * - 输出截断（maxOutputBytes）
 * - 审计日志写入（AuditOverlay）
 * - 将通过白名单的命令委托给 baseExecutor 执行
 */
export class AgentShell {
  readonly capabilities: AgentCapabilities
  private readonly baseExecutor: ShellExecutor
  private readonly audit: AuditOverlay | null

  constructor(
    baseExecutor: ShellExecutor,
    caps: AgentCapabilities,
    audit?: AuditOverlay,
  ) {
    this.baseExecutor = baseExecutor
    this.capabilities = caps
    this.audit = audit ?? null
  }

  async exec(
    command: string,
    argv: string[] = [],
    ctx: Partial<ShellContext> = {},
  ): Promise<AgentExecResult> {
    const shellCtx: ShellContext = { ...DEFAULT_CTX, ...ctx }
    const allArgv = [command, ...argv]

    // ── 白名单检查 ────────────────────────────────────────────────────────
    if (!isCommandAllowed(command, this.capabilities)) {
      const result: AgentExecResult = {
        exitCode: 1,
        stdout: '',
        stderr: `[AgentShell] Command "${command}" is not in the allowed list.`,
        blocked: true,
        reason: `Command "${command}" not in allowedCommands`,
      }
      await this.writeAudit({ command, argv: allArgv, exitCode: 1, blocked: true })
      return result
    }

    // ── 委托执行 ──────────────────────────────────────────────────────────
    let raw: { exitCode: number; stdout: string; stderr: string }
    try {
      raw = await this.baseExecutor.exec(command, argv, shellCtx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.writeAudit({ command, argv: allArgv, exitCode: 1, blocked: false })
      return {
        exitCode: 1,
        stdout: '',
        stderr: `[AgentShell] Executor error: ${msg}`,
        blocked: false,
      }
    }

    // ── 输出截断 ──────────────────────────────────────────────────────────
    const stdout = truncateOutput(raw.stdout, this.capabilities.maxOutputBytes)
    const stderr = truncateOutput(raw.stderr, this.capabilities.maxOutputBytes)

    await this.writeAudit({ command, argv: allArgv, exitCode: raw.exitCode, blocked: false })

    return {
      exitCode: raw.exitCode,
      stdout,
      stderr,
      blocked: false,
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private async writeAudit(params: {
    command: string
    argv: string[]
    exitCode: number
    blocked: boolean
  }): Promise<void> {
    if (!this.audit) return
    try {
      await this.audit.log({
        ts: new Date().toISOString(),
        command: params.command,
        argv: params.argv,
        exitCode: params.exitCode,
        blocked: params.blocked,
      })
    } catch {
      // 审计写入失败不应阻断主流程
    }
  }
}
