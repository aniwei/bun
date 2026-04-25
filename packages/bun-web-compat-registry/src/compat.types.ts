// ── 兼容级别（对齐 RFC §9） ────────────────────────────────────────────────────

/**
 * A – 完整对齐原生 Bun 行为，无已知差异
 * B – 核心路径对齐，边缘情况有差异（有对应测试覆盖）
 * C – 部分实现，有明确 TODO 与 issue 追踪
 * D – 存根/不支持，调用会产生明确错误
 */
export type CompatLevel = 'A' | 'B' | 'C' | 'D'

export interface CompatEntry {
  /** 符号全名，例如 'Bun.serve'、'node:net.Socket'、'process.dlopen' */
  symbol: string
  level: CompatLevel
  /** 可选说明（差异原因、限制条件等） */
  notes?: string
  /** semver：首次实现版本 */
  since?: string
  /** 已知不兼容行为对应的 GitHub issue URL 列表 */
  issues?: string[]
}

export interface ValidationResult {
  ok: boolean
  /** 未登记符号列表（由 scanner 提供） */
  missing: string[]
  /** 降级警告（A/B → C/D 变更） */
  degraded: Array<{ symbol: string; from: CompatLevel; to: CompatLevel }>
}
