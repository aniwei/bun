//! WASM 侧网络 stub（Phase 0：全部返回 ENOSYS；Phase 3 通过 JSI 对接 fetch/WebSocket）。

const std = @import("std");

pub const Error = error{
    NotImplemented,
    ConnectionRefused,
    Timeout,
};

pub fn connectTcp(_: []const u8, _: u16) Error!void {
    return error.NotImplemented;
}

pub fn bindTcp(_: u16) Error!void {
    return error.NotImplemented;
}
