// ── AgentCapabilities（RFC §22） ────────────────────────────────────────────

export interface AgentCapabilities {
  /** 允许的 shell 命令名列表（精确匹配 argv[0]） */
  allowedCommands: string[]
  /** 允许读写的路径前缀列表（以任一前缀开头即允许） */
  allowedPaths: string[]
  /** 是否允许出站 fetch / WebSocket */
  allowNetwork: boolean
  /** 单次命令最大输出字节数（超出截断，默认 1 MB） */
  maxOutputBytes?: number
  /** 审计日志写入 VFS 路径（默认 /tmp/agent-audit.jsonl） */
  auditLog?: string
}

// ── ShellContext（轻量抽象，不依赖 bun-web-shell） ─────────────────────────

export interface ShellContext {
  cwd: string
  env: Record<string, string>
}

// ── AgentExecResult ─────────────────────────────────────────────────────────

export interface AgentExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** true = 命令被白名单拒绝，未实际执行 */
  blocked: boolean
  /** 拒绝原因（仅 blocked=true 时有值） */
  reason?: string
}

// ── ShellExecutor（基础执行器接口，由调用方注入） ──────────────────────────

export interface ShellExecutor {
  exec(
    command: string,
    argv: string[],
    ctx: ShellContext,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

// ── AuditEntry ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string       // ISO 8601
  command: string
  argv: string[]
  exitCode: number
  blocked: boolean
}

// ── VFSWriter（只需要 write 能力，避免全 VFS 依赖） ────────────────────────

export interface VFSWriter {
  readFile(path: string): Promise<Uint8Array | null>
  writeFile(path: string, data: Uint8Array): Promise<void>
}
