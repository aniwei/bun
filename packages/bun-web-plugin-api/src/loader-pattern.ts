import type { LoaderArgs, LoaderPattern, LoaderResult } from './plugin.types'

/**
 * 判断给定路径 + namespace 是否匹配 LoaderPattern。
 * - filter (RegExp) 匹配 path
 * - namespace 如果在 pattern 中声明，则须完全相等；省略时通配
 */
export function matchesLoaderPattern(
  pattern: LoaderPattern,
  args: Pick<LoaderArgs, 'path' | 'namespace'>,
): boolean {
  if (pattern.namespace !== undefined && pattern.namespace !== args.namespace) {
    return false
  }
  return pattern.filter.test(args.path)
}

/**
 * 从多个 pattern 中找到第一个匹配的 loader 并执行。
 * 若无匹配则返回 null。
 */
export async function dispatchLoader(
  patterns: readonly LoaderPattern[],
  args: LoaderArgs,
): Promise<LoaderResult | null> {
  for (const pattern of patterns) {
    if (matchesLoaderPattern(pattern, args)) {
      return pattern.loader(args)
    }
  }
  return null
}
