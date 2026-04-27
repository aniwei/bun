//! WASM 侧进程表骨架（Phase 0：空壳；Phase 2 填充实现）。

const std = @import("std");

pub const Pid = u32;
pub const ExitCode = i32;

pub const Process = struct {
    pid: Pid,
    argv: []const []const u8,
    env: []const [2][]const u8,
    cwd: []const u8,
    state: State,
    exit_code: ?ExitCode,

    pub const State = enum { starting, running, exited };
};

pub const ProcessTable = struct {
    allocator: std.mem.Allocator,
    map: std.AutoHashMap(Pid, *Process),
    next_pid: Pid,

    pub fn init(allocator: std.mem.Allocator) ProcessTable {
        return .{
            .allocator = allocator,
            .map = std.AutoHashMap(Pid, *Process).init(allocator),
            .next_pid = 1,
        };
    }

    pub fn deinit(self: *ProcessTable) void {
        var it = self.map.valueIterator();
        while (it.next()) |p| self.allocator.destroy(p.*);
        self.map.deinit();
    }

    // TODO(Phase 2): spawn/kill/wait/feedStdin 等
};
