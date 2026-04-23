#!/usr/bin/env bun
/**
 * T5.15.2 — WASM shim JSC 依赖追踪脚本
 *
 * 扫描 `src/bun_browser_runtime/` 和 `src/bun_browser_standalone.zig`，
 * 找出所有对 JSC / bun 内部 API 的引用，并输出 Markdown 格式报告。
 *
 * 用法：
 *   bun run scripts/audit-wasm-shim.ts
 *   bun run scripts/audit-wasm-shim.ts --json    # JSON 输出
 *   bun run scripts/audit-wasm-shim.ts --csv     # CSV 输出
 *
 * 检测模式：
 *   - `@import("bun")` — 引入 Bun 内部 Zig 模块
 *   - `bun.jsc.*` — 调用 JSC API
 *   - `JSGlobalObject` — 直接使用 JSC 全局对象
 *   - `jsi_thread_capability` / `jsi_thread_spawn` — WASM/JSC 线程桥接
 *   - `AsyncHTTP` — Bun 内部 HTTP 客户端
 *   - `comptime.*@import.*` — 编译时 JSC 模块引用
 */

import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'

interface Finding {
  file: string
  line: number
  col: number
  pattern: string
  snippet: string
  category: 'jsc-api' | 'bun-import' | 'thread-bridge' | 'async-http' | 'other'
}

interface AuditResult {
  generatedAt: string
  wasmSize: { standard: number | null; threads: number | null }
  findings: Finding[]
  summary: Record<string, number>
}

// ---------------------------------------------------------------------------
// 扫描模式
// ---------------------------------------------------------------------------

const PATTERNS: Array<{ pattern: RegExp; label: string; category: Finding['category'] }> = [
  { pattern: /@import\("bun"\)/g, label: '@import("bun")', category: 'bun-import' },
  { pattern: /\bbun\.jsc\b/g, label: 'bun.jsc', category: 'jsc-api' },
  { pattern: /\bJSGlobalObject\b/g, label: 'JSGlobalObject', category: 'jsc-api' },
  { pattern: /\bJSC\b/g, label: 'JSC (namespace)', category: 'jsc-api' },
  { pattern: /\bjsi_thread_capability\b/g, label: 'jsi_thread_capability', category: 'thread-bridge' },
  { pattern: /\bjsi_thread_spawn\b/g, label: 'jsi_thread_spawn', category: 'thread-bridge' },
  { pattern: /\bjsi_thread_wait\b/g, label: 'jsi_thread_wait', category: 'thread-bridge' },
  { pattern: /\bAsyncHTTP\b/g, label: 'AsyncHTTP', category: 'async-http' },
]

// ---------------------------------------------------------------------------
// WASM 体积读取
// ---------------------------------------------------------------------------

async function readWasmSize(filePath: string): Promise<number | null> {
  try {
    const stat = await Bun.file(filePath).size
    return stat
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 文件扫描
// ---------------------------------------------------------------------------

async function scanFile(filePath: string, rootDir: string): Promise<Finding[]> {
  const findings: Finding[] = []
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return findings
  }
  const lines = content.split('\n')
  const relPath = relative(rootDir, filePath)

  for (const { pattern, label, category } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const re = new RegExp(pattern.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        findings.push({
          file: relPath,
          line: i + 1,
          col: m.index + 1,
          pattern: label,
          snippet: line.trim().slice(0, 100),
          category,
        })
      }
    }
  }
  return findings
}

async function scanDirectory(dirPath: string, rootDir: string, ext = '.zig'): Promise<Finding[]> {
  const findings: Finding[] = []
  let entries: string[]
  try {
    entries = await readdir(dirPath)
  } catch {
    return findings
  }
  for (const entry of entries) {
    if (entry.endsWith(ext)) {
      const sub = await scanFile(join(dirPath, entry), rootDir)
      findings.push(...sub)
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const isJson = args.includes('--json')
  const isCsv = args.includes('--csv')

  const rootDir = join(import.meta.dir, '..')
  const runtimeDir = join(rootDir, 'src', 'bun_browser_runtime')
  const standaloneFile = join(rootDir, 'src', 'bun_browser_standalone.zig')
  const wasmDir = join(rootDir, 'packages', 'bun-browser')

  const [runtimeFindings, standaloneFindings, wasmStdSize, wasmThreadsSize] = await Promise.all([
    scanDirectory(runtimeDir, rootDir),
    scanFile(standaloneFile, rootDir),
    readWasmSize(join(wasmDir, 'bun-core.wasm')),
    readWasmSize(join(wasmDir, 'bun-core.threads.wasm')),
  ])

  const findings: Finding[] = [...runtimeFindings, ...standaloneFindings]
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const summary: Record<string, number> = {}
  for (const f of findings) {
    summary[f.pattern] = (summary[f.pattern] ?? 0) + 1
  }

  const result: AuditResult = {
    generatedAt: new Date().toISOString(),
    wasmSize: { standard: wasmStdSize, threads: wasmThreadsSize },
    findings,
    summary,
  }

  if (isJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (isCsv) {
    console.log('file,line,col,pattern,category,snippet')
    for (const f of findings) {
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
      console.log([esc(f.file), f.line, f.col, esc(f.pattern), f.category, esc(f.snippet)].join(','))
    }
    return
  }

  // Default: Markdown output
  const fmt = (n: number | null) =>
    n !== null ? `${(n / 1024).toFixed(1)} KB (${n.toLocaleString()} bytes)` : '_not found_'

  console.log('# WASM Shim JSC 依赖审计报告')
  console.log()
  console.log(`> 生成时间：${result.generatedAt}`)
  console.log()
  console.log('## WASM 体积')
  console.log()
  console.log(`| 文件 | 大小 |`)
  console.log(`|------|------|`)
  console.log(`| \`bun-core.wasm\` (标准) | ${fmt(wasmStdSize)} |`)
  console.log(`| \`bun-core.threads.wasm\` (多线程) | ${fmt(wasmThreadsSize)} |`)
  console.log()
  console.log('## 依赖概览')
  console.log()
  console.log(`| 模式 | 引用次数 |`)
  console.log(`|------|----------|`)
  for (const [pat, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.log(`| \`${pat}\` | ${count} |`)
  }
  console.log()

  if (findings.length === 0) {
    console.log('## 详细发现\n\n_无 JSC 依赖引用。_')
    return
  }

  console.log('## 详细发现')
  console.log()

  const byFile = new Map<string, Finding[]>()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file)!.push(f)
  }

  for (const [file, fList] of byFile) {
    console.log(`### \`${file}\``)
    console.log()
    console.log('| 行 | 列 | 模式 | 分类 | 代码片段 |')
    console.log('|----|----|------|------|----------|')
    for (const f of fList) {
      const snippet = f.snippet.replace(/\|/g, '\\|')
      console.log(`| ${f.line} | ${f.col} | \`${f.pattern}\` | ${f.category} | \`${snippet}\` |`)
    }
    console.log()
  }

  console.log('---')
  console.log()
  console.log(`共发现 **${findings.length}** 处 JSC/Bun 内部依赖引用，涉及 **${byFile.size}** 个文件。`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
