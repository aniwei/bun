/**
 * sandbox.ts — 插件 CPU/内存预算熔断（M7-2 轻量实现）
 *
 * 当前实现：基于 wall-clock 超时的软熔断。
 * 真正的 CPU 时间隔离需要 Worker + SharedArrayBuffer 协调，
 * 此处提供契约接口与 wall-clock 降级实现作为占位，后续可在 bun-web-agent 层补强。
 */

export interface PluginBudget {
  /** setup 阶段最大等待时间（wall-clock，单位 ms；默认 5000） */
  timeoutMs?: number
}

export class PluginBudgetExceededError extends Error {
  constructor(pluginName: string, timeoutMs: number) {
    super(`Plugin "${pluginName}" exceeded budget: setup did not complete within ${timeoutMs}ms`)
    this.name = 'PluginBudgetExceededError'
  }
}

/**
 * 以 wall-clock 超时包装插件 setup 调用。
 * 超时后抛出 PluginBudgetExceededError，外层 PluginRegistry 捕获并记录日志。
 */
export async function runWithBudget<T>(
  pluginName: string,
  fn: () => Promise<T>,
  budget: PluginBudget = {},
): Promise<T> {
  const timeoutMs = budget.timeoutMs ?? 5_000

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new PluginBudgetExceededError(pluginName, timeoutMs))
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([fn(), timeoutPromise])
    return result
  } finally {
    clearTimeout(timeoutHandle)
  }
}
