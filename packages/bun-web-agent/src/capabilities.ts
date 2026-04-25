import type { AgentCapabilities, ShellContext } from './agent.types'

// ── 路径检查 ─────────────────────────────────────────────────────────────────

/**
 * 检查给定路径是否在允许前缀列表内。
 * allowedPaths 为空列表 = 禁止一切路径访问。
 */
export function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return false
  return allowedPaths.some(prefix => path.startsWith(prefix))
}

// ── 命令检查 ─────────────────────────────────────────────────────────────────

/**
 * 检查 argv[0]（命令名）是否在允许列表内。
 * allowedCommands 为空列表 = 禁止一切命令。
 */
export function isCommandAllowed(command: string, caps: AgentCapabilities): boolean {
  return caps.allowedCommands.includes(command)
}

// ── 输出截断 ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576 // 1 MB

export function truncateOutput(output: string, maxBytes?: number): string {
  const limit = maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const buf = new TextEncoder().encode(output)
  if (buf.byteLength <= limit) return output
  const truncated = new TextDecoder().decode(buf.slice(0, limit))
  return truncated + `\n[output truncated at ${limit} bytes]`
}
