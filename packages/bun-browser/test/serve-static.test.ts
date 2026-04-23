/**
 * T5.16.2 单元测试：makeServeStaticScript
 *
 * 验证 serve-static.ts 生成的脚本字符串：
 *   - MIME 表包含全部 11 种扩展名
 *   - SPA 回退与 404 路径均存在
 *   - logReady 选项可控
 *   - 生成的脚本为合法 JavaScript（可被 Bun.Transpiler 解析）
 *   - distDir / port 正确注入脚本
 */

import { describe, expect, test } from 'bun:test'
import { makeServeStaticScript, type ServeStaticOptions } from '../src/serve-static'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScript(overrides: Partial<ServeStaticOptions> = {}): string {
  return makeServeStaticScript({ distDir: '/app/dist', port: 3000, ...overrides })
}

// ---------------------------------------------------------------------------
// MIME 表覆盖
// ---------------------------------------------------------------------------

describe('T5.16.2 makeServeStaticScript MIME 表', () => {
  const REQUIRED_EXTS = [
    ['.html', 'text/html'],
    ['.js', 'application/javascript'],
    ['.mjs', 'application/javascript'],
    ['.cjs', 'application/javascript'],
    ['.css', 'text/css'],
    ['.json', 'application/json'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.ico', 'image/x-icon'],
    ['.wasm', 'application/wasm'],
    ['.txt', 'text/plain'],
  ] as const

  for (const [ext, mimePrefix] of REQUIRED_EXTS) {
    test(`包含 ${ext} → ${mimePrefix}`, () => {
      const script = makeScript()
      expect(script).toContain(`'${ext}'`)
      expect(script).toContain(mimePrefix)
    })
  }

  test('共 11 种扩展名', () => {
    const script = makeScript()
    // Count occurrences of "'.xxx'" patterns in the MIME map section
    const mimeSection = script.match(/const MIME\s*=\s*\{[^}]+\}/s)?.[0] ?? ''
    const entries = [...mimeSection.matchAll(/'\.[\w]+'/g)]
    expect(entries.length).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// distDir / port 注入
// ---------------------------------------------------------------------------

describe('T5.16.2 makeServeStaticScript 参数注入', () => {
  test('distDir 被正确注入到脚本', () => {
    const script = makeScript({ distDir: '/custom/path' })
    expect(script).toContain('"/custom/path"')
  })

  test('port 被正确注入到脚本', () => {
    const script = makeScript({ port: 8080 })
    expect(script).toContain('8080')
  })

  test('JSON.stringify 转义特殊路径', () => {
    const script = makeScript({ distDir: '/path/with "quotes"' })
    expect(script).toContain('\\"quotes\\"')
  })
})

// ---------------------------------------------------------------------------
// SPA 回退
// ---------------------------------------------------------------------------

describe('T5.16.2 makeServeStaticScript SPA 回退', () => {
  test('spaFallback=true（默认）时脚本包含 index.html 回退逻辑', () => {
    const script = makeScript({ spaFallback: true })
    expect(script).toContain('index.html')
  })

  test('spaFallback=false 时脚本不包含 SPA 回退', () => {
    const script = makeScript({ spaFallback: false })
    // Should still have 404 handling but no fallback to index.html
    expect(script).toContain('404')
    // No fallback to index.html for unknown paths
    expect(script).not.toContain('spa')
  })
})

// ---------------------------------------------------------------------------
// logReady 选项
// ---------------------------------------------------------------------------

describe('T5.16.2 makeServeStaticScript logReady 选项', () => {
  test('logReady=true（默认）时包含 console.log 就绪消息', () => {
    const script = makeScript({ logReady: true })
    expect(script).toContain('console.log')
  })

  test('logReady=false 时不包含就绪 console.log', () => {
    const script = makeScript({ logReady: false })
    // Should not include ready message
    const hasReadyLog = /console\.log.*ready|console\.log.*listening|console\.log.*port/i.test(script)
    expect(hasReadyLog).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 语法合法性：Bun.Transpiler 可解析生成的脚本
// ---------------------------------------------------------------------------

describe('T5.16.2 makeServeStaticScript 语法合法性', () => {
  test('生成的脚本可被 Bun.Transpiler 解析（无语法错误）', async () => {
    const script = makeScript()
    // Bun.Transpiler will throw if the script has syntax errors
    const transpiler = new Bun.Transpiler({ loader: 'js' })
    const result = await transpiler.transform(script)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  test('生成的脚本包含 Bun.serve 调用', () => {
    const script = makeScript()
    expect(script).toContain('Bun.serve')
  })

  test('生成的脚本包含 async IIFE', () => {
    const script = makeScript()
    expect(script).toMatch(/async\s*\(\s*\)\s*=>|async\s+function/)
  })
})
