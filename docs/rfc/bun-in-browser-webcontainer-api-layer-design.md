# Bun-in-Browser WebContainer API 调用层设计

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | v1 (2026-04-25) |
| 关联 RFC | bun-in-browser-webcontainer.md |
| 关联实施计划 | bun-in-browser-webcontainer-implementation-plan.md |
| 目标 | 将参考 WebContainer 架构落地为可实现、可测试的调用层契约 |

---

## 1. 结论与边界

本项目未缺失 WebContainer 架构参考与 API 形状设计。

- 架构参考已在 RFC 给出：Host Page / Service Worker / Kernel Worker / Process Workers。
- 模块级 API 已在模块设计文档给出：各包公开类与方法签名。

当前缺口是“调用层契约冻结”：

- 哪一层对外暴露什么 API。
- 层与层之间使用哪条通信通道。
- 错误码、事件名、流式数据协议是否稳定可测。

本文档用于填补该缺口，并作为 M4-M7 的实现依据。

---

## 2. 分层调用面

### 2.1 Host SDK 层（对齐 WebContainer 风格）

对外入口：@mars/web-client

- BunContainer.boot(options)
- BunContainer.mount(files)
- BunContainer.spawn(cmd, args, options)
- BunContainer.on('server-ready', listener)
- BunContainer.teardown()

约束：

- Host 层不直接触达 Process Worker。
- Host 仅通过 SDK RPC 与 Kernel 控制面交互。
- 预览 iframe URL 仅由 server-ready 事件驱动更新。

### 2.2 Kernel 控制面

对内入口：@mars/web-kernel

- spawn / kill / waitpid
- registerPort / resolvePort / unregisterPort
- onStdio / processExit

约束：

- 控制面消息必须可重放且幂等。
- 同 pid attachProcessPort 为替换语义。
- 进程退出后自动解绑 stdio 与 port 监听。

### 2.3 Service Worker 网络面

对内入口：@mars/web-sw

- fetch 拦截并路由到虚拟端口。
- 将 request body 流桥接到目标进程。
- 将 response body 流回传给页面。

约束：

- 对外部 origin 请求透传。
- 对内路由仅依赖 Kernel 端口表。
- SW 重启后通过心跳与重建流程恢复路由状态。

### 2.4 Process 运行面

对内入口：@mars/web-runtime + @mars/web-node

- Bun.serve lifecycle
- node:http / node:net 映射
- stdio 输出与 exit 通知

约束：

- 业务输出走 MessagePort 控制面，不进入 SAB 数据面。
- 同步 FS/NET syscall 仅走 SAB 桥。

---

## 3. 通信通道与协议

### 3.1 控制面通道

MessagePort / postMessage

- 事件：stdio, processExit, server-ready
- 命令：spawn, kill, registerPort

最小事件载荷：

- server-ready: { pid, port, url }
- stdio: { pid, kind, data }
- processExit: { pid, code }

### 3.2 数据面通道

SharedArrayBuffer + Atomics

- 用于同步 syscall 请求/响应。
- 不承载日志流和生命周期事件。

### 3.3 流式网络通道

ReadableStream / WritableStream

- Request body: SW -> Process
- Response body: Process -> SW -> Page

---

## 4. 错误模型

统一错误分层：

- ERR_BUN_WEB_UNSUPPORTED: API 等级不支持。
- ERR_BUN_WEB_SYNC_UNAVAILABLE: 无 SAB 时同步调用不可用。
- NotSupportedError: 需要可选隧道但未配置。

要求：

- Host SDK 只暴露稳定错误码，不泄漏内部实现细节。
- 跨层传输错误时保留 code 与 message。

---

## 5. M4-M7 落地映射

- M4: 固化 SW <-> Kernel <-> Runtime 的 HTTP/WS 调用链。
- M5: 固化 spawn 与 shell 的控制面协议。
- M6: 固化 build/test/sqlite 的调用入口与错误回传。
- M7: 固化 Host SDK 对外 API，并对齐 WebContainer 风格。

---

## 6. 最小验收清单

### 6.1 架构验收

- 通过 SDK 启动容器并注册 server-ready。
- SW 能将预览请求路由到目标 pid。
- 进程退出后端口路由自动失效。

### 6.2 API 调用层验收

- BunContainer.boot/mount/spawn/on 在真实用例链路可用。
- Bun.serve start/stop/reload 生命周期可观测。
- node:http 基础请求与响应流式回传可用。

### 6.3 失败语义验收

- 无 tunnelUrl 时 TCP 相关调用返回 NotSupportedError。
- 无 SAB 环境下同步 syscall 返回 ERR_BUN_WEB_SYNC_UNAVAILABLE。

---

## 7. 后续维护规则

- 任何跨层事件名、载荷结构变更，先改本文档再改代码。
- M4-M7 每轮推进需在实施计划记录“本轮新增调用层验收项”。
- 与 RFC 或模块设计冲突时，以“先更新文档契约，再实现”为准。
