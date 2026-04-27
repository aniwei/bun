//! ESM 模块桥接（骨架，Phase 1+ 填充）。
//!
//! 职责：
//!   - 把 Bun bundler 产出的 ESM 代码注册为宿主可加载模块
//!   - 拦截宿主的动态 import() → 返回 WASM 侧解析的模块
//!   - 为 `node:*` / `bun:*` 内置模块提供 HostFunction 绑定

const std = @import("std");
const Value = @import("value.zig").Value;

pub const Module = struct {
    url: []const u8,
    exports: Value,

    pub fn deinit(self: *Module) void {
        self.exports.release();
    }
};

// TODO(Phase 1): 实现 ModuleGraph
//   - register(url, source) → 编译 + 缓存
//   - resolve(specifier, importer) → 返回 url
//   - load(url) → 返回 exports Value
