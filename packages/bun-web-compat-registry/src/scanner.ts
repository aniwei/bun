/**
 * scanner.ts — build-time 符号扫描（对齐 RFC §9 / M7-4）
 *
 * 此模块在 Node.js / Bun 运行时的构建步骤中调用（非浏览器）。
 * 它解析 packages/bun-types/**\/\*.d.ts 中的 export 声明，
 * 提取符号全名列表供 CompatRegistry.setKnownSymbols() 使用。
 *
 * 扫描规则：
 * - `declare namespace Bun { ... }` 中 `export function/const/class/interface` → 'Bun.<name>'
 * - `declare module 'node:<mod>' { export ... }` → 'node:<mod>.<name>'
 * - 顶层 `export declare function/const/class` → 裸名
 *
 * 注：当前实现为正则扫描（轻量级），精度足够覆盖 bun-types 现有结构。
 * 若后续需精确 AST 解析，可替换为 ts-morph 版本而不改变调用接口。
 */

// 模块命名空间前缀提取
const NS_BUN_RE = /declare\s+(?:global\s+)?namespace\s+Bun\s*\{/g
const NS_NODE_RE = /declare\s+module\s+['"]node:([^'"]+)['"]\s*\{/g
const EXPORT_MEMBER_RE = /export\s+(?:declare\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g
const TOP_EXPORT_RE = /^\s*export\s+declare\s+(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/gm

/**
 * 从单个 .d.ts 文件内容中提取符号列表。
 */
export function scanDtsContent(content: string, fileName: string): string[] {
  const symbols: string[] = []

  // 1. 顶层 export 声明
  for (const match of content.matchAll(TOP_EXPORT_RE)) {
    symbols.push(match[1])
  }

  // 2. `namespace Bun { ... }` 内的 export（粗略提取：不处理嵌套大括号深度）
  const bunNsContent = extractNamespaceBody(content, 'Bun')
  if (bunNsContent) {
    for (const match of bunNsContent.matchAll(EXPORT_MEMBER_RE)) {
      symbols.push(`Bun.${match[1]}`)
    }
  }

  // 3. `declare module 'node:<mod>' { ... }` 内的 export
  for (const nsMatch of content.matchAll(NS_NODE_RE)) {
    const modName = nsMatch[1]
    // 找到 nsMatch.index 之后的第一个 { ... } 块
      const body = extractBlockAfter(content, nsMatch.index! + nsMatch[0].length - 1)
    if (body) {
      for (const match of body.matchAll(EXPORT_MEMBER_RE)) {
        symbols.push(`node:${modName}.${match[1]}`)
      }
    }
  }

  // 去重
  return [...new Set(symbols)]
}

// ── 辅助工具 ──────────────────────────────────────────────────────────────────

function extractNamespaceBody(content: string, nsName: string): string | null {
  const re = new RegExp(`declare\\s+(?:global\\s+)?namespace\\s+${nsName}\\s*\\{`)
  const match = re.exec(content)
  if (!match) return null
  return extractBlockAfter(content, match.index + match[0].length - 1)
}

function extractBlockAfter(content: string, fromIndex: number): string | null {
  let depth = 0
  let start = -1
  for (let i = fromIndex; i < content.length; i++) {
    if (content[i] === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (content[i] === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        return content.slice(start, i)
      }
    }
  }
  return null
}
