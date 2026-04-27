# Mars-lib AGENTS 指南

本文件适用于 `mars-lib/` 目录及其子目录。

## 1. 总体目标

1. 保持 Mars-lib 代码风格统一、可读、易维护
2. 优先保证模块边界清晰，避免单文件和单函数持续膨胀
3. 风格参考 better-chatbot 的可读性实践，并结合 Mars-lib 当前工程约束
4. 默认使用中文进行文档与注释沟通，代码标识符保持英文

## 2. 代码风格总则

1. 代码风格尽可能不使用分号 `;` 和 `"`
2. 代码尽可能换行，避免超长行和过度内联表达式
3. 变量名、函数名、类名尽可能语义完整，不使用含义不清的缩写
4. 除了极小作用域临时变量，不使用 `tmp`、`ctx`、`cfg`、`obj` 这类泛化命名
5. 复杂逻辑优先拆分为小函数，避免一个函数承载过多职责

## 3. 文件规模约束

1. 单文件应尽量保持精简
2. 当单文件超过 1000 行时，必须拆分文件实现
3. 拆分优先级:
   1. 按领域职责拆分
   2. 按运行时边界拆分（runtime、kernel、vfs、loader、hooks）
   3. 按接口定义与实现拆分（types 与 implementation）

## 4. TypeScript / JavaScript 导入顺序

导入顺序必须遵循以下规则。

### 4.1 值导入顺序

1. 绝对路径 default 导入
2. 相对路径 default 导入
3. 绝对路径具名导入
4. 相对路径具名导入

### 4.2 类型导入顺序

类型导入放在值导入之后，顺序同上:

1. 绝对路径 default type 导入
2. 相对路径 default type 导入
3. 绝对路径具名 type 导入
4. 相对路径具名 type 导入

### 4.3 样式与静态资源

1. scss、css、svg、图片等静态资源导入必须放在最后

### 4.4 示例

```ts
import react from "react"
import promptInput from "@/components/prompt-input"
import localStore from "./store"

import { clsx } from "clsx"
import { createRuntime } from "@/runtime/create-runtime"
import { parseFile } from "./parse-file"

import type { Koa } from "koa"
import type { RuntimeOptions } from "@/types/runtime"
import type { LocalStoreState } from "./store.types"

import styles from "./index.module.scss"
```

## 5. Rust 风格约束

Rust 代码遵循与 TS 同等的可读性原则。

1. 尽量不写超长行，复杂表达式主动换行
2. 命名语义化，不使用难以理解的缩写
3. 单文件超过 1000 行时必须拆分模块
4. `use` 顺序建议:
   1. 标准库与第三方 crate
   2. `crate::` 绝对路径模块
   3. `super::` 或相对路径模块

示例:

```rust
use std::sync::Arc;
use anyhow::Result;

use crate::runtime::kernel::KernelRuntime;
use crate::vfs::path::VirtualPath;

use super::types::RuntimeConfig;
```

## 6. 结构与模块拆分建议

1. 接口类型集中在 `types` 或 `interface` 文件
2. 运行时核心逻辑与适配层分离
3. 公共工具函数避免散落，按领域集中
4. 避免跨层反向依赖，保持单向依赖流

## 7. 工程命令约定

1. 使用 Nx 组织构建、测试与任务编排
2. 使用 ox 执行格式化和 lint

推荐命令:

```bash
nx run-many -t build,test,typecheck
nx affected -t build,test,lint

ox format
ox format --check
ox lint
ox lint --max-warnings 0
```

## 8. 评审与提交前检查

1. 是否符合导入顺序
2. 是否尽量避免分号
3. 是否使用了可读、完整的命名
4. 单文件是否超过 1000 行
5. 是否通过 `ox format --check` 与 `ox lint --max-warnings 0`

## 9. 与现有项目协同

1. 若 Mars-lib 子模块已有既定规范，优先遵循子模块规范
2. 若规范冲突，以本文件为默认基线，并在 PR 描述中注明偏差理由
3. 新增规范请在本文件追加，不要在多个文档重复定义