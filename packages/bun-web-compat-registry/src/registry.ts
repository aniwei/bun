import type { CompatEntry, CompatLevel, ValidationResult } from './compat.types'
import { isDegradation } from './levels'

// ── MarsWebUnsupportedError ────────────────────────────────────────────────────

/**
 * D 级 API 调用守卫抛出此错误。
 * 与原生 Bun 的 ERR_NOT_IMPLEMENTED 风格对齐，提供更多上下文信息。
 */
export class MarsWebUnsupportedError extends Error {
  readonly code = 'ERR_BUN_WEB_UNSUPPORTED' as const
  readonly symbol: string
  readonly compatLevel: CompatLevel

  constructor(
    symbol: string,
    meta?: { notes?: string; level?: CompatLevel },
  ) {
    const level = meta?.level ?? 'D'
    const notes = meta?.notes ? ` – ${meta.notes}` : ''
    super(`"${symbol}" is not supported in @mars/web-runtime (compat level: ${level})${notes}`)
    this.name = 'MarsWebUnsupportedError'
    this.symbol = symbol
    this.compatLevel = level
  }
}

// ── CompatRegistry ─────────────────────────────────────────────────────────────

/**
 * 全局 API 符号兼容级别注册表。
 *
 * - `register` / `registerAll`：登记符号及其兼容级别
 * - `get` / `list`：查询
 * - `validate`：对比"已知符号集合"检测未登记符号与降级情况
 * - `assertSupported`：D 级守卫，供各包 stub 调用
 */
export class CompatRegistry {
  private readonly entries = new Map<string, CompatEntry>()
  private knownSymbols: Set<string> | null = null

  // ── 全局单例（可在 runtime bootstrap 阶段访问） ────────────────────────────
  private static _instance: CompatRegistry | null = null

  static get instance(): CompatRegistry {
    if (!CompatRegistry._instance) {
      CompatRegistry._instance = new CompatRegistry()
    }
    return CompatRegistry._instance
  }

  /** 仅用于测试：重置单例 */
  static __resetInstance(): void {
    CompatRegistry._instance = null
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────

  register(entry: CompatEntry): void {
    this.entries.set(entry.symbol, { ...entry })
  }

  registerAll(entries: CompatEntry[]): void {
    for (const entry of entries) {
      this.register(entry)
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────────

  get(symbol: string): CompatEntry | undefined {
    return this.entries.get(symbol)
  }

  /** 返回指定 level（不传则全量）的条目列表，按符号名升序 */
  list(level?: CompatLevel): CompatEntry[] {
    const all = Array.from(this.entries.values())
    const filtered = level ? all.filter(e => e.level === level) : all
    return filtered.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }

  // ── 验证 ────────────────────────────────────────────────────────────────────

  /**
   * 设置"已知符号集合"（由 gen-compat-matrix 扫描 bun-types 注入）。
   * 调用 validate() 时用此集合检测未登记项。
   */
  setKnownSymbols(symbols: Iterable<string>): void {
    this.knownSymbols = new Set(symbols)
  }

  /**
   * 检测 (1) 未登记符号 (2) 相对快照的降级。
   * 若 setKnownSymbols 未调用，missing 始终为空。
   */
  validate(previousSnapshot?: ReadonlyMap<string, CompatLevel>): ValidationResult {
    const missing: string[] = []
    if (this.knownSymbols) {
      for (const sym of this.knownSymbols) {
        if (!this.entries.has(sym)) {
          missing.push(sym)
        }
      }
      missing.sort()
    }

    const degraded: ValidationResult['degraded'] = []
    if (previousSnapshot) {
      for (const [symbol, prevLevel] of previousSnapshot) {
        const current = this.entries.get(symbol)
        if (current && isDegradation(prevLevel, current.level)) {
          degraded.push({ symbol, from: prevLevel, to: current.level })
        }
      }
    }

    return {
      ok: missing.length === 0 && degraded.length === 0,
      missing,
      degraded,
    }
  }

  // ── D 级守卫 ─────────────────────────────────────────────────────────────────

  /**
   * 若符号未登记或 level 为 D，抛出 MarsWebUnsupportedError。
   * 供各包 D 级 API 存根调用。
   */
  assertSupported(symbol: string): void {
    const entry = this.entries.get(symbol)
    if (!entry || entry.level === 'D') {
      throw new MarsWebUnsupportedError(symbol, {
        level: entry?.level ?? 'D',
        notes: entry?.notes,
      })
    }
  }
}
