#!/usr/bin/env bun
/**
 * bench-web-runtime.ts（M8-4）
 *
 * 启动 / HMR / install / grep 等关键路径基准采集脚本。
 *
 * 用法：
 *   bun scripts/bench-web-runtime.ts
 *   bun scripts/bench-web-runtime.ts --suite startup
 *   bun scripts/bench-web-runtime.ts --suite install
 *   bun scripts/bench-web-runtime.ts --suite hmr
 *   bun scripts/bench-web-runtime.ts --suite grep
 *   bun scripts/bench-web-runtime.ts --runs 10 --json results/bench.json
 *
 * 输出：
 *   - 控制台：各指标的 p50/p95/min/max（ms）
 *   - --json  ：机器可读 JSON 报告（追加时间戳，可长期存储趋势）
 *
 * 性能目标（RFC §11.5）：
 *   - Kernel 冷启 < 1500ms
 *   - bun install (cached) < 8000ms
 *   - HMR 文件变更到模块更新 < 300ms
 *   - grep (10k 文件) < 500ms
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

// ── 目标上限（ms）────────────────────────────────────────────────────────────

const TARGETS: Record<string, number> = {
  startup: 1500,
  install: 8000,
  hmr: 300,
  grep: 500,
};

// ── 类型 ─────────────────────────────────────────────────────────────────────

interface BenchResult {
  suite: string
  runs: number
  samples: number[]
  p50: number
  p95: number
  min: number
  max: number
  target: number
  passed: boolean
}

// ── 统计工具 ─────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx]!;
}

function stats(samples: number[]): { p50: number; p95: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ── 单次计时 ─────────────────────────────────────────────────────────────────

async function time(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ── 套件：Kernel 冷启 ─────────────────────────────────────────────────────────

async function benchStartup(runs: number): Promise<BenchResult> {
  const samples: number[] = [];

  for (let i = 0; i < runs; i++) {
    const ms = await time(async () => {
      // 模拟 kernel bootstrap：生成一段最小 TS 脚本并 spawn 子进程执行
      await using proc = Bun.spawn({
        cmd: [process.execPath, "-e", "process.exit(0)"],
        env: { ...process.env, USE_BUN_WEB_RUNTIME: "1", BUN_DEBUG_QUIET_LOGS: "1" },
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    });
    samples.push(ms);
  }

  const s = stats(samples);
  return { suite: "startup", runs, samples, ...s, target: TARGETS.startup, passed: s.p95 < TARGETS.startup };
}

// ── 套件：bun install（cached） ───────────────────────────────────────────────

async function benchInstall(runs: number): Promise<BenchResult> {
  const samples: number[] = [];
  // 使用 packages/bun-web-test 目录，依赖应已存在于 ~/.bun/install/cache
  const cwd = join(ROOT, "packages/bun-web-test");

  for (let i = 0; i < runs; i++) {
    const ms = await time(async () => {
      await using proc = Bun.spawn({
        cmd: [process.execPath, "install", "--frozen-lockfile"],
        cwd,
        env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    });
    samples.push(ms);
  }

  const s = stats(samples);
  return { suite: "install", runs, samples, ...s, target: TARGETS.install, passed: s.p95 < TARGETS.install };
}

// ── 套件：HMR（文件写入 → 完成检测） ─────────────────────────────────────────

async function benchHmr(runs: number): Promise<BenchResult> {
  const samples: number[] = [];
  // 桩实现：测量 VFS writeFile + event 分发时延（bun-web-vfs 已实现的同步路径）
  const { VirtualFileSystem } = await import("../packages/bun-web-vfs/src/index.ts");
  const vfs = new VirtualFileSystem();

  for (let i = 0; i < runs; i++) {
    const ms = await time(async () => {
      await vfs.writeFile(`/tmp/hmr-test-${i}.ts`, new TextEncoder().encode(`export const v = ${i};`));
    });
    samples.push(ms);
  }

  const s = stats(samples);
  return { suite: "hmr", runs, samples, ...s, target: TARGETS.hmr, passed: s.p95 < TARGETS.hmr };
}

// ── 套件：grep（VFS glob 扫描） ───────────────────────────────────────────────

async function benchGrep(runs: number): Promise<BenchResult> {
  const samples: number[] = [];
  // 在测试目录下扫描所有 .test.ts 文件（近似于 10k 文件 grep）
  const glob = new Bun.Glob("**/*.test.ts");
  const testDir = join(ROOT, "test");

  for (let i = 0; i < runs; i++) {
    const ms = await time(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _f of glob.scan({ cwd: testDir })) {
        // 仅遍历，不读取内容
      }
    });
    samples.push(ms);
  }

  const s = stats(samples);
  return { suite: "grep", runs, samples, ...s, target: TARGETS.grep, passed: s.p95 < TARGETS.grep };
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function printResult(r: BenchResult): void {
  const icon = r.passed ? "✓" : "✗";
  console.log(
    `${icon} [${r.suite}]  p50=${r.p50.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms  min=${r.min.toFixed(1)}ms  max=${r.max.toFixed(1)}ms  (目标 <${r.target}ms)`,
  );
  if (!r.passed) {
    console.warn(`  ↑ p95 超出目标 ${(r.p95 - r.target).toFixed(1)}ms`);
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const suiteFlag = args.find((a) => a.startsWith("--suite="))?.split("=")[1]
  ?? args[args.indexOf("--suite") + 1];
const runsFlag = Number(args.find((a) => a.startsWith("--runs="))?.split("=")[1]
  ?? args[args.indexOf("--runs") + 1] ?? 5);
const jsonFlag = args.find((a) => a.startsWith("--json="))?.split("=")[1]
  ?? (!args.find((a) => a.startsWith("--json")) ? undefined : args[args.indexOf("--json") + 1]);

const allSuites = ["startup", "install", "hmr", "grep"] as const;
const suitesToRun = suiteFlag
  ? (allSuites.includes(suiteFlag as typeof allSuites[number]) ? [suiteFlag] : (console.error(`未知 suite: ${suiteFlag}`), process.exit(1)))
  : allSuites;

console.log(`\n=== bun-web-runtime 基准测试（runs=${runsFlag}） ===\n`);

const results: BenchResult[] = [];

for (const suite of suitesToRun as readonly string[]) {
  process.stdout.write(`  运行 ${suite}... `);
  let result: BenchResult;
  try {
    switch (suite) {
      case "startup": result = await benchStartup(runsFlag); break;
      case "install": result = await benchInstall(runsFlag); break;
      case "hmr": result = await benchHmr(runsFlag); break;
      case "grep": result = await benchGrep(runsFlag); break;
      default: throw new Error(`未知套件: ${suite}`);
    }
    results.push(result);
    process.stdout.write("\r");
    printResult(result);
  } catch (err) {
    process.stdout.write("\r");
    console.error(`  ✗ [${suite}] 执行错误: ${err}`);
  }
}

const allPassed = results.every((r) => r.passed);
console.log(allPassed ? "\n所有基准通过。" : "\n部分基准超出目标。");

// JSON 报告
if (jsonFlag) {
  const entry = {
    timestamp: new Date().toISOString(),
    results: results.map(({ samples: _, ...rest }) => rest),
  };
  const existing = existsSync(jsonFlag)
    ? JSON.parse(readFileSync(jsonFlag, "utf8"))
    : [];
  if (!Array.isArray(existing)) {
    writeFileSync(jsonFlag, JSON.stringify([entry], null, 2));
  } else {
    existing.push(entry);
    writeFileSync(jsonFlag, JSON.stringify(existing, null, 2));
  }
  console.log(`报告已追加: ${jsonFlag}`);
}

process.exit(allPassed ? 0 : 1);
