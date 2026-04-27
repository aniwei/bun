//! HostFunction 注册表。
//!
//! 当 Zig 调用 `runtime.createHostFunction(cb, ...)` 时：
//!   1. 这里为 `cb` 分配一个 u32 tag
//!   2. 调 `imports.jsi_make_host_function(tag, ...)` 返回一个 JS Function handle
//!   3. Host 侧记住 (jsFn → tag) 映射
//!   4. 当 JS 代码调用该函数时，Host 侧调 WASM 导出 `jsi_dispatch_host_fn(tag, ...)`
//!   5. 这里按 tag 查表，调用原始 Zig 回调

const std = @import("std");
const Value = @import("value.zig").Value;

/// HostFunction 的 Zig 回调签名。
/// `args` 切片的生命周期仅限回调内；Zig 代码如需保留值，应 `v.retain()`。
pub const HostFn = *const fn (
    runtime: *anyopaque, // 真实类型为 *Runtime，为避免循环 import，这里用 anyopaque
    this_: Value,
    args: []const Value,
) anyerror!Value;

pub const Registry = struct {
    allocator: std.mem.Allocator,
    entries: std.array_list.Managed(?HostFn),

    pub fn init(allocator: std.mem.Allocator) Registry {
        return .{
            .allocator = allocator,
            .entries = std.array_list.Managed(?HostFn).init(allocator),
        };
    }

    pub fn deinit(self: *Registry) void {
        self.entries.deinit();
    }

    /// 注册一个回调，返回其 tag（从 1 开始，0 保留给 null）。
    pub fn register(self: *Registry, callback: HostFn) !u32 {
        // 简单实现：append。后续可优化为自由列表以支持 unregister。
        const tag: u32 = @intCast(self.entries.items.len + 1);
        try self.entries.append(callback);
        return tag;
    }

    pub fn lookup(self: *const Registry, tag: u32) ?HostFn {
        if (tag == 0 or tag > self.entries.items.len) return null;
        return self.entries.items[tag - 1];
    }
};

/// WASM export：由 Host 侧调用，分发到注册的 Zig 回调。
/// 在 `src/main_wasm.zig` 或运行时入口文件中具体 `export` 此函数。
///
/// 签名约定：
///   - argv_ptr：指向 WASM memory 中一段 u32 数组，长度 = argc
///   - argv[0] 是 `this` handle
///   - argv[1..argc] 是参数 handle
///   - 返回：Value handle（异常时返回 Value.exception_sentinel）
pub fn dispatchHostFn(
    registry: *const Registry,
    runtime: *anyopaque,
    tag: u32,
    argv: []const u32,
) u32 {
    const cb = registry.lookup(tag) orelse return Value.exception_sentinel;
    if (argv.len == 0) return Value.exception_sentinel;

    const this_: Value = .{ .handle = argv[0] };
    const rest = argv[1..];
    // 把 u32 数组 reinterpret 为 Value 数组（同布局）
    const args: []const Value = @as([*]const Value, @ptrCast(rest.ptr))[0..rest.len];

    const result = cb(runtime, this_, args) catch {
        // TODO: 把 Zig error 翻译为 JS Error 并 throw
        return Value.exception_sentinel;
    };
    return result.handle;
}
