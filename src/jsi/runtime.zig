//! JSI (JavaScript Interface) — WASM Browser Runtime 的宿主 JS 引擎桥接层。
//!
//! 参考 React Native 的 JSI 思想：不序列化，跨语言传递不透明句柄 + HostFunction 回调。
//! 这里定义公开 API 根，内部实现按职责拆到 value/imports/host_function/promise/module。
//!
//! 仅在 `comptime Environment.isWasm` 时启用；原生构建不会引用。

const std = @import("std");
const bun = @import("bun");
const Environment = bun.Environment;

pub const Value = @import("value.zig").Value;
pub const TypeTag = @import("value.zig").TypeTag;
pub const imports = @import("imports.zig");
pub const host_function = @import("host_function.zig");
pub const Promise = @import("promise.zig").Promise;
pub const Module = @import("module.zig").Module;

/// JSI Runtime —— 代表对宿主 JS 引擎的一次会话。
/// WASM 侧所有调用 JS 的路径都通过 `*Runtime`。
///
/// 设计要点：
/// * 无 JSC `VM` / `JSGlobalObject` 之分；WASM 环境只有一个宿主 Realm。
/// * `global` 是 `globalThis` 的预留 handle（id=4，保留值，永不释放）。
/// * 所有方法失败时返回 `error.JSIException`；调用方用 `try`/`catch` 处理。
pub const Runtime = struct {
    /// `globalThis` 的句柄（由 Host 侧保证固定为 4）
    global: Value = Value.global,
    /// 所有已注册的 HostFunction 的 tag 池
    host_fns: host_function.Registry,

    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) Runtime {
        return .{
            .allocator = allocator,
            .host_fns = host_function.Registry.init(allocator),
        };
    }

    pub fn deinit(self: *Runtime) void {
        self.host_fns.deinit();
    }

    // ── 值构造 ──────────────────────────────────────────

    pub inline fn makeNumber(_: *Runtime, value: f64) Value {
        return .{ .handle = imports.jsi_make_number(value) };
    }

    pub inline fn makeBool(_: *Runtime, value: bool) Value {
        return if (value) Value.true_ else Value.false_;
    }

    pub fn makeString(_: *Runtime, utf8: []const u8) Value {
        return .{ .handle = imports.jsi_make_string(@intFromPtr(utf8.ptr), utf8.len) };
    }

    pub inline fn makeObject(_: *Runtime) Value {
        return .{ .handle = imports.jsi_make_object() };
    }

    pub inline fn makeArray(_: *Runtime, length: u32) Value {
        return .{ .handle = imports.jsi_make_array(length) };
    }

    pub fn makeArrayBuffer(_: *Runtime, bytes: []const u8, copy: bool) Value {
        return .{ .handle = imports.jsi_make_arraybuffer(
            @intFromPtr(bytes.ptr),
            bytes.len,
            @intFromBool(copy),
        ) };
    }

    pub fn makeError(_: *Runtime, msg: []const u8) Value {
        return .{ .handle = imports.jsi_make_error(@intFromPtr(msg.ptr), msg.len) };
    }

    // ── 类型转换 ────────────────────────────────────────

    pub inline fn typeOf(_: *Runtime, v: Value) TypeTag {
        return @enumFromInt(imports.jsi_typeof(v.handle));
    }

    pub inline fn toNumber(_: *Runtime, v: Value) f64 {
        return imports.jsi_to_number(v.handle);
    }

    pub inline fn toBool(_: *Runtime, v: Value) bool {
        return imports.jsi_to_boolean(v.handle) != 0;
    }

    /// 从 JS 字符串拷贝 UTF-8 到 `out`。若 `out` 太小，返回 `error.BufferTooSmall`。
    /// 返回实际写入字节数。调用方可先用 `stringLength` 预分配。
    pub fn readString(_: *Runtime, v: Value, out: []u8) !usize {
        const required = imports.jsi_string_length(v.handle);
        if (out.len < required) return error.BufferTooSmall;
        imports.jsi_string_read(v.handle, @intFromPtr(out.ptr), out.len);
        return required;
    }

    pub inline fn stringLength(_: *Runtime, v: Value) usize {
        return imports.jsi_string_length(v.handle);
    }

    /// 便捷：分配并返回 UTF-8 字符串副本；调用方负责 free。
    pub fn dupeString(self: *Runtime, v: Value) ![]u8 {
        const len = self.stringLength(v);
        const buf = try self.allocator.alloc(u8, len);
        errdefer self.allocator.free(buf);
        _ = try self.readString(v, buf);
        return buf;
    }

    // ── 属性访问 ────────────────────────────────────────

    pub fn getProperty(_: *Runtime, obj: Value, name: []const u8) Value {
        return .{ .handle = imports.jsi_get_prop(obj.handle, @intFromPtr(name.ptr), name.len) };
    }

    pub fn setProperty(_: *Runtime, obj: Value, name: []const u8, val: Value) void {
        imports.jsi_set_prop(obj.handle, @intFromPtr(name.ptr), name.len, val.handle);
    }

    pub inline fn getIndex(_: *Runtime, arr: Value, index: u32) Value {
        return .{ .handle = imports.jsi_get_index(arr.handle, index) };
    }

    pub inline fn setIndex(_: *Runtime, arr: Value, index: u32, val: Value) void {
        imports.jsi_set_index(arr.handle, index, val.handle);
    }

    pub fn hasProperty(_: *Runtime, obj: Value, name: []const u8) bool {
        return imports.jsi_has_prop(obj.handle, @intFromPtr(name.ptr), name.len) != 0;
    }

    // ── 调用 ────────────────────────────────────────────

    /// 调用一个 JS 函数。`args` 会被写入 WASM memory 一次性传递，避免逐参数跨界。
    pub fn call(self: *Runtime, func: Value, this_: Value, args: []const Value) !Value {
        const argv = try self.allocator.alloc(u32, args.len);
        defer self.allocator.free(argv);
        for (args, 0..) |a, i| argv[i] = a.handle;
        const result = imports.jsi_call(
            func.handle,
            this_.handle,
            @intFromPtr(argv.ptr),
            @intCast(args.len),
        );
        if (result == Value.exception_sentinel) return error.JSIException;
        return .{ .handle = result };
    }

    pub fn callNew(self: *Runtime, ctor: Value, args: []const Value) !Value {
        const argv = try self.allocator.alloc(u32, args.len);
        defer self.allocator.free(argv);
        for (args, 0..) |a, i| argv[i] = a.handle;
        const result = imports.jsi_new(
            ctor.handle,
            @intFromPtr(argv.ptr),
            @intCast(args.len),
        );
        if (result == Value.exception_sentinel) return error.JSIException;
        return .{ .handle = result };
    }

    // ── HostFunction ────────────────────────────────────

    /// 注册一个 Zig 回调为宿主侧可调用的 JS 函数。
    /// `callback` 签名：`fn(*Runtime, this: Value, args: []const Value) anyerror!Value`
    pub fn createHostFunction(
        self: *Runtime,
        comptime callback: host_function.HostFn,
        name: []const u8,
        argc: u32,
    ) !Value {
        const tag = try self.host_fns.register(callback);
        return .{ .handle = imports.jsi_make_host_function(
            tag,
            @intFromPtr(name.ptr),
            name.len,
            argc,
        ) };
    }

    // ── 脚本执行 ────────────────────────────────────────

    pub fn evalScript(_: *Runtime, code: []const u8, url: []const u8) !Value {
        const result = imports.jsi_eval(
            @intFromPtr(code.ptr),
            code.len,
            @intFromPtr(url.ptr),
            url.len,
        );
        if (result == Value.exception_sentinel) return error.JSIException;
        return .{ .handle = result };
    }

    pub fn evalModule(_: *Runtime, code: []const u8, url: []const u8) !Value {
        const result = imports.jsi_eval_module(
            @intFromPtr(code.ptr),
            code.len,
            @intFromPtr(url.ptr),
            url.len,
        );
        if (result == Value.exception_sentinel) return error.JSIException;
        return .{ .handle = result };
    }
};

// ── 构建期守卫 ──────────────────────────────────────────
comptime {
    if (!Environment.isWasm) {
        // 允许被非 wasm 构建 @import 以进行类型检查，但不提供实现。
        // 如果不希望被误用，可改为：@compileError("src/jsi/ only valid for wasm builds");
    }
}
