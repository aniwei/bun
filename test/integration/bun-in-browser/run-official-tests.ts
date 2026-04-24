#!/usr/bin/env bun
/**
 * 官方测试集直通驱动脚本
 *
 * 功能：以 USE_BUN_WEB_RUNTIME=1 为环境变量，批量执行 Bun 官方测试集中
 * JS/TS 层测试用例，统计通过率，与上次基线对比，低于阈值则非零退出。
 *
 * 用法：
 *   bun scripts/run-official-tests-in-browser.ts
 *   bun scripts/run-official-tests-in-browser.ts --update-baseline
 *   bun scripts/run-official-tests-in-browser.ts --dir test/js/web
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ROOT = new URL("../../../", import.meta.url).pathname;

/** 各目录的最低通过率要求 */
const THRESHOLDS: Record<string, number> = {
  "test/js/web": 1.0,
  "test/js/node": 0.95,
  "test/js/bun/http": 0.90,
  "test/js/bun/crypto": 0.90,
  "test/js/bun/shell": 0.85,
  "test/cli/install": 0.80,
  "test/bundler": 0.80,
};

const BASELINE_FILE = join(ROOT, "test/integration/bun-in-browser/baseline.json");
const SKIP_FILE = join(ROOT, "test/integration/bun-in-browser/skip-in-browser.txt");

function resolveThreshold(dir: string): number {
  if (THRESHOLDS[dir] !== undefined) {
    return THRESHOLDS[dir];
  }

  let matched = 1.0;
  let matchedLen = -1;
  for (const [baseDir, threshold] of Object.entries(THRESHOLDS)) {
    if (dir === baseDir || dir.startsWith(`${baseDir}/`)) {
      if (baseDir.length > matchedLen) {
        matched = threshold;
        matchedLen = baseDir.length;
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// 读取跳过清单
// ---------------------------------------------------------------------------

function loadSkipList(): Set<string> {
  if (!existsSync(SKIP_FILE)) return new Set();
  return new Set(
    readFileSync(SKIP_FILE, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean),
  );
}

function shouldSkip(relPath: string, skip: Set<string>): boolean {
  if (skip.has(relPath)) {
    return true;
  }

  for (const rule of skip) {
    if (rule.endsWith("/") && relPath.startsWith(rule)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 收集测试文件
// ---------------------------------------------------------------------------

async function collectTests(dir: string, skip: Set<string>): Promise<string[]> {
  const glob = new Bun.Glob("**/*.test.ts");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: join(ROOT, dir), absolute: false })) {
    const rel = join(dir, f);
    if (!shouldSkip(rel, skip)) files.push(rel);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 运行单个测试文件
// ---------------------------------------------------------------------------

interface RunResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  error?: string;
}

function extractErrorSummary(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("error:")) {
      return line;
    }
  }

  for (const line of lines) {
    if (line.startsWith("SyntaxError:") || line.startsWith("TypeError:") || line.startsWith("ReferenceError:")) {
      return line;
    }
  }

  return undefined;
}

async function runFile(relPath: string): Promise<RunResult> {
  await using proc = Bun.spawn({
    cmd: [process.execPath, "test", join(ROOT, relPath)],
    env: {
      ...process.env,
      USE_BUN_WEB_RUNTIME: "1",
      BUN_DEBUG_QUIET_LOGS: "1",
      // Enable bun:internal-for-testing exports in non-debug binaries when available.
      BUN_GARBAGE_COLLECTOR_LEVEL: process.env.BUN_GARBAGE_COLLECTOR_LEVEL ?? "1",
      BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: process.env.BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING ?? "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  const combinedOutput = `${stdout}\n${stderr}`;

  // 解析 bun test 输出
  const passMatch = stdout.match(/(\d+) pass/);
  const failMatch = stdout.match(/(\d+) fail/);
  const skipMatch = stdout.match(/(\d+) skip/);

  return {
    file: relPath,
    passed: passMatch ? Number(passMatch[1]) : (exitCode === 0 ? 1 : 0),
    failed: failMatch ? Number(failMatch[1]) : (exitCode !== 0 ? 1 : 0),
    skipped: skipMatch ? Number(skipMatch[1]) : 0,
    error: exitCode !== 0 ? extractErrorSummary(combinedOutput) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const targetDir = args.find((a) => !a.startsWith("--") && a.startsWith("test/"));

const skip = loadSkipList();

type Summary = { total: number; passed: number; failed: number; rate: number };
const dirResults: Record<string, Summary> = {};
const allResults: RunResult[] = [];

const dirsToRun = targetDir ? [targetDir] : Object.keys(THRESHOLDS);

for (const dir of dirsToRun) {
  const files = await collectTests(dir, skip);
  console.log(`\n[${dir}] 发现 ${files.length} 个测试文件（已跳过 ${skip.size} 条规则）`);

  let passed = 0, failed = 0;

  // 并发数：CPU 核数
  const concurrency = navigator.hardwareConcurrency ?? 4;
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += concurrency) {
    batches.push(files.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const results = await Promise.all(batch.map(runFile));
    for (const r of results) {
      allResults.push(r);
      passed += r.passed;
      failed += r.failed;
      if (r.failed > 0) {
        const detail = r.error ? ` - ${r.error}` : "";
        console.error(`  ✗ ${r.file}  (${r.failed} 失败${detail})`);
      }
    }
    process.stdout.write(".");
  }

  const total = passed + failed;
  const rate = total > 0 ? passed / total : 1;
  dirResults[dir] = { total, passed, failed, rate };
  console.log(`\n  通过率: ${(rate * 100).toFixed(1)}%  (${passed}/${total})`);
}

// ---------------------------------------------------------------------------
// 对比基线
// ---------------------------------------------------------------------------

let baseline: Record<string, Summary> = {};
if (existsSync(BASELINE_FILE)) {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
}

if (updateBaseline) {
  writeFileSync(BASELINE_FILE, JSON.stringify(dirResults, null, 2));
  console.log("\n基线已更新:", BASELINE_FILE);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 门禁检查
// ---------------------------------------------------------------------------

let exitCode = 0;
console.log("\n=== 门禁检查 ===");

const checks = targetDir ? [[targetDir, resolveThreshold(targetDir)] as const] : Object.entries(THRESHOLDS);

for (const [dir, threshold] of checks) {
  if (!dirResults[dir]) {
    continue;
  }
  const { rate } = dirResults[dir];
  const base = baseline[dir]?.rate ?? 0;

  const thresholdOk = rate >= threshold;
  const regressionOk = rate >= base - 0.01; // 允许 1% 波动

  const icon = thresholdOk && regressionOk ? "✓" : "✗";
  console.log(
    `${icon} ${dir}: ${(rate * 100).toFixed(1)}% (要求 ≥${(threshold * 100).toFixed(0)}%, 基线 ${(base * 100).toFixed(1)}%)`,
  );

  if (!thresholdOk || !regressionOk) exitCode = 1;
}

if (exitCode !== 0) {
  console.error("\n门禁未通过。请修复失败用例或更新 skip-in-browser.txt（需说明原因）。");
} else {
  console.log("\n所有门禁通过。");
}

process.exit(exitCode);
