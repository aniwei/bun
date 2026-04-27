/**
 * M2-1/M2-2 resolver 集成测试
 *
 * 运行方式：
 *   bun test test/integration/bun-in-browser/m2-resolver.test.ts
 *
 * 验收标准：
 *   - 相对路径解析（带/不带扩展名、目录 index）
 *   - 绝对路径解析
 *   - 裸包名解析（node_modules walk-up）
 *   - package.json exports 字段解析（条件导出、子路径、模式匹配）
 *   - package.json imports 字段（`#` 前缀）
 *   - tsconfig paths / baseUrl 映射
 */

import { test, expect, describe } from 'vitest'
import { resolve, resolveExports, resolveImports } from '../../../packages/bun-web-resolver/src/resolve'
import { createTsconfigPathResolver } from '../../../packages/bun-web-resolver/src/tsconfig-paths'
import type { ResolverFs } from '../../../packages/bun-web-resolver/src/resolve'

// ─────────────────────────────────────────────────────────────────────────────
// 测试用虚拟文件系统
// ─────────────────────────────────────────────────────────────────────────────

function makeFs(files: Record<string, string>): ResolverFs {
  return {
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => files[path] ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveExports 单元测试
// ─────────────────────────────────────────────────────────────────────────────

describe('M2-1: resolveExports', () => {
  test('字符串形式 exports', () => {
    expect(resolveExports('./index.js', '.', ['import'])).toBe('./index.js')
    expect(resolveExports('./index.js', './utils', ['import'])).toBeNull()
  })

  test('条件导出 — 单层', () => {
    const exports = {
      browser: './browser.js',
      import: './index.mjs',
      require: './index.cjs',
      default: './index.js',
    }
    expect(resolveExports(exports, '.', ['browser', 'import', 'default'])).toBe('./browser.js')
    expect(resolveExports(exports, '.', ['import', 'default'])).toBe('./index.mjs')
    expect(resolveExports(exports, '.', ['default'])).toBe('./index.js')
  })

  test('子路径 exports', () => {
    const exports = {
      '.': './index.js',
      './utils': './utils.js',
      './internal': null,
    }
    expect(resolveExports(exports, '.', ['default'])).toBe('./index.js')
    expect(resolveExports(exports, './utils', ['default'])).toBe('./utils.js')
    expect(resolveExports(exports, './internal', ['default'])).toBeNull()
    expect(resolveExports(exports, './missing', ['default'])).toBeNull()
  })

  test('子路径 + 条件组合', () => {
    const exports = {
      '.': {
        import: './index.mjs',
        require: './index.cjs',
        default: './index.js',
      },
      './utils': {
        browser: './utils.browser.js',
        default: './utils.js',
      },
    }
    expect(resolveExports(exports, '.', ['import', 'default'])).toBe('./index.mjs')
    expect(resolveExports(exports, './utils', ['browser', 'default'])).toBe('./utils.browser.js')
    expect(resolveExports(exports, './utils', ['default'])).toBe('./utils.js')
  })

  test('模式匹配 exports (* 通配符)', () => {
    const exports = {
      '.': './index.js',
      './features/*': './src/features/*.js',
      './plugins/*': {
        browser: './browser/plugins/*.js',
        default: './plugins/*.js',
      },
    }
    expect(resolveExports(exports, './features/auth', ['default'])).toBe('./src/features/auth.js')
    expect(resolveExports(exports, './features/auth/login', ['default'])).toBe(
      './src/features/auth/login.js',
    )
    expect(resolveExports(exports, './plugins/redis', ['browser', 'default'])).toBe(
      './browser/plugins/redis.js',
    )
    expect(resolveExports(exports, './plugins/redis', ['default'])).toBe('./plugins/redis.js')
  })

  test('嵌套条件数组（fallback）', () => {
    const exports = {
      '.': [
        { worker: './worker.js' },
        { browser: './browser.js' },
        './fallback.js',
      ],
    }
    expect(resolveExports(exports, '.', ['worker'])).toBe('./worker.js')
    expect(resolveExports(exports, '.', ['browser'])).toBe('./browser.js')
    expect(resolveExports(exports, '.', ['default'])).toBe('./fallback.js')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveImports 单元测试
// ─────────────────────────────────────────────────────────────────────────────

describe('M2-1: resolveImports', () => {
  test('精确匹配 imports', () => {
    const imports = {
      '#utils': './src/utils.js',
      '#env': {
        browser: './browser-env.js',
        default: './env.js',
      },
    }
    expect(resolveImports(imports, '#utils', ['default'])).toBe('./src/utils.js')
    expect(resolveImports(imports, '#env', ['browser', 'default'])).toBe('./browser-env.js')
    expect(resolveImports(imports, '#missing', ['default'])).toBeNull()
  })

  test('模式匹配 imports', () => {
    const imports = {
      '#internal/*': './src/internal/*.js',
    }
    expect(resolveImports(imports, '#internal/helpers', ['default'])).toBe(
      './src/internal/helpers.js',
    )
    expect(resolveImports(imports, '#other', ['default'])).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolve() 集成测试
// ─────────────────────────────────────────────────────────────────────────────

describe('M2-1: resolve() 相对路径', () => {
  const fs = makeFs({
    '/project/src/utils.ts': 'export {}',
    '/project/src/index.ts': 'export {}',
    '/project/src/helpers/index.ts': 'export {}',
    '/project/src/data.json': '{}',
  })

  const opts = { fs }

  test('相对路径精确匹配（带扩展名）', () => {
    expect(resolve('./utils.ts', '/project/src/app.ts', opts)).toBe('/project/src/utils.ts')
  })

  test('相对路径省略扩展名', () => {
    expect(resolve('./utils', '/project/src/app.ts', opts)).toBe('/project/src/utils.ts')
  })

  test('相对路径目录 index', () => {
    expect(resolve('./helpers', '/project/src/app.ts', opts)).toBe('/project/src/helpers/index.ts')
  })

  test('父路径 ../', () => {
    expect(resolve('../src/utils', '/project/lib/app.ts', opts)).toBe('/project/src/utils.ts')
  })

  test('JSON 扩展名', () => {
    expect(resolve('./data.json', '/project/src/app.ts', opts)).toBe('/project/src/data.json')
  })

  test('不存在的路径返回 null', () => {
    expect(resolve('./nonexistent', '/project/src/app.ts', opts)).toBeNull()
  })
})

describe('M2-1: resolve() 绝对路径', () => {
  const fs = makeFs({
    '/lib/shared.ts': 'export {}',
  })

  test('绝对路径解析', () => {
    expect(resolve('/lib/shared.ts', '/anywhere/file.ts', { fs })).toBe('/lib/shared.ts')
    expect(resolve('/lib/shared', '/anywhere/file.ts', { fs })).toBe('/lib/shared.ts')
  })
})

describe('M2-1: resolve() 裸包名 (node_modules)', () => {
  const fs = makeFs({
    // 包含 exports 字段的包
    '/project/node_modules/react/package.json': JSON.stringify({
      name: 'react',
      exports: {
        '.': {
          browser: './browser.development.js',
          import: './index.mjs',
          default: './index.js',
        },
        './jsx-runtime': './jsx-runtime.js',
      },
    }),
    '/project/node_modules/react/index.mjs': 'export {}',
    '/project/node_modules/react/browser.development.js': 'export {}',
    '/project/node_modules/react/jsx-runtime.js': 'export {}',

    // 无 exports 字段，走 main 字段
    '/project/node_modules/lodash/package.json': JSON.stringify({
      name: 'lodash',
      main: './lodash.js',
    }),
    '/project/node_modules/lodash/lodash.js': 'module.exports = {}',

    // 无 exports 也无 main，走 index
    '/project/node_modules/simple/package.json': JSON.stringify({ name: 'simple' }),
    '/project/node_modules/simple/index.ts': 'export {}',

    // scoped 包
    '/project/node_modules/@scope/pkg/package.json': JSON.stringify({
      name: '@scope/pkg',
      exports: { '.': './index.js' },
    }),
    '/project/node_modules/@scope/pkg/index.js': 'export {}',
  })

  const opts = { fs, conditions: ['browser', 'import', 'default'] }

  test('有 exports 的包 — browser 条件', () => {
    expect(resolve('react', '/project/src/app.ts', opts)).toBe(
      '/project/node_modules/react/browser.development.js',
    )
  })

  test('有 exports 的包 — import 条件', () => {
    const result = resolve('react', '/project/src/app.ts', {
      fs,
      conditions: ['import', 'default'],
    })
    expect(result).toBe('/project/node_modules/react/index.mjs')
  })

  test('子路径导出', () => {
    expect(resolve('react/jsx-runtime', '/project/src/app.ts', opts)).toBe(
      '/project/node_modules/react/jsx-runtime.js',
    )
  })

  test('无 exports 走 main 字段', () => {
    expect(resolve('lodash', '/project/src/app.ts', opts)).toBe(
      '/project/node_modules/lodash/lodash.js',
    )
  })

  test('无 exports 无 main 走 index', () => {
    expect(resolve('simple', '/project/src/app.ts', opts)).toBe(
      '/project/node_modules/simple/index.ts',
    )
  })

  test('scoped 包解析', () => {
    expect(resolve('@scope/pkg', '/project/src/app.ts', opts)).toBe(
      '/project/node_modules/@scope/pkg/index.js',
    )
  })

  test('不存在的包返回 null', () => {
    expect(resolve('nonexistent-pkg', '/project/src/app.ts', opts)).toBeNull()
  })
})

describe('M2-1: resolve() node_modules walk-up', () => {
  const fs = makeFs({
    // 包只在根级 node_modules
    '/node_modules/shared/package.json': JSON.stringify({
      name: 'shared',
      exports: { '.': './index.js' },
    }),
    '/node_modules/shared/index.js': 'export {}',
  })

  test('从深层目录 walk-up 找到根 node_modules', () => {
    const result = resolve('shared', '/project/deeply/nested/file.ts', { fs })
    expect(result).toBe('/node_modules/shared/index.js')
  })
})

describe('M2-1: resolve() imports 字段 (#-prefixed)', () => {
  const fs = makeFs({
    '/project/package.json': JSON.stringify({
      name: 'my-app',
      imports: {
        '#utils': './src/utils.ts',
        '#internal/*': './src/internal/*.ts',
        '#env': {
          browser: './src/env.browser.ts',
          default: './src/env.ts',
        },
      },
    }),
    '/project/src/utils.ts': 'export {}',
    '/project/src/internal/helpers.ts': 'export {}',
    '/project/src/env.browser.ts': 'export {}',
    '/project/src/env.ts': 'export {}',
  })

  const opts = { fs, conditions: ['browser', 'default'] }

  test('精确 # 映射', () => {
    expect(resolve('#utils', '/project/src/app.ts', opts)).toBe('/project/src/utils.ts')
  })

  test('条件 # 映射', () => {
    expect(resolve('#env', '/project/src/app.ts', opts)).toBe('/project/src/env.browser.ts')
  })

  test('模式 # 映射', () => {
    expect(resolve('#internal/helpers', '/project/src/app.ts', opts)).toBe(
      '/project/src/internal/helpers.ts',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// createTsconfigPathResolver 测试
// ─────────────────────────────────────────────────────────────────────────────

describe('M2-2: createTsconfigPathResolver', () => {
  test('精确 paths 映射', () => {
    const resolver = createTsconfigPathResolver({
      baseUrl: '/project/src',
      paths: {
        '@app/config': ['./config/index.ts'],
      },
    })
    expect(resolver.resolve('@app/config')).toEqual(['/project/src/config/index.ts'])
  })

  test('通配符 paths 映射', () => {
    const resolver = createTsconfigPathResolver({
      baseUrl: '/project/src',
      paths: {
        '@/*': ['./*'],
      },
    })
    expect(resolver.resolve('@/components/Button')).toEqual(['/project/src/components/Button'])
    expect(resolver.resolve('@/utils/format')).toEqual(['/project/src/utils/format'])
  })

  test('多候选 paths', () => {
    const resolver = createTsconfigPathResolver({
      baseUrl: '/project',
      paths: {
        'shared/*': ['packages/shared/src/*', 'node_modules/shared/dist/*'],
      },
    })
    const results = resolver.resolve('shared/utils')
    expect(results).toEqual([
      '/project/packages/shared/src/utils',
      '/project/node_modules/shared/dist/utils',
    ])
  })

  test('baseUrl 回退（无 paths 命中）', () => {
    const resolver = createTsconfigPathResolver({
      baseUrl: '/project/src',
      paths: {
        '@/*': ['./*'],
      },
    })
    // 无 paths 匹配时使用 baseUrl
    expect(resolver.resolve('utils/helpers')).toEqual(['/project/src/utils/helpers'])
  })

  test('相对路径不受 paths 影响', () => {
    const resolver = createTsconfigPathResolver({
      baseUrl: '/project/src',
      paths: { '@/*': ['./*'] },
    })
    expect(resolver.resolve('./local')).toEqual([])
    expect(resolver.resolve('../sibling')).toEqual([])
  })

  test('无 baseUrl 时只匹配 paths', () => {
    const resolver = createTsconfigPathResolver({
      paths: { 'alias': ['./actual.ts'] },
    })
    expect(resolver.resolve('alias')).toEqual(['./actual.ts'])
    // 无 baseUrl 且无 paths 命中
    expect(resolver.resolve('unknown')).toEqual([])
  })

  test('空配置返回空', () => {
    const resolver = createTsconfigPathResolver({})
    expect(resolver.resolve('anything')).toEqual([])
  })
})
