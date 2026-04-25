import type { CompatLevel } from './compat.types'

/** 所有合法的 CompatLevel 值 */
export const COMPAT_LEVELS: readonly CompatLevel[] = ['A', 'B', 'C', 'D'] as const

/** 判断字符串是否是合法 CompatLevel */
export function isCompatLevel(value: unknown): value is CompatLevel {
  return typeof value === 'string' && (COMPAT_LEVELS as readonly string[]).includes(value)
}

/**
 * 返回 true 表示从 `from` 到 `to` 属于"降级"
 * 降级定义：从高保真级（A/B）退化为低保真级（C/D）
 */
export function isDegradation(from: CompatLevel, to: CompatLevel): boolean {
  const rank: Record<CompatLevel, number> = { A: 0, B: 1, C: 2, D: 3 }
  return rank[to] > rank[from]
}

/**
 * 按 CompatLevel 排序的比较函数（A 最优先）
 * 可用于 list().sort(compareByLevel)
 */
export function compareByLevel(a: CompatLevel, b: CompatLevel): number {
  const rank: Record<CompatLevel, number> = { A: 0, B: 1, C: 2, D: 3 }
  return rank[a] - rank[b]
}
