import type { AuditEntry, VFSWriter } from './agent.types'

const DEFAULT_LOG_PATH = '/tmp/agent-audit.jsonl'

/**
 * 审计日志写入器（追加写 VFS）。
 * 日志格式：每行一个 JSON 对象（JSONL）。
 */
export class AuditOverlay {
  private readonly vfs: VFSWriter
  private readonly logPath: string

  constructor(vfs: VFSWriter, logPath: string = DEFAULT_LOG_PATH) {
    this.vfs = vfs
    this.logPath = logPath
  }

  async log(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    const existing = await this.vfs.readFile(this.logPath)
    const prev = existing ?? new Uint8Array()
    const next = new Uint8Array(prev.byteLength + line.length)
    next.set(prev)
    next.set(new TextEncoder().encode(line), prev.byteLength)
    await this.vfs.writeFile(this.logPath, next)
  }

  /** 读取最近 n 条审计记录（默认 50 条） */
  async tail(n = 50): Promise<AuditEntry[]> {
    const raw = await this.vfs.readFile(this.logPath)
    if (!raw) return []
    const text = new TextDecoder().decode(raw)
    const lines = text
      .split('\n')
      .filter(l => l.trim().length > 0)
    const recent = lines.slice(-n)
    return recent.map(l => {
      try {
        return JSON.parse(l) as AuditEntry
      } catch {
        return null
      }
    }).filter((e): e is AuditEntry => e !== null)
  }
}
