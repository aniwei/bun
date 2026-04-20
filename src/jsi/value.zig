//! JSI Value —— 对宿主 JS 值的不透明句柄。
//!
//! u32 句柄由 Host(TS) 侧的 `handleTable` 管理。
//! 0..4 为保留常量 handle，由 Host 适配器初始化时预填并永不释放。

const std = @import("std");
const imports = @import("imports.zig");

pub const Value = struct {
    handle: u32,

    // ── 保留常量（Host 侧必须与此一致）──
    pub const undefined_: Value = .{ .handle = 0 };
    pub const null_: Value = .{ .handle = 1 };
    pub const true_: Value = .{ .handle = 2 };
    pub const false_: Value = .{ .handle = 3 };
    pub const global: Value = .{ .handle = 4 };

    /// 当 Host 侧发生未捕获异常时，返回此值作为哨兵。
    /// 调用方必须检查并转为 `error.JSIException`。
    pub const exception_sentinel: u32 = 0xFFFF_FFFF;

    pub inline fn isNullOrUndefined(self: Value) bool {
        return self.handle == undefined_.handle or self.handle == null_.handle;
    }

    pub inline fn isUndefined(self: Value) bool {
        return self.handle == undefined_.handle;
    }

    pub inline fn isNull(self: Value) bool {
        return self.handle == null_.handle;
    }

    /// 引用计数 +1。Host 侧通过 `jsi_retain` 维护句柄寿命。
    /// 常量 handle (0..4) 的 retain 是 no-op。
    pub fn retain(self: Value) Value {
        if (self.handle <= global.handle) return self;
        return .{ .handle = imports.jsi_retain(self.handle) };
    }

    /// 引用计数 -1。归零时 Host 从表中移除。
    pub fn release(self: Value) void {
        if (self.handle <= global.handle) return;
        imports.jsi_release(self.handle);
    }
};

/// JS typeof + 扩展。与 Host 侧 `JSIType` enum 一一对应。
pub const TypeTag = enum(u32) {
    undefined_ = 0,
    null_ = 1,
    boolean = 2,
    number = 3,
    string = 4,
    symbol = 5,
    object = 6,
    function = 7,
    // 扩展（非 ECMAScript typeof）
    array = 8,
    arraybuffer = 9,
    typed_array = 10,
    promise = 11,
    error_ = 12,
};
