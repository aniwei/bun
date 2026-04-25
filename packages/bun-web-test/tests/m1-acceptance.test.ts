/**
 * M1 核心验收测试（kernel/vfs/runtime/module）
 *
 * 运行方式：
 *   bun test test/integration/bun-in-browser/m1-acceptance.test.ts
 *
 * 验收标准：
 *   - Kernel bootstrap 与 process 初始化可用
 *   - VFS 基础读写与目录操作正常
 *   - TypeScript / JSX 转译支持
 *   - ESM / CJS 模块加载正常
 */

import { test, expect, describe } from "vitest";
import { bunEnv, tempDir } from "harness";

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const KERNEL_SRC = "/Users/aniwei/Desktop/workspaces/bun/packages/bun-web-kernel/src/kernel.ts";
const PROCESS_BOOTSTRAP_SRC = "/Users/aniwei/Desktop/workspaces/bun/packages/bun-web-runtime/src/process-bootstrap.ts";
const PROCESS_SUPERVISOR_SRC = "/Users/aniwei/Desktop/workspaces/bun/packages/bun-web-runtime/src/process-supervisor.ts";
const RUNTIME_SPAWN_SRC = "/Users/aniwei/Desktop/workspaces/bun/packages/bun-web-runtime/src/spawn.ts";

/**
 * 在 bun-web-runtime 宿主中执行脚本（使用 USE_BUN_WEB_RUNTIME 环境变量）
 */
async function runInRuntime(
  script: string,
  files: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  using dir = tempDir("m1-acceptance", {
    "entry.ts": script,
    ...files,
  });

  await using proc = Bun.spawn({
    cmd: ["/usr/bin/env", "bun", "run", "entry.ts"],
    cwd: String(dir),
    env: {
      ...bunEnv,
      USE_BUN_WEB_RUNTIME: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

// ============================================================================
// M1-8 Acceptance: Kernel / VFS / Runtime / Module
// ============================================================================

describe("M1-8 核心验收", () => {
  // -------------------------------------------------------------------------
  // M1-1/M1-5：Kernel 初始化与 Process 对象
  // -------------------------------------------------------------------------

  test("M1-1: Bun.version 与 process 基础属性可用", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      // Bun 全局对象
      if (typeof Bun === 'undefined') {
        console.log('FAIL:no-bun');
        process.exit(1);
      }
      if (!/^\\d+\\.\\d+\\.\\d+/.test(Bun.version)) {
        console.log('FAIL:version-format-' + Bun.version);
        process.exit(1);
      }

      // process 基础属性（M1-6）
      if (typeof process !== 'object') {
        console.log('FAIL:no-process');
        process.exit(1);
      }
      if (typeof process.env !== 'object') {
        console.log('FAIL:no-env');
        process.exit(1);
      }
      if (typeof process.argv !== 'object' || !Array.isArray(process.argv)) {
        console.log('FAIL:no-argv');
        process.exit(1);
      }
      if (typeof process.cwd !== 'function') {
        console.log('FAIL:no-cwd');
        process.exit(1);
      }
      if (typeof process.on !== 'function') {
        console.log('FAIL:no-on');
        process.exit(1);
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("M1-1/M1-6: process stdio 句柄与 write() 可用", async () => {
    const { stdout, stderr, exitCode } = await runInRuntime(`
      if (process.stdin?.fd !== 0) {
        console.log('FAIL:stdin-fd-' + process.stdin?.fd);
        process.exit(1);
      }

      if (process.stdout?.fd !== 1) {
        console.log('FAIL:stdout-fd-' + process.stdout?.fd);
        process.exit(1);
      }

      if (process.stderr?.fd !== 2) {
        console.log('FAIL:stderr-fd-' + process.stderr?.fd);
        process.exit(1);
      }

      if (typeof process.stdout?.write !== 'function') {
        console.log('FAIL:no-stdout-write');
        process.exit(1);
      }

      if (typeof process.stderr?.write !== 'function') {
        console.log('FAIL:no-stderr-write');
        process.exit(1);
      }

      process.stdout.write('STDOUT_OK');
      process.stderr.write('STDERR_OK');
    `);
    expect(stdout).toContain("STDOUT_OK");
    expect(stderr).toContain("STDERR_OK");
    expect(exitCode).toBe(0);
  });

  test("M1-5/M1-8: RuntimeProcessSupervisor 收敛 stdout 与 exit 生命周期", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Kernel } from ${JSON.stringify(KERNEL_SRC)};
      import { bootstrapProcessWorker } from ${JSON.stringify(PROCESS_BOOTSTRAP_SRC)};
      import { RuntimeProcessSupervisor } from ${JSON.stringify(PROCESS_SUPERVISOR_SRC)};

      const hostProcess = process;
      const fail = (message: string) => {
        console.log('FAIL:' + message);
        hostProcess.exit(1);
      };

      const kernel = await Kernel.boot({});
      const supervisor = new RuntimeProcessSupervisor(kernel);
      const seenStdout: string[] = [];
      const seenExitCodes: number[] = [];

      try {
        const ctx = await supervisor.spawnSupervisedProcess({
          argv: ['bun', 'acceptance-supervisor.ts'],
          cwd: '/',
          env: {},
          sabBuffer: null,
          onExit: code => seenExitCodes.push(code),
        });

        const unsubscribeStdio = ctx.onStdio((kind, data) => {
          if (kind === 'stdout') seenStdout.push(data);
        });

        if (ctx.process.stdout.write('SUPERVISOR_OK') !== true) {
          fail('stdout-write');
        }

        try {
          ctx.process.exit(44);
          fail('missing-exit-throw');
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('process.exit(44)')) {
            fail('unexpected-exit-error');
          }
        }

        const code = await ctx.exited;
        if (code !== 44) {
          fail('waitpid-' + code);
        }
        if (!seenStdout.includes('SUPERVISOR_OK')) {
          fail('missing-stdout');
        }
        if (seenExitCodes.length !== 1 || seenExitCodes[0] !== 44) {
          fail('exit-callback-' + JSON.stringify(seenExitCodes));
        }

        console.log('OK');
        ctx.cleanup();
        unsubscribeStdio();
      } finally {
        supervisor.dispose();
        await Kernel.shutdown();
      }
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("M1-5/M1-8: runtime spawn() 公共入口可返回 ChildProcess 句柄", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Kernel } from ${JSON.stringify(KERNEL_SRC)};
      import { spawn } from ${JSON.stringify(RUNTIME_SPAWN_SRC)};

      const hostProcess = process;
      const fail = (message: string) => {
        console.log('FAIL:' + message);
        hostProcess.exit(1);
      };

      const kernel = await Kernel.boot({});
      const seenExitCodes: number[] = [];
      const seenSignals: Array<number | null> = [];

      try {
        let childRef: ReturnType<typeof spawn> | null = null;
        const child = spawn({
          kernel,
          cmd: ['bun', 'acceptance-runtime-spawn.ts'],
          cwd: '/workspace',
          env: { MODE: 'acceptance-runtime-spawn' },
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'ignore',
          onExit: (proc, code, signal) => {
            seenExitCodes.push(code);
            seenSignals.push(signal);
            if (proc !== childRef) {
              fail('onExit-proc-mismatch');
            }
          },
        });
        childRef = child;

        if (!child.stdin) {
          fail('stdin-not-pipe');
        }

        await child.stdin?.getWriter().write(new TextEncoder().encode('acceptance-input'));
        child.kill();

        const code = await child.exited;
        if (code !== 0) {
          fail('exit-code-' + code);
        }
        if (child.pid <= 0) {
          fail('pid-not-ready-' + child.pid);
        }
        if (seenExitCodes.length !== 1 || seenExitCodes[0] !== 0) {
          fail('onExit-code-' + JSON.stringify(seenExitCodes));
        }
        if (seenSignals.length !== 1 || seenSignals[0] !== null) {
          fail('onExit-signal-' + JSON.stringify(seenSignals));
        }

        console.log('OK');
      } finally {
        await Kernel.shutdown();
      }
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-3：VFS 基础读写
  // -------------------------------------------------------------------------

  test("M1-3: readFileSync / writeFileSync 往返", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { writeFileSync, readFileSync } from 'node:fs';

      // 写入
      writeFileSync('/tmp/m1-test.txt', 'hello-world');

      // 读取
      const content = readFileSync('/tmp/m1-test.txt', 'utf8');

      if (content !== 'hello-world') {
        console.log('FAIL:' + content);
        process.exit(1);
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("M1-3: mkdir / readdir 目录操作", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { promises as fs } from 'node:fs';

      // 递归创建目录
      await fs.mkdir('/tmp/m1-dir/sub', { recursive: true });

      // 写入文件
      await fs.writeFile('/tmp/m1-dir/sub/file.txt', 'content');

      // 读取目录
      const entries = await fs.readdir('/tmp/m1-dir/sub');

      if (!entries.includes('file.txt')) {
        console.log('FAIL:' + JSON.stringify(entries));
        process.exit(1);
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("M1-3: 缺失路径读取抛 ENOENT", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { readFileSync } from 'node:fs';

      try {
        readFileSync('/tmp/does-not-exist.txt', 'utf8');
        console.log('FAIL:no-error');
        process.exit(1);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.log('FAIL:' + error?.code);
          process.exit(1);
        }
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-9：TypeScript 转译
  // -------------------------------------------------------------------------

  test("M1-9: TypeScript 类型注解与箭头函数", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      // TypeScript 类型注解应被移除，代码应可执行
      const add = (a: number, b: number): number => {
        return a + b;
      };

      const result = add(2, 3);
      if (result !== 5) {
        console.log('FAIL:' + result);
        process.exit(1);
      }

      // interface 声明应被移除
      interface Point {
        x: number;
        y: number;
      }

      const point: Point = { x: 1, y: 2 };
      if (point.x + point.y !== 3) {
        console.log('FAIL:point');
        process.exit(1);
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-9：JSX 转译
  // -------------------------------------------------------------------------

  test("M1-9: JSX 转译为 React.createElement", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      // 定义简单的 React shim
      const React = {
        createElement: (type: any, props: any, ...children: any[]) => ({
          type,
          props: props ? { ...props, children: children.length === 1 ? children[0] : children } : { children },
          $$typeof: Symbol.for('react.element'),
        }),
      };

      // JSX 应转译为 React.createElement 调用
      const jsx = React.createElement('div', { className: 'test' }, 'hello');

      // 简单验证：如果转译正确，jsx 应是一个对象（React 元素）
      // 且包含 type、props 等字段
      if (typeof jsx !== 'object' || !jsx) {
        console.log('FAIL:not-element');
        process.exit(1);
      }

      // 验证 type 是 'div'
      if (jsx.type !== 'div') {
        console.log('FAIL:type-' + jsx.type);
        process.exit(1);
      }

      // 验证 className 被保存为 props.className
      if (jsx.props?.className !== 'test') {
        console.log('FAIL:class-' + jsx.props?.className);
        process.exit(1);
      }

      // 验证文本内容
      if (jsx.props?.children !== 'hello') {
        console.log('FAIL:text-' + jsx.props?.children);
        process.exit(1);
      }

      console.log('OK');
    `,
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-9：ESM 动态导入
  // -------------------------------------------------------------------------

  test("M1-9: 动态 import() 加载 ESM 模块", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      // 动态导入应正常工作
      const mod = await import('./helper.ts');

      if (typeof mod.add !== 'function') {
        console.log('FAIL:no-add');
        process.exit(1);
      }

      const result = mod.add(3, 4);
      if (result !== 7) {
        console.log('FAIL:' + result);
        process.exit(1);
      }

      console.log('OK');
    `,
      {
        "helper.ts": `export const add = (a: number, b: number) => a + b;`,
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-9：CommonJS require()
  // -------------------------------------------------------------------------

  test("M1-9: require() 加载 CommonJS 模块", async () => {
    const { stdout, exitCode } = await runInRuntime(
      `
      // require() 应正常工作（通过 createRequire 或全局 require）
      const mod = require('./helper.cjs');

      if (typeof mod.multiply !== 'function') {
        console.log('FAIL:no-multiply');
        process.exit(1);
      }

      const result = mod.multiply(3, 4);
      if (result !== 12) {
        console.log('FAIL:' + result);
        process.exit(1);
      }

      console.log('OK');
    `,
      {
        "helper.cjs": `module.exports = { multiply: (a, b) => a * b };`,
      },
    );
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-9：import.meta.url
  // -------------------------------------------------------------------------

  test("M1-9: import.meta.url 在 ESM 中可用", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      // import.meta.url 应指向当前模块的 file:// URL
      const url = import.meta.url;

      if (typeof url !== 'string') {
        console.log('FAIL:not-string');
        process.exit(1);
      }

      if (!url.startsWith('file://')) {
        console.log('FAIL:invalid-url-' + url);
        process.exit(1);
      }

      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1-5/M1-8：spawn() stdio 策略边界
  // -------------------------------------------------------------------------

  test("M1-5/M1-8: spawn() stdout ignore 时子句柄 stdout 流立即关闭", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Kernel } from ${JSON.stringify(KERNEL_SRC)};
      import { spawn } from ${JSON.stringify(RUNTIME_SPAWN_SRC)};

      const hostProcess = process;
      const fail = (message: string) => {
        console.log('FAIL:' + message);
        hostProcess.exit(1);
      };

      const kernel = await Kernel.boot({});

      try {
        const child = spawn({
          kernel,
          cmd: ['bun', 'ignore-test.ts'],
          cwd: '/',
          env: {},
          stdout: 'ignore',
          stderr: 'ignore',
        });

        // stdout: ignore 时，ReadableStream 在进程退出后应关闭（done=true）
        child.kill();
        await child.exited;

        const reader = child.stdout.getReader();
        const { done } = await reader.read();
        reader.releaseLock();

        if (!done) {
          fail('stdout-not-done-after-exit');
        }

        console.log('OK');
      } finally {
        await Kernel.shutdown();
      }
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  test("M1-5/M1-8: spawn() stdout inherit 时数据不进入子句柄 stdout pipe", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { Kernel } from ${JSON.stringify(KERNEL_SRC)};
      import { spawn } from ${JSON.stringify(RUNTIME_SPAWN_SRC)};

      const hostProcess = process;
      const fail = (message: string) => {
        console.log('FAIL:' + message);
        hostProcess.exit(1);
      };

      const kernel = await Kernel.boot({});
      const received: Uint8Array[] = [];

      try {
        const child = spawn({
          kernel,
          cmd: ['bun', 'inherit-test.ts'],
          cwd: '/',
          env: {},
          stdout: 'inherit',
          stderr: 'ignore',
        });

        // 启动读取 child.stdout（inherit 模式下应不收到任何数据，流在退出后关闭）
        const reader = child.stdout.getReader();

        child.kill();
        await child.exited;

        // 消费流直到关闭
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
        }
        reader.releaseLock();

        // inherit 模式下子句柄 stdout pipe 不应收到任何数据块
        if (received.length !== 0) {
          fail('inherit-leaked-to-pipe:' + received.length);
        }

        console.log('OK');
      } finally {
        await Kernel.shutdown();
      }
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // M1/M5 兼容：spawnSync 基线行为
  // -------------------------------------------------------------------------

  test("M1/M5: spawnSync() 返回同步执行结果", async () => {
    const { stdout, exitCode } = await runInRuntime(`
      import { spawnSync } from ${JSON.stringify(RUNTIME_SPAWN_SRC)};

      const hostProcess = process;
      const fail = (message: string) => {
        console.log('FAIL:' + message);
        hostProcess.exit(1);
      };

      const out = spawnSync({ cmd: ['sh', '-c', 'cat'], stdin: 'hello-sync' });
      const text = new TextDecoder().decode(out.stdout).trim();

      if (out.exitCode !== 0) {
        fail('bad-exit:' + out.exitCode);
      }
      if (text !== 'hello-sync') {
        fail('bad-stdout:' + text);
      }
      console.log('OK');
    `);
    expect(stdout.trim()).toBe("OK");
    expect(exitCode).toBe(0);
  });
});
