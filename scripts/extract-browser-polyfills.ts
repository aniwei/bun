#!/usr/bin/env bun
/**
 * extract-browser-polyfills.ts
 *
 * 一次性迁移脚本：
 * 1. 从 src/bun_browser_standalone.zig 提取所有 `_SRC` 内联 JS 字符串常量
 * 2. 将每个常量写出为 src/js/browser-polyfills/<name>.js
 * 3. 把 Zig 文件里的内联字符串替换为 @embedFile("js/browser-polyfills/<name>.js")
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const ZIG_FILE = join(ROOT, "src/bun_browser_standalone.zig");
const OUT_DIR = join(ROOT, "src/js/browser-polyfills");

// ── 1. 读取 Zig 文件 ─────────────────────────────────────────────────────────

const zigSrc = readFileSync(ZIG_FILE, "utf8");

// ── 2. 常量名 → JS 文件名映射 ────────────────────────────────────────────────

const CONST_TO_FILE: Record<string, string> = {
  PATH_MODULE_SRC: "path.js",
  URL_MODULE_SRC: "url.js",
  UTIL_MODULE_SRC: "util.js",
  BUFFER_POLYFILL_SRC: "buffer-polyfill.js",
  EVENTS_MODULE_SRC: "events.js",
  BUFFER_MODULE_SRC: "buffer.js",
  ASSERT_MODULE_SRC: "assert.js",
  QUERYSTRING_MODULE_SRC: "querystring.js",
  STRING_DECODER_MODULE_SRC: "string_decoder.js",
  STREAM_MODULE_SRC: "stream.js",
  CRYPTO_MODULE_SRC: "crypto.js",
  OS_MODULE_SRC: "os.js",
  ZLIB_MODULE_SRC: "zlib.js",
  HTTP_MODULE_SRC: "http.js",
  CHILD_PROCESS_MODULE_SRC: "child_process.js",
  WORKER_THREADS_MODULE_SRC: "worker_threads.js",
  PROCESS_MODULE_SRC: "process.js",
  BUN_GLOBAL_SRC: "bun-global.js",
};

// ── 3. 从 Zig 多行字符串语法提取 JS 内容 ────────────────────────────────────
//
// Zig 多行字符串格式:
//   const FOO: []const u8 =
//       \\line1
//       \\line2
//   ;
//
// 其中每行以可选空白 + `\\` 开头，内容是该行的 JS。

function extractZigStringConst(src: string, constName: string): string | null {
  // 匹配 `const CONST_NAME: []const u8 =` 后续的多行字符串块直到行首 `;`
  const pattern = new RegExp(
    `const ${constName}:\\s*\\[\\]const u8\\s*=\\n((?:[ \\t]*\\\\\\\\[^\\n]*\\n)*)\\s*;`,
    "m",
  );
  const match = pattern.exec(src);
  if (!match) return null;

  // 把每行的 `    \\content` 转换为 `content\n`
  const lines = match[1].split("\n");
  const jsLines: string[] = [];
  for (const line of lines) {
    // 去掉前导空白 + `\\`
    const m = line.match(/^[ \t]*\\\\(.*)$/);
    if (m !== null) {
      jsLines.push(m[1]);
    }
  }
  // 末尾恰好有一个换行
  return jsLines.join("\n") + "\n";
}

// ── 4. 提取并写出 JS 文件 ────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

let errors = 0;
for (const [constName, fileName] of Object.entries(CONST_TO_FILE)) {
  const jsContent = extractZigStringConst(zigSrc, constName);
  if (jsContent === null) {
    console.error(`  ✗  ${constName}: NOT FOUND in Zig file`);
    errors++;
    continue;
  }
  const outPath = join(OUT_DIR, fileName);
  writeFileSync(outPath, jsContent);
  console.log(`  ✓  ${constName} → ${fileName}  (${jsContent.length} chars)`);
}

if (errors > 0) {
  console.error(`\n${errors} constant(s) not found — aborting Zig rewrite.`);
  process.exit(1);
}

// ── 5. 重写 Zig 文件：把内联字符串替换为 @embedFile ────────────────────────

let newZig = zigSrc;

// 先关闭所有内联块注释（保留常量前的 doc comment）
for (const [constName, fileName] of Object.entries(CONST_TO_FILE)) {
  // 匹配从 `\\` 行开始到行首 `;` 的整个多行块
  const pattern = new RegExp(
    `(const ${constName}:\\s*\\[\\]const u8\\s*=)\\n(?:[ \\t]*\\\\\\\\[^\\n]*\\n)*\\s*;`,
    "m",
  );
  const replacement = `$1 @embedFile("js/browser-polyfills/${fileName}");`;
  const next = newZig.replace(pattern, replacement);
  if (next === newZig) {
    console.error(`  ✗  Could not replace ${constName} in Zig file`);
    errors++;
  }
  newZig = next;
}

if (errors > 0) {
  console.error(`\n${errors} replacement(s) failed.`);
  process.exit(1);
}

writeFileSync(ZIG_FILE, newZig);
console.log(`\n✓  Rewrote ${ZIG_FILE}`);
console.log(`✓  JS polyfills written to ${OUT_DIR}/`);
