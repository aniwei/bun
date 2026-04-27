# Bun API 兼容矩阵

- 状态: Draft
- 日期: 2026-04-27
- 数据来源: `packages/mars-runtime/src/compat-matrix.ts`
- 阶段说明: Phase 2 已完成工程化验收闭环；本矩阵中的 Phase 3 API 仍属于预研切片，需等待明确进入 Phase 3 后继续扩展。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| supported | 验收路径已覆盖，行为目标接近 Bun 常见用法。 |
| partial | 可用于当前验收路径，但还有明确兼容缺口。 |
| unsupported | 当前不可用，调用应失败或不暴露。 |
| planned | 已纳入路线图，尚未实现。 |

## 当前矩阵

| API | 状态 | Phase | 当前说明 | 验收覆盖 |
| --- | --- | --- | --- | --- |
| `Bun.file` | partial | M1 | 基于 MarsVFS 支持 text/json/arrayBuffer/stream；native 文件元数据完整兼容待补。 | Phase 1 Bun.file/Bun.write 验收 |
| `Bun.write` | partial | M1 | 支持将 string、Blob、Response、Request、Uint8Array 兼容输入写入 MarsVFS。 | Phase 1 Bun.file/Bun.write 验收 |
| `Bun.serve` | partial | M1 | 支持虚拟 HTTP server 注册与 fetch 分发；WebSocket upgrade 待补。 | Phase 1 Bun.serve 验收 |
| `MarsRuntime.run` | partial | M2 | 支持 TS/TSX entry 经 resolver/transpiler/loader 执行，并将 console stdout/stderr 映射到 ProcessHandle streams；完整 worker 进程隔离待补。 | Phase 2 runtime.run 验收 |
| `Bun.build` | partial | M3 | 支持单/多 entry 转译输出到 MarsVFS；完整依赖 bundling、splitting、plugin pipeline 待补。 | Phase 3 Bun.build 验收 |
| `Bun.spawn` | planned | M3 | 计划映射为受控 Worker 或内置命令，不承诺 native 子进程。 | 未覆盖 |
| `Bun.spawnSync` | planned | M3 | SAB 同步路径和无 SAB 降级策略待实现。 | 未覆盖 |

## 当前 `Bun.build` 范围

已支持:

1. `entrypoints`
2. `outfile` / `outdir`
3. `format: "esm" | "cjs" | "iife"` 的基础输出包装
4. `target`
5. `define`
6. `sourcemap` 占位透传
7. 输出目录自动创建
8. 输出 artifact 的 `text()` / `arrayBuffer()`
9. 通过统一 playground fixture 构建 `playground/vite-react-ts/src/App.tsx`

暂未支持:

1. 依赖图打包与代码合并
2. code splitting
3. tree shaking
4. minify
5. external
6. loader map
7. 插件 pipeline
8. CSS / asset 输出