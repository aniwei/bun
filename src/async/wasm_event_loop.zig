//! WASM Event Loop —— 浏览器运行时的异步事件循环实现。
//!
//! 设计原则：
//!   - 单线程（WASM 限制），无 epoll/kqueue，无真实 FD 轮询
//!   - 定时器由 Zig 侧最小堆驱动，每次 `tick()` 弹出所有到期回调
//!   - I/O 完成由 Host(TS) 侧通过 JSI 回调通知 → `addTask()` 入队
//!   - `requestTick()` 调用 Host 侧 `jsi_schedule_microtask()` 以在下一微任务执行 `tick()`
//!
//! 接口对齐：导出与 `posix_event_loop.zig` / `windows_event_loop.zig` 相同的
//! `Loop`、`KeepAlive`、`FilePoll`、`Waker`、`Closer` 公开声明。

const std = @import("std");
const Allocator = std.mem.Allocator;

// ──────────────────────────────────────────────────────────
// Task / Timer 基础类型
// ──────────────────────────────────────────────────────────

pub const TaskCallback = *const fn (ctx: ?*anyopaque) void;

const TimerEntry = struct {
    deadline_ms: u64,
    callback: TaskCallback,
    ctx: ?*anyopaque,
    id: u32,
    cancelled: bool,
};

fn timerOrder(_: void, a: TimerEntry, b: TimerEntry) std.math.Order {
    return std.math.order(a.deadline_ms, b.deadline_ms);
}

const TaskEntry = struct {
    callback: TaskCallback,
    ctx: ?*anyopaque,
};

// ──────────────────────────────────────────────────────────
// Loop
// ──────────────────────────────────────────────────────────

pub const Loop = struct {
    allocator: Allocator,
    timers: std.PriorityQueue(TimerEntry, void, timerOrder),
    tasks: std.array_list.Managed(TaskEntry),
    cancelled_timers: std.AutoHashMap(u32, void),
    next_timer_id: u32,
    now_ms: u64,
    active_count: u32,
    alive: bool,
    clock_ms: *const fn () u64,
    iteration: u64,

    pub fn init(allocator: Allocator, clock_ms: *const fn () u64) Loop {
        return .{
            .allocator = allocator,
            .timers = std.PriorityQueue(TimerEntry, void, timerOrder).init(allocator, {}),
            .tasks = std.array_list.Managed(TaskEntry).init(allocator),
            .cancelled_timers = std.AutoHashMap(u32, void).init(allocator),
            .next_timer_id = 1,
            .now_ms = clock_ms(),
            .active_count = 0,
            .alive = true,
            .clock_ms = clock_ms,
            .iteration = 0,
        };
    }

    pub fn deinit(self: *Loop) void {
        self.timers.deinit();
        self.tasks.deinit();
        self.cancelled_timers.deinit();
    }

    /// 更新当前时间快照。应在每次 tick 开始时调用。
    pub fn updateTime(self: *Loop) void {
        self.now_ms = self.clock_ms();
    }

    pub fn iterationNumber(self: *const Loop) u64 {
        return self.iteration;
    }

    pub fn isActive(self: *const Loop) bool {
        return self.active_count > 0;
    }

    pub fn ref(self: *Loop) void {
        self.active_count += 1;
    }

    pub fn unref(self: *Loop) void {
        if (self.active_count > 0) self.active_count -= 1;
    }

    pub fn addActive(self: *Loop, value: u32) void {
        self.active_count += value;
    }

    pub fn subActive(self: *Loop, value: u32) void {
        self.active_count -|= value;
    }

    // ── Timer API ───────────────────────────────────────

    pub fn addTimer(self: *Loop, delay_ms: u64, callback: TaskCallback, ctx: ?*anyopaque) !u32 {
        const id = self.next_timer_id;
        self.next_timer_id += 1;
        try self.timers.add(.{
            .deadline_ms = self.now_ms + delay_ms,
            .callback = callback,
            .ctx = ctx,
            .id = id,
            .cancelled = false,
        });
        return id;
    }

    /// 惰性取消：登记到 cancel set，tick 时跳过。
    /// PriorityQueue 不支持按 id 高效删除，惰性方案足矣。
    pub fn cancelTimer(self: *Loop, id: u32) void {
        self.cancelled_timers.put(id, {}) catch {};
    }

    // ── Task API ────────────────────────────────────────

    pub fn addTask(self: *Loop, callback: TaskCallback, ctx: ?*anyopaque) !void {
        try self.tasks.append(.{ .callback = callback, .ctx = ctx });
    }

    // ── Tick ────────────────────────────────────────────

    /// 执行一次事件循环迭代：
    ///   1. 刷新即时任务队列
    ///   2. 弹出所有已到期的定时器并执行回调
    ///   返回：距下一个定时器的毫秒数；0 表示无待处理定时器
    pub fn tick(self: *Loop) u32 {
        self.iteration += 1;
        self.updateTime();

        // 1. 执行所有即时任务
        while (self.tasks.items.len > 0) {
            // 复制到临时切片，因为回调可能添加新任务
            const batch = self.tasks.toOwnedSlice() catch break;
            defer self.allocator.free(batch);
            for (batch) |task| {
                task.callback(task.ctx);
            }
        }

        // 2. 弹出所有到期定时器
        while (self.timers.count() > 0) {
            const top = self.timers.peek().?;
            if (top.deadline_ms > self.now_ms) break;
            const entry = self.timers.remove();
            if (self.cancelled_timers.remove(entry.id)) {
                continue;
            }
            entry.callback(entry.ctx);
        }

        // 3. 计算距下一个定时器的时间
        if (self.timers.count() > 0) {
            const next = self.timers.peek().?;
            if (next.deadline_ms <= self.now_ms) return 1; // 已过期
            return @intCast(next.deadline_ms - self.now_ms);
        }
        return 0;
    }

    /// 是否还有待处理的工作（定时器或任务或活跃引用）。
    pub fn hasPendingWork(self: *const Loop) bool {
        return self.timers.count() > 0 or self.tasks.items.len > 0 or self.active_count > 0;
    }

    pub fn run(self: *Loop) void {
        while (self.alive and self.hasPendingWork()) {
            _ = self.tick();
        }
    }

    pub fn stop(self: *Loop) void {
        self.alive = false;
    }
};

// ──────────────────────────────────────────────────────────
// KeepAlive
// ──────────────────────────────────────────────────────────

pub const KeepAlive = struct {
    status: Status = .inactive,

    pub const Status = enum { active, inactive, done };

    pub fn init() KeepAlive {
        return .{ .status = .inactive };
    }

    pub fn isActive(self: KeepAlive) bool {
        return self.status == .active;
    }

    pub fn disable(self: *KeepAlive) void {
        self.status = .done;
    }

    pub fn activate(self: *KeepAlive, loop: *Loop) void {
        if (self.status != .active) {
            self.status = .active;
            loop.ref();
        }
    }

    pub fn deactivate(self: *KeepAlive, loop: *Loop) void {
        if (self.status == .active) {
            self.status = .inactive;
            loop.unref();
        }
    }

    /// ref — 使此 KeepAlive 保持事件循环活跃。
    /// 接受 anytype 以兼容 posix_event_loop 的 API（在 WASM 下忽略 VM 参数）。
    pub fn ref(self: *KeepAlive, event_loop_ctx_: anytype) void {
        _ = event_loop_ctx_;
        if (self.status != .active and self.status != .done) {
            self.status = .active;
        }
    }

    pub fn unref(self: *KeepAlive, event_loop_ctx_: anytype) void {
        _ = event_loop_ctx_;
        if (self.status == .active) {
            self.status = .inactive;
        }
    }

    // WASM 单线程，Concurrently 变体与普通版相同
    pub fn refConcurrently(self: *KeepAlive, ctx: anytype) void {
        self.ref(ctx);
    }

    pub fn unrefConcurrently(self: *KeepAlive, ctx: anytype) void {
        self.unref(ctx);
    }

    pub fn unrefOnNextTick(self: *KeepAlive, ctx: anytype) void {
        self.unref(ctx);
    }

    pub fn unrefOnNextTickConcurrently(self: *KeepAlive, ctx: anytype) void {
        self.unref(ctx);
    }

    pub fn refConcurrentlyFromEventLoop(self: *KeepAlive, ctx: anytype) void {
        self.ref(ctx);
    }

    pub fn unrefConcurrentlyFromEventLoop(self: *KeepAlive, ctx: anytype) void {
        self.unref(ctx);
    }
};

// ──────────────────────────────────────────────────────────
// FilePoll — WASM 下无真实 FD 轮询，提供 stub 接口
// ──────────────────────────────────────────────────────────

pub const FilePoll = struct {
    fd: i32 = -1,
    status: PollStatus = .idle,
    keep_alive: bool = false,

    pub const PollStatus = enum { idle, watching, ready, closed };

    pub fn isActive(self: *const FilePoll) bool {
        return self.status == .watching or self.status == .ready;
    }

    pub fn isRegistered(self: *const FilePoll) bool {
        return self.status != .idle and self.status != .closed;
    }

    pub fn fileDescriptor(self: *const FilePoll) i32 {
        return self.fd;
    }

    pub fn ref(self: *FilePoll, _: anytype) void {
        self.keep_alive = true;
    }

    pub fn unref(self: *FilePoll, _: anytype) void {
        self.keep_alive = false;
    }

    pub fn deinit(self: *FilePoll) void {
        self.status = .closed;
    }
};

// ──────────────────────────────────────────────────────────
// Waker — WASM 单线程，无跨线程唤醒需求
// ──────────────────────────────────────────────────────────

pub const Waker = struct {
    pending: bool = false,

    pub fn init() !Waker {
        return .{};
    }

    pub fn wake(self: *Waker) void {
        self.pending = true;
    }

    pub fn reset(self: *Waker) void {
        self.pending = false;
    }

    pub fn isPending(self: *const Waker) bool {
        return self.pending;
    }
};

// ──────────────────────────────────────────────────────────
// Closer — WASM 下 fd close 为 no-op（VFS 自行管理）
// ──────────────────────────────────────────────────────────

pub const Closer = struct {
    pub fn close(_: i32) void {
        // VFS fd 的关闭由 sys_wasm/vfs.zig 管理
    }
};

// ──────────────────────────────────────────────────────────
// 单元测试
// ──────────────────────────────────────────────────────────

var test_clock_value: u64 = 0;

fn testClock() u64 {
    return test_clock_value;
}

test "Loop basic tick empty" {
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    const wait = loop.tick();
    try std.testing.expectEqual(@as(u32, 0), wait);
    try std.testing.expectEqual(@as(u64, 1), loop.iterationNumber());
}

test "Loop timer fires on tick" {
    test_clock_value = 100;
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    var fired: bool = false;
    const cb = struct {
        fn callback(ctx: ?*anyopaque) void {
            const ptr: *bool = @ptrCast(@alignCast(ctx.?));
            ptr.* = true;
        }
    }.callback;

    _ = try loop.addTimer(50, cb, @ptrCast(&fired)); // deadline = 150

    // tick 时 now=100, deadline=150 → 不触发
    const wait1 = loop.tick();
    try std.testing.expect(!fired);
    try std.testing.expectEqual(@as(u32, 50), wait1);

    // 推进时间到 160
    test_clock_value = 160;
    const wait2 = loop.tick();
    try std.testing.expect(fired);
    try std.testing.expectEqual(@as(u32, 0), wait2); // 无更多定时器
}

test "Loop task executes on tick" {
    test_clock_value = 0;
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    var counter: u32 = 0;
    const cb = struct {
        fn callback(ctx: ?*anyopaque) void {
            const ptr: *u32 = @ptrCast(@alignCast(ctx.?));
            ptr.* += 1;
        }
    }.callback;

    try loop.addTask(cb, @ptrCast(&counter));
    try loop.addTask(cb, @ptrCast(&counter));

    _ = loop.tick();
    try std.testing.expectEqual(@as(u32, 2), counter);
}

test "Loop multiple timers fire in order" {
    test_clock_value = 0;
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    var order = std.array_list.Managed(u32).init(std.testing.allocator);
    defer order.deinit();

    const T = struct {
        fn make(val: u32) TaskCallback {
            return switch (val) {
                1 => &cb1,
                2 => &cb2,
                3 => &cb3,
                else => unreachable,
            };
        }
        fn cb1(ctx: ?*anyopaque) void {
            const list: *std.array_list.Managed(u32) = @ptrCast(@alignCast(ctx.?));
            list.append(1) catch {};
        }
        fn cb2(ctx: ?*anyopaque) void {
            const list: *std.array_list.Managed(u32) = @ptrCast(@alignCast(ctx.?));
            list.append(2) catch {};
        }
        fn cb3(ctx: ?*anyopaque) void {
            const list: *std.array_list.Managed(u32) = @ptrCast(@alignCast(ctx.?));
            list.append(3) catch {};
        }
    };

    _ = try loop.addTimer(300, T.make(3), @ptrCast(&order));
    _ = try loop.addTimer(100, T.make(1), @ptrCast(&order));
    _ = try loop.addTimer(200, T.make(2), @ptrCast(&order));

    // tick at 0 → nothing fires
    _ = loop.tick();
    try std.testing.expectEqual(@as(usize, 0), order.items.len);

    // tick at 250 → timer 1 and 2 fire
    test_clock_value = 250;
    _ = loop.tick();
    try std.testing.expectEqual(@as(usize, 2), order.items.len);
    try std.testing.expectEqual(@as(u32, 1), order.items[0]);
    try std.testing.expectEqual(@as(u32, 2), order.items[1]);

    // tick at 400 → timer 3 fires
    test_clock_value = 400;
    _ = loop.tick();
    try std.testing.expectEqual(@as(usize, 3), order.items.len);
    try std.testing.expectEqual(@as(u32, 3), order.items[2]);
}

test "KeepAlive ref/unref" {
    var ka = KeepAlive.init();
    try std.testing.expect(!ka.isActive());

    ka.ref({});
    try std.testing.expect(ka.isActive());

    ka.unref({});
    try std.testing.expect(!ka.isActive());

    ka.disable();
    try std.testing.expectEqual(KeepAlive.Status.done, ka.status);

    // ref after disable is no-op
    ka.ref({});
    try std.testing.expectEqual(KeepAlive.Status.done, ka.status);
}

test "KeepAlive activate/deactivate with Loop" {
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    var ka = KeepAlive.init();
    try std.testing.expect(!loop.isActive());

    ka.activate(&loop);
    try std.testing.expect(loop.isActive());
    try std.testing.expectEqual(@as(u32, 1), loop.active_count);

    ka.deactivate(&loop);
    try std.testing.expect(!loop.isActive());
    try std.testing.expectEqual(@as(u32, 0), loop.active_count);
}

test "Waker basic" {
    var waker = try Waker.init();
    try std.testing.expect(!waker.isPending());

    waker.wake();
    try std.testing.expect(waker.isPending());

    waker.reset();
    try std.testing.expect(!waker.isPending());
}

test "Loop hasPendingWork" {
    test_clock_value = 0;
    var loop = Loop.init(std.testing.allocator, &testClock);
    defer loop.deinit();

    try std.testing.expect(!loop.hasPendingWork());

    const noop = struct {
        fn callback(_: ?*anyopaque) void {}
    }.callback;

    _ = try loop.addTimer(100, noop, null);
    try std.testing.expect(loop.hasPendingWork());
}
