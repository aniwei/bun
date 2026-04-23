/**
 * T5.11.3 / T5.11.4 集成测试：kernel.fs.* API + kernel.mount / kernel.exportFs
 *
 * 测试内容：
 *   - readFile(path) — 二进制 / UTF-8
 *   - readdir(path)  — 列举目录
 *   - stat(path)     — 文件/目录 stat
 *   - writeFile      — 通过 Kernel.writeFile 写入后可读出
 *   - mount(tree)    — WebContainer FileSystemTree 挂载
 *   - exportFs(path) — VFS → FileSystemTree 导出
 *   - fileSystemTreeToVfsFiles / vfsFilesToFileSystemTree 纯函数
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { Kernel } from '../src/kernel'
import { fileSystemTreeToVfsFiles, vfsFilesToFileSystemTree, parseSnapshot, buildSnapshot } from '../src/vfs-client'
import type { FileSystemTree } from '../src/vfs-client'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'
const WORKER_URL = new URL('../src/kernel-worker.ts', import.meta.url)

let wasmModule: WebAssembly.Module

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
})

// ──────────────────────────────────────────────────────────
// 纯函数：fileSystemTreeToVfsFiles / vfsFilesToFileSystemTree
// ──────────────────────────────────────────────────────────

describe('fileSystemTreeToVfsFiles', () => {
  test('平坦文件树 → VfsFile[]', () => {
    const tree: FileSystemTree = {
      'index.js': { file: { contents: 'console.log("hi")' } },
      'README.md': { file: { contents: 'hello' } },
    }
    const files = fileSystemTreeToVfsFiles(tree, '/app')
    expect(files).toHaveLength(2)
    const paths = files.map(f => f.path).sort()
    expect(paths).toEqual(['/app/README.md', '/app/index.js'])
  })

  test('嵌套目录树正确展平', () => {
    const tree: FileSystemTree = {
      src: {
        directory: {
          'index.ts': { file: { contents: 'export const x = 1' } },
          utils: {
            directory: {
              'math.ts': { file: { contents: 'export const add = (a:number,b:number)=>a+b' } },
            },
          },
        },
      },
      'package.json': { file: { contents: '{"name":"test"}' } },
    }
    const files = fileSystemTreeToVfsFiles(tree)
    const paths = files.map(f => f.path).sort()
    expect(paths).toContain('/src/index.ts')
    expect(paths).toContain('/src/utils/math.ts')
    expect(paths).toContain('/package.json')
    expect(files).toHaveLength(3)
  })

  test('默认前缀为根目录', () => {
    const tree: FileSystemTree = {
      foo: { file: { contents: 'bar' } },
    }
    const files = fileSystemTreeToVfsFiles(tree)
    expect(files[0].path).toBe('/foo')
  })
})

describe('vfsFilesToFileSystemTree', () => {
  test('VfsFile[] → FileSystemTree（带前缀过滤）', () => {
    const files = [
      { path: '/app/index.js', data: 'console.log(1)' },
      { path: '/app/src/util.ts', data: 'export {}' },
      { path: '/other/file.txt', data: 'not included' },
    ]
    const tree = vfsFilesToFileSystemTree(files, '/app')
    expect('index.js' in tree).toBe(true)
    expect('src' in tree).toBe(true)
    expect('other' in tree).toBe(false)
    const srcNode = tree['src']
    expect('directory' in srcNode).toBe(true)
    if ('directory' in srcNode) {
      expect('util.ts' in srcNode.directory).toBe(true)
    }
  })

  test('根前缀包含所有文件', () => {
    const files = [
      { path: '/a.txt', data: 'a' },
      { path: '/b/c.txt', data: 'c' },
    ]
    const tree = vfsFilesToFileSystemTree(files, '/')
    expect('a.txt' in tree).toBe(true)
    expect('b' in tree).toBe(true)
  })

  test('round-trip: tree → files → tree 完全一致', () => {
    const original: FileSystemTree = {
      'index.js': { file: { contents: 'hello' } },
      lib: {
        directory: {
          'util.js': { file: { contents: 'export const x = 1' } },
        },
      },
    }
    const vfsFiles = fileSystemTreeToVfsFiles(original)
    const restored = vfsFilesToFileSystemTree(vfsFiles)

    expect('index.js' in restored).toBe(true)
    expect('lib' in restored).toBe(true)
    if ('directory' in restored['lib']) {
      expect('util.js' in restored['lib'].directory).toBe(true)
    }
  })

  test('snapshot round-trip: buildSnapshot / parseSnapshot 保留内容', () => {
    const files = [
      { path: '/hello.txt', data: 'world', mode: 0o644 },
      { path: '/bin/run.sh', data: new Uint8Array([35, 33, 47, 98, 105, 110, 47, 115, 104]), mode: 0o755 },
    ]
    const snap = buildSnapshot(files)
    const parsed = parseSnapshot(snap)
    expect(parsed).toHaveLength(2)
    const txt = parsed.find(f => f.path === '/hello.txt')!
    expect(new TextDecoder().decode(txt.data as Uint8Array)).toBe('world')
    expect(txt.mode).toBe(0o644)
    const sh = parsed.find(f => f.path === '/bin/run.sh')!
    expect(sh.mode).toBe(0o755)
  })
})

// ──────────────────────────────────────────────────────────
// Kernel 集成：readFile / readdir / stat
// ──────────────────────────────────────────────────────────

describe('Kernel VFS fs API（集成）', () => {
  test('readFile — 写入后可以字节形式读回', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [{ path: '/test.txt', data: 'hello world' }],
    })
    try {
      await kernel.whenReady()
      const buf = await kernel.readFile('/test.txt')
      const text = new TextDecoder().decode(new Uint8Array(buf))
      expect(text).toBe('hello world')
    } finally {
      kernel.terminate()
    }
  })

  test('readFile encoding="utf8" 直接返回字符串', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [{ path: '/greeting.txt', data: 'こんにちは' }],
    })
    try {
      await kernel.whenReady()
      const text = await kernel.readFile('/greeting.txt', 'utf8')
      expect(text).toBe('こんにちは')
    } finally {
      kernel.terminate()
    }
  })

  test('readFile 不存在的文件 → reject ENOENT', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      await expect(kernel.readFile('/nonexistent.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      kernel.terminate()
    }
  })

  test('readdir — 列举目录条目', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [
        { path: '/project/src/index.ts', data: 'export {}' },
        { path: '/project/src/util.ts', data: 'export {}' },
        { path: '/project/package.json', data: '{}' },
      ],
    })
    try {
      await kernel.whenReady()
      const entries = await kernel.readdir('/project')
      const names = entries.map(e => e.name).sort()
      expect(names).toContain('src')
      expect(names).toContain('package.json')
      const pkgEntry = entries.find(e => e.name === 'package.json')!
      expect(pkgEntry.type).toBe('file')
      const srcEntry = entries.find(e => e.name === 'src')!
      expect(srcEntry.type).toBe('directory')
    } finally {
      kernel.terminate()
    }
  })

  test('readdir — 嵌套子目录', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [
        { path: '/app/a.js', data: '' },
        { path: '/app/b.js', data: '' },
      ],
    })
    try {
      await kernel.whenReady()
      const entries = await kernel.readdir('/app')
      const names = entries.map(e => e.name).sort()
      expect(names).toEqual(['a.js', 'b.js'])
    } finally {
      kernel.terminate()
    }
  })

  test('stat — 文件 stat', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [{ path: '/data.bin', data: new Uint8Array(32) }],
    })
    try {
      await kernel.whenReady()
      const s = await kernel.stat('/data.bin')
      expect(s.type).toBe('file')
      expect(s.size).toBe(32)
    } finally {
      kernel.terminate()
    }
  })

  test('stat — 目录 stat', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [{ path: '/dir/file.txt', data: 'x' }],
    })
    try {
      await kernel.whenReady()
      const s = await kernel.stat('/dir')
      expect(s.type).toBe('directory')
    } finally {
      kernel.terminate()
    }
  })

  test('stat — ENOENT', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      await expect(kernel.stat('/no/such/path')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      kernel.terminate()
    }
  })

  test('writeFile 后可 readFile 读回', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      await kernel.writeFile('/dynamic.txt', 'written at runtime')
      // Brief delay for Worker to process the vfs:snapshot message
      await Bun.sleep(50)
      const text = await kernel.readFile('/dynamic.txt', 'utf8')
      expect(text).toBe('written at runtime')
    } finally {
      kernel.terminate()
    }
  })
})

// ──────────────────────────────────────────────────────────
// Kernel 集成：mount / exportFs
// ──────────────────────────────────────────────────────────

describe('Kernel.mount + Kernel.exportFs（集成）', () => {
  test('mount(tree) 后可 readFile 读到文件内容', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      await kernel.mount({
        'hello.txt': { file: { contents: 'mounted!' } },
        src: {
          directory: {
            'main.ts': { file: { contents: 'console.log("main")' } },
          },
        },
      })
      // Wait for Worker to process the VFS snapshot
      await Bun.sleep(50)
      const txt = await kernel.readFile('/hello.txt', 'utf8')
      expect(txt).toBe('mounted!')
      const main = await kernel.readFile('/src/main.ts', 'utf8')
      expect(main).toBe('console.log("main")')
    } finally {
      kernel.terminate()
    }
  })

  test('mount 带前缀路径', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      await kernel.mount({ 'app.js': { file: { contents: 'export {}' } } }, '/workspace')
      await Bun.sleep(50)
      const content = await kernel.readFile('/workspace/app.js', 'utf8')
      expect(content).toBe('export {}')
    } finally {
      kernel.terminate()
    }
  })

  test('exportFs 后包含已挂载文件', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [
        { path: '/export-test/index.js', data: 'console.log(1)' },
        { path: '/export-test/README.md', data: '# Hello' },
      ],
    })
    try {
      await kernel.whenReady()
      const tree = await kernel.exportFs('/export-test')
      expect('index.js' in tree).toBe(true)
      expect('README.md' in tree).toBe(true)
      const indexNode = tree['index.js']
      expect('file' in indexNode).toBe(true)
      if ('file' in indexNode) {
        const contents = indexNode.file.contents
        const text = typeof contents === 'string' ? contents : new TextDecoder().decode(contents as Uint8Array)
        expect(text).toBe('console.log(1)')
      }
    } finally {
      kernel.terminate()
    }
  })

  test('mount → exportFs round-trip 内容一致', async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL })
    try {
      await kernel.whenReady()
      const originalTree: FileSystemTree = {
        'a.txt': { file: { contents: 'AAA' } },
        sub: {
          directory: {
            'b.txt': { file: { contents: 'BBB' } },
          },
        },
      }
      await kernel.mount(originalTree, '/rt')
      await Bun.sleep(50)
      const exported = await kernel.exportFs('/rt')

      expect('a.txt' in exported).toBe(true)
      expect('sub' in exported).toBe(true)

      const aNode = exported['a.txt']
      if ('file' in aNode) {
        const txt = typeof aNode.file.contents === 'string' ? aNode.file.contents : new TextDecoder().decode(aNode.file.contents as Uint8Array)
        expect(txt).toBe('AAA')
      }

      const subNode = exported['sub']
      if ('directory' in subNode) {
        expect('b.txt' in subNode.directory).toBe(true)
        const bNode = subNode.directory['b.txt']
        if ('file' in bNode) {
          const txt = typeof bNode.file.contents === 'string' ? bNode.file.contents : new TextDecoder().decode(bNode.file.contents as Uint8Array)
          expect(txt).toBe('BBB')
        }
      }
    } finally {
      kernel.terminate()
    }
  })
})
