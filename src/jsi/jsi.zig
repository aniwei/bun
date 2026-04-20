//! JSI 包入口。非 wasm 构建不应 import 此文件。
//!
//! 用法：
//! ```zig
//! const jsi = @import("jsi");
//! var rt = jsi.Runtime.init(allocator);
//! defer rt.deinit();
//! const v = rt.makeNumber(42);
//! ```

pub const Runtime = @import("runtime.zig").Runtime;
pub const Value = @import("value.zig").Value;
pub const TypeTag = @import("value.zig").TypeTag;
pub const Promise = @import("promise.zig").Promise;
pub const Module = @import("module.zig").Module;
pub const host_function = @import("host_function.zig");
pub const imports = @import("imports.zig");

pub const Error = error{
    JSIException,
    BufferTooSmall,
    OutOfMemory,
};
