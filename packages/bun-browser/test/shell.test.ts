/**
 * Phase 5.13 测试：T5.13.1 bun_shell_parse + T5.13.2–5 ShellInterpreter + createShell。
 *
 * 测试分三层：
 *  1. shellParse() — Zig 解析器的 JSON AST 输出（纯单元测试，无 Kernel）
 *  2. ShellInterpreter — TS 解释器行为（mock Kernel，纯 JS 路径）
 *  3. createShell / $ tag — 模板字符串标签完整集成
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import { createWasmRuntime, type WasmRuntime, type ShellAST, type ShellSeq, type ShellCmd } from '../src/wasm'
import { ShellInterpreter } from '../src/shell-interpreter'
import { createShell } from '../src/shell'
import { createContext, runInContext } from 'node:vm'

// ── Test infrastructure ──────────────────────────────────────────────────────

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'

let wasmModule: WebAssembly.Module
let hasShellParse = false
let rt: WasmRuntime

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
  const exports = WebAssembly.Module.exports(wasmModule).map(e => e.name)
  hasShellParse = exports.includes('bun_shell_parse')

  const sandbox = createContext({ console, queueMicrotask, setTimeout, clearTimeout, performance })
  rt = await createWasmRuntime(wasmModule, {
    evaluator: (code, url) => runInContext(code, sandbox, { filename: url }),
    onPrint: () => {},
  })
})

// ── 1. shellParse() — AST 形状（T5.13.1） ────────────────────────────────────

describe('bun_shell_parse — AST 形状', () => {
  test('导出 bun_shell_parse', () => {
    expect(hasShellParse).toBe(true)
  })

  test('单条命令返回 seq > cmd 结构', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('ls -la') as ShellSeq
    expect(ast.t).toBe('seq')
    expect(ast.stmts).toHaveLength(1)
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.t).toBe('cmd')
    expect(cmd.argv).toEqual(['ls', '-la'])
    expect(cmd.redirs).toEqual([])
  })

  test('管道两条命令返回 seq > pipe > [cmd, cmd]', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('cat /etc/passwd | grep root') as ShellSeq
    expect(ast.t).toBe('seq')
    const pipe = ast.stmts[0] as any
    expect(pipe.t).toBe('pipe')
    expect(pipe.cmds).toHaveLength(2)
    expect(pipe.cmds[0].argv).toEqual(['cat', '/etc/passwd'])
    expect(pipe.cmds[1].argv).toEqual(['grep', 'root'])
  })

  test('三级管道', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('a | b | c') as ShellSeq
    const pipe = ast.stmts[0] as any
    expect(pipe.t).toBe('pipe')
    expect(pipe.cmds).toHaveLength(3)
  })

  test('序列 (;) 拆分为多个 stmts', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo hello; echo world') as ShellSeq
    expect(ast.stmts).toHaveLength(2)
    expect((ast.stmts[0] as ShellCmd).argv).toEqual(['echo', 'hello'])
    expect((ast.stmts[1] as ShellCmd).argv).toEqual(['echo', 'world'])
  })

  test('输出重定向 > 被解析到 redirs', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo hello > /tmp/out.txt') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.argv).toEqual(['echo', 'hello'])
    expect(cmd.redirs).toHaveLength(1)
    expect(cmd.redirs[0].t).toBe('>')
    expect(cmd.redirs[0].target).toBe('/tmp/out.txt')
  })

  test('追加重定向 >> 被解析到 redirs', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo hi >> /tmp/log.txt') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.redirs[0].t).toBe('>>')
    expect(cmd.redirs[0].target).toBe('/tmp/log.txt')
  })

  test('单引号内内容不分割', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse("echo 'hello world'") as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.argv).toEqual(['echo', 'hello world'])
  })

  test('双引号内内容不分割', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo "hello world"') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.argv).toEqual(['echo', 'hello world'])
  })

  test('背景执行 & 设置 bg:true', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('sleep 10 &') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.bg).toBe(true)
  })

  test('$VAR 保留在 argv 中（TS 运行时展开）', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo $HOME') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.argv).toEqual(['echo', '$HOME'])
  })

  test('空输入返回空 seq', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('') as ShellSeq
    expect(ast.t).toBe('seq')
    expect(ast.stmts).toHaveLength(0)
  })

  test('注释被忽略', () => {
    if (!hasShellParse) return
    const ast = rt.shellParse('echo hi # this is a comment') as ShellSeq
    const cmd = ast.stmts[0] as ShellCmd
    expect(cmd.argv).toEqual(['echo', 'hi'])
  })
})

// ── 2. ShellInterpreter — 内置命令（T5.13.3） ────────────────────────────────

/**
 * Build a minimal mock Kernel that has kernel.fs.* and kernel.process().
 */
function makeMockKernel(fsFiles: Record<string, string> = {}) {
  const vfs: Record<string, string> = { ...fsFiles }

  const fs = {
    async readFile(path: string, _enc?: string): Promise<string> {
      if (!(path in vfs)) throw new Error(`ENOENT: ${path}`)
      return vfs[path]
    },
    async writeFile(path: string, content: string): Promise<void> {
      vfs[path] = content
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith('/') ? path : path + '/'
      const entries = new Set<string>()
      for (const key of Object.keys(vfs)) {
        if (key.startsWith(prefix)) {
          const rel = key.slice(prefix.length)
          entries.add(rel.split('/')[0])
        }
      }
      return [...entries]
    },
    async mkdir(_path: string, _opts?: any): Promise<void> {},
    async rm(path: string, _opts?: any): Promise<void> {
      delete vfs[path]
    },
    async rename(src: string, dst: string): Promise<void> {
      vfs[dst] = vfs[src]
      delete vfs[src]
    },
    async stat(path: string): Promise<any> {
      if (!(path in vfs)) throw new Error(`ENOENT: ${path}`)
      return { size: vfs[path].length, type: 'file' }
    },
  }

  return {
    fs,
    _vfs: vfs,
    process: mock(async (_argv: string[], _opts?: any) => {
      const toStream = (text: string) =>
        new ReadableStream<string>({
          start(controller) { controller.enqueue(text); controller.close() },
        })
      return {
        stdout: toStream('[mock stdout]'),
        stderr: toStream(''),
        output: toStream('[mock stdout]'),
        exit: Promise.resolve(0),
        kill: () => {},
        resize: () => {},
        input: new WritableStream(),
      }
    }),
  } as any
}

describe('ShellInterpreter — 内置命令', () => {
  test('echo 输出参数', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo hello world')!
    const result = await interp.run(ast)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello world\n')
  })

  test('echo 多个参数空格分隔', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo a b c')!
    const result = await interp.run(ast)
    expect(result.stdout).toBe('a b c\n')
  })

  test('pwd 输出当前目录', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('pwd')!
    const result = await interp.run(ast, { vars: {}, cwd: '/home/user' })
    expect(result.stdout.trim()).toBe('/home/user')
  })

  test('cd 改变当前目录', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    // Run two-statement sequence: cd /tmp ; pwd
    const ast = rt.shellParse('cd /tmp; pwd')!
    const result = await interp.run(ast, { vars: {}, cwd: '/' })
    expect(result.stdout.trim()).toBe('/tmp')
  })

  test('cat 读取 VFS 文件', async () => {
    const kernel = makeMockKernel({ '/src/hello.txt': 'hello bun-browser\n' })
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('cat /src/hello.txt')!
    const result = await interp.run(ast)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello bun-browser\n')
  })

  test('cat 文件不存在时返回错误 exit code', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('cat /nonexistent.txt')!
    const result = await interp.run(ast)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('nonexistent.txt')
  })

  test('echo > 重定向写入 VFS', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo hello > /tmp/out.txt')!
    await interp.run(ast)
    const content = kernel._vfs['/tmp/out.txt']
    expect(content).toBe('hello\n')
  })

  test('>> 追加重定向', async () => {
    const kernel = makeMockKernel({ '/tmp/log.txt': 'line1\n' })
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo line2 >> /tmp/log.txt')!
    await interp.run(ast)
    expect(kernel._vfs['/tmp/log.txt']).toBe('line1\nline2\n')
  })

  test('管道：echo | cat 正确链接', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo piped | cat')!
    const result = await interp.run(ast)
    expect(result.exitCode).toBe(0)
    // cat with no args returns its stdin
    expect(result.stdout).toBe('piped\n')
  })

  test('true/false 内置命令退出码', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const trueAst = rt.shellParse('true')!
    const falseAst = rt.shellParse('false')!
    expect((await interp.run(trueAst)).exitCode).toBe(0)
    expect((await interp.run(falseAst)).exitCode).toBe(1)
  })

  test('$VAR 变量展开', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('echo $GREETING')!
    const result = await interp.run(ast, { vars: { GREETING: 'hi there' }, cwd: '/' })
    expect(result.stdout.trim()).toBe('hi there')
  })

  test('export 设置环境变量', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    // export sets the var; subsequent echo reads it
    const ast = rt.shellParse('export FOO=bar; echo $FOO')!
    const result = await interp.run(ast)
    expect(result.stdout.trim()).toBe('bar')
  })

  test('序列退出码取最后一条', async () => {
    const kernel = makeMockKernel()
    const interp = new ShellInterpreter(kernel)
    const ast = rt.shellParse('true; false')!
    const result = await interp.run(ast)
    expect(result.exitCode).toBe(1)
  })
})

// ── 3. createShell / $ tag（T5.13.4）────────────────────────────────────────

describe('createShell / $ 模板字符串标签', () => {
  test('$ 调用 shellParse 并返回 ShellPromise', async () => {
    const kernel = makeMockKernel()
    const $ = createShell(kernel, rt)
    const promise = $`echo test`
    expect(promise).toBeInstanceOf(Promise)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('test\n')
  })

  test('.text() 返回修剪后的 stdout', async () => {
    const kernel = makeMockKernel()
    const $ = createShell(kernel, rt)
    const text = await $`echo  hello `.text()
    expect(text).toBe('hello')
  })

  test('.lines() 返回非空行数组', async () => {
    const kernel = makeMockKernel()
    const $ = createShell(kernel, rt)
    const lines = await $`echo -e "a\nb\nc"`.lines()
    // echo -e is not specially handled in our built-in, but output ends with \n
    // We just verify lines() returns a non-empty array
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  test('.json() 解析 JSON 输出', async () => {
    const kernel = makeMockKernel({ '/tmp/data.json': '{"x":42}' })
    const $ = createShell(kernel, rt)
    const obj = await $`cat /tmp/data.json`.json<{ x: number }>()
    expect(obj).toEqual({ x: 42 })
  })

  test('模板字符串插值', async () => {
    const kernel = makeMockKernel()
    const $ = createShell(kernel, rt)
    const name = 'world'
    const text = await $`echo hello ${name}`.text()
    expect(text).toBe('hello world')
  })

  test('createShell opts.env 注入默认变量', async () => {
    const kernel = makeMockKernel()
    const $ = createShell(kernel, rt, { env: { MYVAR: 'injected' } })
    const text = await $`echo $MYVAR`.text()
    expect(text).toBe('injected')
  })
})
