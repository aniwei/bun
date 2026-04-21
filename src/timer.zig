//! WASM 侧 Timer 表 —— 仅在无真实 OS timer 的浏览器 WASM 环境中使用。
//!
//! 宿主驱动模型：
//!   1. Zig 注册 timer（id, deadline_ms, repeat_ms, callback_tag）
//!   2. 宿主 JS 每帧/每 rAF 调 `bun_tick()` → Zig 触发到期 timer 的 HostFn
//!   3. `bun_tick()` 返回 "距离下一个 timer 的 ms 数"（0 = 空，让宿主等待）
//!
//! callback_tag 对应 `host_function.Registry` 中的 HostFn tag，
//! 触发时以空参数列表调用该 HostFn（this=undefined）。

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const TimerId = u32;

const Entry = struct {
    id: TimerId,
    deadline_ms: u64,
    repeat_ms: u64, // 0 = setTimeout, >0 = setInterval period
    callback_tag: u32, // host_function tag
    cleared: bool = false,
};

pub const Timer = struct {
    allocator: Allocator,
    entries: std.ArrayListUnmanaged(Entry),
    next_id: TimerId,
    clock_ms: *const fn () u64,

    pub fn init(allocator: Allocator, clock_ms: *const fn () u64) Timer {
        return .{
            .allocator = allocator,
            .entries = .{},
            .next_id = 1,
            .clock_ms = clock_ms,
        };
    }

    pub fn deinit(self: *Timer) void {
        self.entries.deinit(self.allocator);
    }

    /// 注册一次性 timer（setTimeout）。返回 id。
    pub fn set(self: *Timer, delay_ms: u64, callback_tag: u32) !TimerId {
        const id = self.next_id;
        self.next_id +%= 1;
        const now = self.clock_ms();
        try self.entries.append(self.allocator, .{
            .id = id,
            .deadline_ms = now + delay_ms,
            .repeat_ms = 0,
            .callback_tag = callback_tag,
        });
        return id;
    }

    /// 注册重复 timer（setInterval）。返回 id。
    pub fn setInterval(self: *Timer, period_ms: u64, callback_tag: u32) !TimerId {
        const id = self.next_id;
        self.next_id +%= 1;
        const now = self.clock_ms();
        const period = if (period_ms == 0) 1 else period_ms;
        try self.entries.append(self.allocator, .{
            .id = id,
            .deadline_ms = now + period,
            .repeat_ms = period,
            .callback_tag = callback_tag,
        });
        return id;
    }

    /// 取消 timer。
    pub fn clear(self: *Timer, id: TimerId) void {
        for (self.entries.items) |*e| {
            if (e.id == id) { e.cleared = true; return; }
        }
    }

    /// 查找 timer 对应的 callback tag。
    pub fn callbackTagForId(self: *const Timer, id: TimerId) ?u32 {
        for (self.entries.items) |e| {
            if (e.id == id and !e.cleared) return e.callback_tag;
        }
        return null;
    }

    /// 触发所有到期 timer。
    /// `dispatch` 回调负责调用 HostFn（避免循环依赖 host_function 模块）。
    /// 返回距下一个 timer 的 ms 数；nil = 没有待触发 timer（返回 0）。
    pub fn tick(
        self: *Timer,
        dispatch: *const fn (callback_tag: u32) void,
    ) u32 {
        const now = self.clock_ms();
        var i: usize = 0;
        while (i < self.entries.items.len) {
            const e = &self.entries.items[i];
            if (e.cleared) {
                _ = self.entries.swapRemove(i);
                continue;
            }
            if (now >= e.deadline_ms) {
                const tag = e.callback_tag;
                if (e.repeat_ms > 0) {
                    // setInterval: reschedule
                    e.deadline_ms = now + e.repeat_ms;
                    i += 1;
                } else {
                    _ = self.entries.swapRemove(i);
                }
                dispatch(tag);
            } else {
                i += 1;
            }
        }

        // Compute next deadline
        var next: ?u64 = null;
        for (self.entries.items) |e| {
            if (e.cleared) continue;
            if (next == null or e.deadline_ms < next.?) next = e.deadline_ms;
        }
        if (next) |d| {
            const dist = if (d > now) d - now else 0;
            return @min(@as(u32, @intCast(if (dist > 0x7fff_ffff) 0x7fff_ffff else dist)), 0x7fff_ffff);
        }
        return 0;
    }
};
