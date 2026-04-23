//! Core WASM ABI (init, tick, VFS, run/eval, spawn, host-invoke, malloc/free).

const std = @import("std");
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
const Timer = @import("../timer.zig").Timer;
const state = @import("state.zig");
const host = @import("host_setup.zig");
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// init
// ──────────────────────────────────────────────────────────

pub fn init() void {
    if (state.initialized) return;
    state.initialized = true;

    state.vfs_g   = sys_wasm.VFS.init(allocator, &state.clockMs) catch @panic("VFS init OOM");
    state.runtime_g = jsi.Runtime.init(allocator);
    state.loader_g  = state.ModuleLoader.init(allocator, &state.vfs_g, &state.runtime_g);
    state.timer_g   = Timer.init(allocator, &state.clockMs);
    host.setupGlobals(&state.runtime_g) catch @panic("setupGlobals OOM");
}

// ──────────────────────────────────────────────────────────
// tick / wakeup
// ──────────────────────────────────────────────────────────

/// T5.12.1: Shared notify slot for blocking bun_tick() in threaded mode.
/// Sits in WASM linear memory; with a SAB-backed build the JS host can call
/// Atomics.notify() on this address to wake a thread blocked in jsi_atomic_wait.
/// In single-threaded mode this variable is never written from another thread,
/// so the atomic_wait call is never reached (capability bit1 == 0).
pub var tick_notify: i32 = 0;

/// T5.12.1: Return the WASM linear memory byte address of `tick_notify`.
/// The JS host uses this to compute the Int32Array index for Atomics.notify:
///   `const idx = bun_tick_notify_ptr() >>> 2;`
///   `Atomics.store(i32view, idx, 1); Atomics.notify(i32view, idx, 1);`
/// Only meaningful in the SAB-backed threads build (bun-core.threads.wasm).
pub fn tickNotifyPtr() u32 {
    return @intCast(@intFromPtr(&tick_notify));
}

pub fn tick() u32 {
    if (!state.initialized) return 0;
    const next_ms = state.timer_g.tick(&host.dispatchTimerCallback);

    // T5.12.1: In threaded mode (bit1 of jsi_thread_capability = Worker+waitSync),
    // block via jsi_atomic_wait when there are no timers due.
    // In single-threaded mode (bit1 == 0) this branch is never taken — safe no-op.
    if (next_ms > 0) {
        const cap = jsi.imports.jsi_thread_capability();
        if ((cap & 0b10) != 0) {
            // Reset slot so a missed notify before wait → immediate return.
            @atomicStore(i32, &tick_notify, 0, .seq_cst);
            // Block until notified or timeout; cap at 0xFFFFFFFE to avoid u32 sentinel.
            const timeout: u32 = if (next_ms > 0xFFFFFFFE) 0xFFFFFFFE else @intCast(next_ms);
            _ = jsi.imports.jsi_atomic_wait(
                @intCast(@intFromPtr(&tick_notify)),
                0,
                timeout,
            );
            // After waking, drive the timer queue once more.
            return state.timer_g.tick(&host.dispatchTimerCallback);
        }
    }
    return next_ms;
}

// ──────────────────────────────────────────────────────────
// VFS snapshot
// ──────────────────────────────────────────────────────────

pub fn vfsLoadSnapshot(ptr: [*]const u8, len: u32) u32 {
    if (!state.initialized) return 0;
    const count = state.vfs_g.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

pub fn vfsDumpSnapshot() u64 {
    if (!state.initialized) return 0;
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    _ = state.vfs_g.exportSnapshot(&out) catch return 0;
    const snapshot_len = out.items.len;
    if (snapshot_len == 0) return 0;
    const buf = allocator.dupe(u8, out.items) catch return 0;
    return state.handOff(buf);
}

pub fn vfsReadFile(path_ptr: [*]const u8, path_len: u32) u64 {
    if (!state.initialized) return 0;
    const path = path_ptr[0..path_len];
    const data = state.vfs_g.readFile(path) catch return 0;
    return state.handOff(data);
}

// ──────────────────────────────────────────────────────────
// run / eval
// ──────────────────────────────────────────────────────────

pub fn browserRun(path_ptr: [*]const u8, path_len: u32) i32 {
    if (!state.initialized) return 1;
    state.g_exit_code = 0;
    state.g_explicit_exit = false;
    const path = path_ptr[0..path_len];
    state.loader_g.current_dir = state.pathDirname(path);
    const handle = state.loader_g.load(path) catch {
        return if (state.g_explicit_exit) state.g_exit_code else 2;
    };
    jsi.imports.jsi_release(handle);
    return if (state.g_explicit_exit) state.g_exit_code else 0;
}

pub fn browserEval(src_ptr: [*]const u8, src_len: u32, file_ptr: [*]const u8, file_len: u32) i32 {
    if (!state.initialized) return 1;
    const src  = src_ptr[0..src_len];
    const file = file_ptr[0..file_len];
    const result = jsi.imports.jsi_eval(
        @intFromPtr(src.ptr),  src.len,
        @intFromPtr(file.ptr), file.len,
    );
    if (result == jsi.Value.exception_sentinel) return 3;
    jsi.imports.jsi_release(result);
    return 0;
}

// ──────────────────────────────────────────────────────────
// spawn / kill / stdin stubs
// ──────────────────────────────────────────────────────────

pub fn spawn(cmd_ptr: [*]const u8, cmd_len: u32) i32 {
    if (!state.initialized) return 1;

    const cmd_json = cmd_ptr[0..cmd_len];

    const json_val = state.runtime_g.makeString(cmd_json);
    defer jsi.imports.jsi_release(json_val.handle);
    state.runtime_g.setProperty(state.runtime_g.global, "__spawn_cmd", json_val);

    const parse_src = "var __r=JSON.parse(globalThis.__spawn_cmd);delete globalThis.__spawn_cmd;return __r;";
    const arr = state.runtime_g.evalScript(parse_src, "<spawn:parse>") catch return 2;
    defer jsi.imports.jsi_release(arr.handle);

    const len_val = state.runtime_g.getProperty(arr, "length");
    defer jsi.imports.jsi_release(len_val.handle);
    const argc: u32 = @intFromFloat(jsi.imports.jsi_to_number(len_val.handle));
    if (argc == 0) return 1;

    const cmd0 = state.runtime_g.getIndex(arr, 0);
    defer jsi.imports.jsi_release(cmd0.handle);
    if (jsi.imports.jsi_typeof(cmd0.handle) != @intFromEnum(jsi.TypeTag.string)) return 1;
    const exe = state.runtime_g.dupeString(cmd0) catch return 2;
    defer allocator.free(exe);
    if (!std.mem.eql(u8, exe, "bun")) return 1;

    if (argc < 2) return 0;

    const cmd1 = state.runtime_g.getIndex(arr, 1);
    defer jsi.imports.jsi_release(cmd1.handle);
    const subcmd = state.runtime_g.dupeString(cmd1) catch return 2;
    defer allocator.free(subcmd);

    state.g_exit_code = 0;
    state.g_explicit_exit = false;

    if (std.mem.eql(u8, subcmd, "-e")) {
        if (argc < 3) return 0;
        const code_val = state.runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(code_val.handle);
        const code_src = state.runtime_g.dupeString(code_val) catch return 2;
        defer allocator.free(code_src);
        const url_lit = "<bun:-e>";
        const result = jsi.imports.jsi_eval(
            @intFromPtr(code_src.ptr), code_src.len,
            @intFromPtr(url_lit.ptr), url_lit.len,
        );
        if (result != jsi.Value.exception_sentinel) jsi.imports.jsi_release(result);
        return if (state.g_explicit_exit) state.g_exit_code else 0;
    }

    if (std.mem.eql(u8, subcmd, "run")) {
        if (argc < 3) return 1;
        const file_val = state.runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(file_val.handle);
        const file = state.runtime_g.dupeString(file_val) catch return 2;
        defer allocator.free(file);
        state.loader_g.current_dir = state.pathDirname(file);
        const handle = state.loader_g.load(file) catch {
            return if (state.g_explicit_exit) state.g_exit_code else 2;
        };
        jsi.imports.jsi_release(handle);
        return if (state.g_explicit_exit) state.g_exit_code else 0;
    }

    return 0;
}

pub fn kill(_: u32, _: u32) void {}
pub fn feedStdin(_: u32, _: [*]const u8, _: u32) void {}
pub fn closeStdin(_: u32) void {}

// ──────────────────────────────────────────────────────────
// T5.12.4: Thread entry point + dispatch table
// ──────────────────────────────────────────────────────────

/// Maximum concurrent threads supported by the dispatch table.
const MAX_THREADS = 64;

/// Thread function record.  `func` is the Zig thread body; `ctx` the argument.
const ThreadEntry = struct {
    func: *const fn (ctx: *anyopaque) void,
    ctx:  *anyopaque,
};

var thread_dispatch_table: [MAX_THREADS]ThreadEntry = undefined;
var thread_dispatch_table_len: u32 = 0;

/// T5.12.4: Register a thread dispatch entry before calling jsi_thread_spawn().
/// Returns the index to pass as the `arg` parameter to jsi_thread_spawn().
/// Panics if the table is full.
pub fn registerThreadEntry(func: *const fn (ctx: *anyopaque) void, ctx: *anyopaque) u32 {
    const idx = thread_dispatch_table_len;
    if (idx >= MAX_THREADS) @panic("thread dispatch table full");
    thread_dispatch_table[idx] = .{ .func = func, .ctx = ctx };
    thread_dispatch_table_len += 1;
    return idx;
}

/// T5.12.4: Entry point called by the host Worker after jsi_thread_spawn(arg).
///
/// Each Worker that implements a spawned thread will call
/// `bun_thread_entry(arg)` on its own WASM Instance, where `arg` is the
/// value returned by `registerThreadEntry()` — i.e. the dispatch table index.
///
/// Thread init note: every spawned Worker creates a fresh WasmRuntime (independent
/// linear memory + JSI handle space) loaded with the same VFS snapshot.
/// The thread does NOT share the main instance's globals; it is a truly isolated
/// compute thread that communicates via SAB channels (T5.12.2 rings or custom SABs).
pub fn threadEntry(arg: u32) void {
    // Initialise basic state for this thread instance.
    if (!state.initialized) {
        state.initialized = true;
        state.vfs_g   = sys_wasm.VFS.init(allocator, &state.clockMs) catch return;
        state.runtime_g = jsi.Runtime.init(allocator);
        state.loader_g  = state.ModuleLoader.init(allocator, &state.vfs_g, &state.runtime_g);
        state.timer_g   = Timer.init(allocator, &state.clockMs);
    }

    if (thread_dispatch_table_len == 0) return;
    const idx = arg % thread_dispatch_table_len;
    const entry = thread_dispatch_table[idx];
    entry.func(entry.ctx);
}

// ──────────────────────────────────────────────────────────
// JSI host dispatch
// ──────────────────────────────────────────────────────────

pub fn jsiHostInvoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 {
    if (!state.initialized) return jsi.Value.exception_sentinel;

    var args_tmp: [64]u32 = undefined;
    const safe_count = @min(argc, args_tmp.len);
    for (0..safe_count) |i| args_tmp[i] = argv_ptr[i];

    state.host_arg_scratch.clearRetainingCapacity();
    state.host_arg_scratch.append(allocator, this_handle) catch return jsi.Value.exception_sentinel;
    state.host_arg_scratch.appendSlice(allocator, args_tmp[0..safe_count]) catch return jsi.Value.exception_sentinel;

    return jsi.host_function.dispatchHostFn(
        &state.runtime_g.host_fns,
        @as(*anyopaque, @ptrCast(&state.runtime_g)),
        fn_id,
        state.host_arg_scratch.items,
    );
}

pub fn jsiHostArgScratch(argc: u32) [*]u32 {
    state.host_arg_scratch.clearRetainingCapacity();
    state.host_arg_scratch.resize(allocator, argc) catch @panic("host_arg_scratch OOM");
    return state.host_arg_scratch.items.ptr;
}

// ──────────────────────────────────────────────────────────
// WASM malloc / free
// ──────────────────────────────────────────────────────────

pub fn wasmMalloc(n: u32) u32 {
    const alloc_len: usize = if (n == 0) 1 else n;
    const buf = allocator.alloc(u8, alloc_len) catch return 0;
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));
    state.host_allocs.put(allocator, ptr, alloc_len) catch {
        allocator.free(buf);
        return 0;
    };
    return ptr;
}

pub fn wasmFree(ptr: u32) void {
    if (state.host_allocs.fetchRemove(ptr)) |entry| {
        const p: [*]u8 = @ptrFromInt(entry.key);
        allocator.free(p[0..entry.value]);
    }
}
