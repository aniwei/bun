# @mars/web-agent

AI Agent 受限 shell + 审计 overlay（RFC §10 `bun-web-agent/`）。

## 功能

- **AgentShell**：受限 shell 执行器，支持命令白名单（`allowedCommands`）、路径白名单（`allowedPaths`）、输出截断（`maxOutputBytes`）。
  - 被拒绝的命令返回 `{ blocked: true }` **不抛异常**，不调用 baseExecutor。
  - 通过白名单的命令委托给注入的 `ShellExecutor` 执行。
- **AuditOverlay**：JSONL 格式审计日志写入 VFS，支持 `log()` 追加 / `tail(n)` 读取最近 n 条。
- **capabilities 工具函数**：`isCommandAllowed` / `isPathAllowed` / `truncateOutput`。

## 类型

```ts
interface AgentCapabilities {
  allowedCommands: string[]    // argv[0] 精确匹配
  allowedPaths: string[]       // 路径前缀匹配
  allowNetwork: boolean
  maxOutputBytes?: number      // 默认 1 MB
  auditLog?: string            // VFS 审计路径
}

interface AgentExecResult {
  exitCode: number
  stdout: string
  stderr: string
  blocked: boolean             // true = 命令被拒绝，未执行
  reason?: string
}
```

## 用法

```ts
import { AgentShell, AuditOverlay } from '@mars/web-agent'

const audit = new AuditOverlay(myVFS)
const shell = new AgentShell(myExecutor, {
  allowedCommands: ['ls', 'cat', 'echo'],
  allowedPaths: ['/workspace'],
  allowNetwork: false,
}, audit)

const result = await shell.exec('ls', ['/workspace'])
console.log(result.stdout)  // 正常输出

const blocked = await shell.exec('rm', ['-rf', '/'])
console.log(blocked.blocked)  // true，不崩溃
```

## 测试

19 个单元测试（M7-7）覆盖：允许/拒绝命令、executor 异常容错、输出截断、AuditOverlay log/tail、集成审计。
