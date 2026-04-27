//! JSI Promise 辅助。
//!
//! 模式：Zig 侧发起一个"需要异步完成"的操作时：
//!   1. 调 `Promise.create(runtime)` 返回 Promise 对象的 handle + 一个 token
//!   2. 将 token 与 Zig 侧的 I/O 操作关联
//!   3. I/O 完成时调 `Promise.resolve(token, value)` 或 `.reject(token, err)`
//! 等价于 RN JSI 的 `Promise<T>` + async resolver 模式。

const std = @import("std");
const imports = @import("imports.zig");
const Value = @import("value.zig").Value;

pub const ResolverToken = u32;

pub const Promise = struct {
    handle: Value,
    token: ResolverToken,

    /// 创建一个 pending promise。Host 侧把 (token → [resolve, reject]) 登记在表中。
    pub fn create() Promise {
        // token 在 WASM 侧独立分配，避免跨边界竞争。
        const token = nextToken();
        const h = imports.jsi_make_promise(token);
        return .{ .handle = .{ .handle = h }, .token = token };
    }

    pub fn resolve(self: Promise, value: Value) void {
        imports.jsi_resolve(self.handle.handle, value.handle);
    }

    pub fn reject(self: Promise, reason: Value) void {
        imports.jsi_reject(self.handle.handle, reason.handle);
    }
};

var next_token: ResolverToken = 1;

fn nextToken() ResolverToken {
    // Wasm 单线程，无需原子。
    const t = next_token;
    next_token +%= 1;
    if (next_token == 0) next_token = 1; // 0 保留
    return t;
}
