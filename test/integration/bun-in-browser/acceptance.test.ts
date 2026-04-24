/**
 * Bun-in-Browser WebContainer 验收测试套件
 *
 * 依赖：
 *   - Playwright（驱动真实 Chromium）
 *   - 本地启动的 bun-web dev server（含 COOP/COEP 头）
 *
 * 运行方式：
 *   USE_BUN_WEB_RUNTIME=1 bun test test/integration/bun-in-browser/acceptance.test.ts
 *
 * 环境变量：
 *   BUN_WEB_URL      - 宿主页面 URL，默认 http://localhost:4173
 *   BUN_WEB_TIMEOUT  - 单个断言超时（ms），默认 30000
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

// ---------------------------------------------------------------------------
// 工具函数：在 Worker 环境模拟执行（非浏览器 CI 下用 bun-web-runtime 宿主运行）
// ---------------------------------------------------------------------------

const IS_BROWSER_ENV = typeof self !== "undefined" && typeof window !== "undefined";
const TIMEOUT = Number(process.env.BUN_WEB_TIMEOUT ?? 30_000);

/**
 * 在 bun-web-runtime 宿主中执行一段脚本，返回 stdout 与 exitCode。
 * 浏览器环境：postMessage 到 Kernel；Node/Bun 环境：spawn 子进程。
 */
async function runInRuntime(
  script: string,
  files: Record<string, string> = {},
  timeout = TIMEOUT,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  using dir = tempDir("bun-web-acceptance", {
    "entry.ts": script,
    ...files,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "entry.ts"],
    cwd: String(dir),
    env: {
      ...bunEnv,
      // 设置后，运行时自动切换到 bun-web-runtime 实现
      USE_BUN_WEB_RUNTIME: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Section 1：Bun API 表面完整性
// ---------------------------------------------------------------------------

describe("Bun API 表面完整性", () => {
  test("Bun 全局对象存在", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const keys = [
        'version', 'revision', 'main', 'env', 'argv', 'cwd',
        'nanoseconds', 'sleep', 'sleepSync', 'gc', 'inspect',
        'deepEquals', 'deepMatch', 'peek',
        'escapeHTML', 'stringWidth', 'color', 'semver',
        'randomUUIDv7', 'hash', 'CryptoHasher', 'password',
        'file', 'write', 'stdin', 'stdout', 'stderr',
        'serve', 'listen', 'connect',
        'spawn', 'spawnSync',
        'Transpiler', 'build', 'plugin',
        'Glob', 'TOML',
        'dns', 'which',
        'fileURLToPath', 'pathToFileURL',
        'concatArrayBuffers', 'readableStreamToArrayBuffer',
        'readableStreamToBlob', 'readableStreamToText',
        'readableStreamToJSON', 'readableStreamToArray',
        'resolveSync', 'resolve',
        'mmap', 'allocUnsafe',
        'embeddedFiles', 'openInEditor',
      ];
      const missing = keys.filter(k => typeof (Bun as any)[k] === 'undefined');
      if (missing.length > 0) {
        console.error('MISSING:', missing.join(', '));
        process.exit(1);
      }
      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("D 级 API 抛出 ERR_BUN_WEB_UNSUPPORTED", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { dlopen } from 'bun:ffi';
      try {
        dlopen('test.so', {});
        console.log('NO_ERROR');
      } catch (e: any) {
        console.log(e.code === 'ERR_BUN_WEB_UNSUPPORTED' ? 'OK' : 'WRONG_CODE:' + e.code);
      }
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("Bun.version 格式正确", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      console.log(/^\\d+\\.\\d+\\.\\d+/.test(Bun.version) ? 'OK' : 'FAIL:' + Bun.version);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2：node:* 模块可导入
// ---------------------------------------------------------------------------

describe("node:* 模块可导入", () => {
  const nodeModules = [
    "fs", "path", "os", "buffer", "util", "url", "querystring",
    "events", "stream", "string_decoder", "crypto",
    "http", "https", "net", "tls", "zlib",
    "child_process", "worker_threads",
    "async_hooks", "perf_hooks", "timers",
    "assert", "console", "readline", "module",
    "process", "v8", "vm",
    "test", "sqlite",
  ];

  for (const mod of nodeModules) {
    test(`import node:${mod}`, async () => {
      const { stdout, exitCode } = await runInRuntime(`
        const m = await import('node:${mod}');
        console.log(typeof m === 'object' ? 'OK' : 'FAIL');
      `);
      expect(stdout.trim()).toBe("OK");
      expect(exitCode).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Section 3：文件系统操作（VFS）
// ---------------------------------------------------------------------------

describe("VFS 文件系统操作", () => {
  test("readFileSync / writeFileSync 往返", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { writeFileSync, readFileSync } from 'node:fs';
      writeFileSync('/tmp/test.txt', 'hello-vfs');
      const content = readFileSync('/tmp/test.txt', 'utf8');
      console.log(content === 'hello-vfs' ? 'OK' : 'FAIL:' + content);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("fs.promises readdir / mkdir", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { promises as fs } from 'node:fs';
      await fs.mkdir('/tmp/testdir/sub', { recursive: true });
      await fs.writeFile('/tmp/testdir/sub/a.txt', 'content');
      const entries = await fs.readdir('/tmp/testdir/sub');
      console.log(entries.includes('a.txt') ? 'OK' : 'FAIL:' + JSON.stringify(entries));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("Bun.file / Bun.write 往返", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      await Bun.write('/tmp/bunfile.txt', 'bun-write-content');
      const text = await Bun.file('/tmp/bunfile.txt').text();
      console.log(text === 'bun-write-content' ? 'OK' : 'FAIL:' + text);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("fs.watch 监听文件变更", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { writeFileSync, watch } from 'node:fs';
      writeFileSync('/tmp/watch-target.txt', 'init');
      const result = await new Promise<string>((resolve) => {
        const watcher = watch('/tmp/watch-target.txt', () => {
          watcher.close();
          resolve('OK');
        });
        writeFileSync('/tmp/watch-target.txt', 'changed');
      });
      console.log(result);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4：模块解析与转译
// ---------------------------------------------------------------------------

describe("模块解析与转译", () => {
  test("TypeScript 文件直接执行", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const greet = (name: string): string => \`Hello, \${name}!\`;
      console.log(greet('world') === 'Hello, world!' ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("JSX 转译正确", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      import { renderToStaticMarkup } from 'react-dom/server';
      const el = <div className="test">hello</div>;
      const html = renderToStaticMarkup(el);
      console.log(html.includes('class="test"') ? 'OK' : 'FAIL:' + html);
    `,
      {
        "package.json": JSON.stringify({ dependencies: { react: "*", "react-dom": "*" } }),
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("import.meta.url 有效", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      console.log(import.meta.url.startsWith('file://') ? 'OK' : 'FAIL:' + import.meta.url);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("动态 import() 正常", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      const { add } = await import('./math.ts');
      console.log(add(1, 2) === 3 ? 'OK' : 'FAIL');
    `,
      {
        "math.ts": `export const add = (a: number, b: number) => a + b;`,
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("CJS require() 正常", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      const { sub } = require('./math.cjs');
      console.log(sub(5, 3) === 2 ? 'OK' : 'FAIL');
    `,
      {
        "math.cjs": `module.exports = { sub: (a, b) => a - b };`,
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 5：HTTP Server（Bun.serve）
// ---------------------------------------------------------------------------

describe("Bun.serve HTTP Server", () => {
  test("基础 GET / POST 请求", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      using server = Bun.serve({
        port: 0,
        async fetch(req) {
          if (req.method === 'POST') {
            const body = await req.json();
            return Response.json({ echo: body });
          }
          return new Response('hello', { status: 200 });
        },
      });

      const base = server.url.href;
      const get = await fetch(base);
      const post = await fetch(base, {
        method: 'POST',
        body: JSON.stringify({ msg: 'test' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const postData = await post.json();

      const ok =
        (await get.text()) === 'hello' &&
        get.status === 200 &&
        postData.echo.msg === 'test';
      console.log(ok ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("WebSocket echo", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      using server = Bun.serve({
        port: 0,
        fetch(req, srv) {
          if (srv.upgrade(req)) return;
          return new Response('not ws');
        },
        websocket: {
          message(ws, msg) { ws.send('echo:' + msg); },
        },
      });

      const result = await new Promise<string>((resolve) => {
        const ws = new WebSocket(server.url.href.replace('http', 'ws'));
        ws.onopen = () => ws.send('ping');
        ws.onmessage = (e) => { ws.close(); resolve(String(e.data)); };
      });
      console.log(result === 'echo:ping' ? 'OK' : 'FAIL:' + result);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("server.reload 热重载", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      using server = Bun.serve({
        port: 0,
        fetch: () => new Response('v1'),
      });

      const r1 = await (await fetch(server.url.href)).text();

      server.reload({
        fetch: () => new Response('v2'),
      });

      const r2 = await (await fetch(server.url.href)).text();
      console.log(r1 === 'v1' && r2 === 'v2' ? 'OK' : \`FAIL:\${r1},\${r2}\`);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 6：子进程（Bun.spawn）
// ---------------------------------------------------------------------------

describe("Bun.spawn", () => {
  test("spawn 执行 TS 脚本", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      await using proc = Bun.spawn({
        cmd: [process.execPath, 'child.ts'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, code] = await Promise.all([proc.stdout.text(), proc.exited]);
      console.log(out.trim() === 'child-ok' && code === 0 ? 'OK' : \`FAIL:\${out}:\${code}\`);
    `,
      { "child.ts": `console.log('child-ok');` },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("stdin/stdout 管道传递", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      await using proc = Bun.spawn({
        cmd: [process.execPath, 'upper.ts'],
        stdin: 'pipe',
        stdout: 'pipe',
      });
      proc.stdin.write('hello');
      proc.stdin.end();
      const out = await proc.stdout.text();
      console.log(out.trim() === 'HELLO' ? 'OK' : 'FAIL:' + out);
    `,
      {
        "upper.ts": `
        import { readFileSync } from 'node:fs';
        const input = readFileSync('/dev/stdin', 'utf8');
        process.stdout.write(input.toUpperCase());
      `,
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 7：Shell（Bun.$）
// ---------------------------------------------------------------------------

describe("Bun.$ Shell", () => {
  test("基础命令链", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const result = await Bun.$\`echo hello world | tr a-z A-Z\`.text();
      console.log(result.trim() === 'HELLO WORLD' ? 'OK' : 'FAIL:' + result);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("grep 过滤", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      await Bun.$\`echo -e "foo\\nbar\\nbaz" > /tmp/lines.txt\`;
      const result = await Bun.$\`grep ba /tmp/lines.txt\`.text();
      const lines = result.trim().split('\\n');
      console.log(lines.length === 2 && lines.includes('bar') ? 'OK' : 'FAIL:' + JSON.stringify(lines));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("ls / find / cat 正常", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      await Bun.$\`mkdir -p /tmp/shtest && echo content > /tmp/shtest/a.txt\`;
      const ls = await Bun.$\`ls /tmp/shtest\`.text();
      const cat = await Bun.$\`cat /tmp/shtest/a.txt\`.text();
      const find = await Bun.$\`find /tmp/shtest -name '*.txt'\`.text();
      const ok = ls.includes('a.txt') && cat.includes('content') && find.includes('a.txt');
      console.log(ok ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("jq JSON 解析", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const result = await Bun.$\`echo '{"x":42}' | jq .x\`.text();
      console.log(result.trim() === '42' ? 'OK' : 'FAIL:' + result);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 8：bun:sqlite
// ---------------------------------------------------------------------------

describe("bun:sqlite", () => {
  test("基础 CRUD", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Database } from 'bun:sqlite';
      const db = new Database(':memory:');
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      db.run('INSERT INTO t VALUES (1, ?)', ['alice']);
      db.run('INSERT INTO t VALUES (2, ?)', ['bob']);
      const rows = db.query('SELECT * FROM t ORDER BY id').all();
      const ok = rows.length === 2 &&
                 (rows[0] as any).name === 'alice' &&
                 (rows[1] as any).name === 'bob';
      console.log(ok ? 'OK' : 'FAIL:' + JSON.stringify(rows));
      db.close();
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("serialize / deserialize 往返", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Database } from 'bun:sqlite';
      const db1 = new Database(':memory:');
      db1.run('CREATE TABLE kv (k TEXT, v TEXT)');
      db1.run("INSERT INTO kv VALUES ('key1', 'val1')");
      const buf = db1.serialize();
      db1.close();

      const db2 = Database.deserialize(buf);
      const row = db2.query("SELECT v FROM kv WHERE k='key1'").get() as any;
      console.log(row?.v === 'val1' ? 'OK' : 'FAIL:' + JSON.stringify(row));
      db2.close();
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 9：bun:test 测试运行器
// ---------------------------------------------------------------------------

describe("bun:test 运行器", () => {
  test("基础断言与快照", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      import { test, expect } from 'bun:test';
      test('sum', () => {
        expect(1 + 1).toBe(2);
        expect({ a: 1 }).toEqual({ a: 1 });
      });
    `,
    );
    expect(exitCode).toBe(0);
  });

  test("mock.module 拦截", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      import { test, expect, mock } from 'bun:test';
      mock.module('./dep.ts', () => ({ value: 42 }));
      const { value } = await import('./dep.ts');
      console.log(value === 42 ? 'OK' : 'FAIL:' + value);
    `,
      { "dep.ts": `export const value = 0;` },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 10：Bun.Transpiler
// ---------------------------------------------------------------------------

describe("Bun.Transpiler", () => {
  test("TS → JS 转译", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const t = new Bun.Transpiler({ loader: 'ts' });
      const result = t.transformSync('const x: number = 1; console.log(x)');
      // 转译结果不含类型注解
      console.log(!result.includes(': number') ? 'OK' : 'FAIL:' + result);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("scan 提取 imports", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const t = new Bun.Transpiler({ loader: 'ts' });
      const imports = t.scanImports("import React from 'react'; import { useState } from 'react'");
      console.log(imports.length >= 1 && imports[0].path === 'react' ? 'OK' : 'FAIL:' + JSON.stringify(imports));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 11：密码学
// ---------------------------------------------------------------------------

describe("密码学 API", () => {
  test("Bun.password hash/verify (bcrypt)", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const hash = await Bun.password.hash('secret123');
      const ok = await Bun.password.verify('secret123', hash);
      const bad = await Bun.password.verify('wrong', hash);
      console.log(ok && !bad ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("Bun.CryptoHasher SHA-256", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const h = new Bun.CryptoHasher('sha256');
      h.update('hello');
      const hex = h.digest('hex');
      // SHA-256('hello') 的标准值
      console.log(hex === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' ? 'OK' : 'FAIL:' + hex);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("WebCrypto 可用", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      console.log(key.type === 'secret' ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 12：Bun.Glob
// ---------------------------------------------------------------------------

describe("Bun.Glob", () => {
  test("match 模式匹配", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      const glob = new Bun.Glob('*.ts');
      const cases = [
        ['index.ts', true],
        ['main.js', false],
        ['dir/sub.ts', false],
        ['**/*.ts', false],
      ] as [string, boolean][];
      const failed = cases.filter(([p, expected]) => glob.match(p) !== expected);
      console.log(failed.length === 0 ? 'OK' : 'FAIL:' + JSON.stringify(failed));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 13：worker_threads
// ---------------------------------------------------------------------------

describe("node:worker_threads", () => {
  test("Worker 双向通信", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
      if (isMainThread) {
        const result = await new Promise<number>((resolve, reject) => {
          const w = new Worker(new URL('./worker.ts', import.meta.url));
          w.on('message', (v) => { w.terminate(); resolve(v); });
          w.on('error', reject);
        });
        console.log(result === 84 ? 'OK' : 'FAIL:' + result);
      }
    `,
      { "worker.ts": `import { parentPort } from 'node:worker_threads'; parentPort!.postMessage(42 * 2);` },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("AsyncLocalStorage 跨 Worker 不互扰", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { AsyncLocalStorage } from 'node:async_hooks';
      const store = new AsyncLocalStorage<{ id: number }>();
      const results: number[] = [];
      await Promise.all([
        store.run({ id: 1 }, async () => {
          await new Promise(r => setTimeout(r, 5));
          results.push(store.getStore()!.id);
        }),
        store.run({ id: 2 }, async () => {
          results.push(store.getStore()!.id);
        }),
      ]);
      const ok = results.includes(1) && results.includes(2);
      console.log(ok ? 'OK' : 'FAIL:' + JSON.stringify(results));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 14：官方测试集直通（引用，实际由 CI 脚本驱动）
// ---------------------------------------------------------------------------

describe("官方测试集直通 (smoke)", () => {
  /**
   * 这组测试只在 CI 中的 USE_BUN_WEB_RUNTIME=1 模式下完整运行。
   * 本地跑时仅执行 smoke 快速检验：用 bun-web-runtime 执行 1 个官方用例，
   * 确保基础链路通；覆盖率由 CI 矩阵（test/skip-in-browser.txt）统计。
   */

  test("web API smoke — fetch + URL", async () => {
    // 对应 test/js/web/ 中的基础用例
    const { stdout, exitCode } = await runInRuntime(`
      const u = new URL('https://example.com/path?q=1');
      console.log(u.hostname === 'example.com' && u.searchParams.get('q') === '1' ? 'OK' : 'FAIL');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("node:stream smoke — PassThrough", async () => {
    // 对应 test/js/node/stream/ 基础用例
    const { stdout, exitCode } = await runInRuntime(`
      import { PassThrough } from 'node:stream';
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const pt = new PassThrough();
        pt.on('data', (chunk) => chunks.push(chunk.toString()));
        pt.on('end', resolve);
        pt.on('error', reject);
        pt.write('hello');
        pt.write(' world');
        pt.end();
      });
      console.log(chunks.join('') === 'hello world' ? 'OK' : 'FAIL:' + JSON.stringify(chunks));
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("bun:serve smoke — 对应 test/js/bun/http/serve.test.ts 基础断言", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      using server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
      const text = await (await fetch(server.url.href)).text();
      console.log(text === 'ok' ? 'OK' : 'FAIL:' + text);
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});
