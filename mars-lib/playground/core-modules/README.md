# Phase 2 核心模块用例

本目录保存 Phase 2 已实现能力的 playground 用例。每个子目录对应一个核心模块，测试只负责加载和执行这些文件，模块行为本身以 playground 文件为来源。

| 模块 | 入口 | 覆盖能力 |
| --- | --- | --- |
| resolver | `resolver/browser-map.json` | package browser field/map、exports/imports、禁用映射。 |
| transpiler | `transpiler/app.tsx` | static import、dynamic import、基础 JSX、export async function。 |
| loader | `loader/entry.tsx` | TSX 执行、static import、dynamic import、JSON/CJS require。 |
| runtime | `runtime/run-entry.ts` | `MarsRuntime.run()`、stdout/stderr stream。 |
| installer | `installer/dependencies.ts` | 离线 fixture cache 安装入口依赖。 |
| bundler | `bundler/vite.config.ts` | Vite root、alias、define、DevServer module response、HMR path。 |
