//! Console, timers, Bun.* host functions and setupGlobals.

const std = @import("std");
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
const state = @import("state.zig");
const rfs = @import("require_and_fs.zig");
const bundler_abi = @import("bundler_abi.zig");
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// Console helpers
// ──────────────────────────────────────────────────────────

fn consolePrintArgs(args: []const jsi.Value, level: u32) void {
    var buf: std.ArrayListUnmanaged(u8) = .{};
    defer buf.deinit(allocator);
    for (args, 0..) |arg, i| {
        if (i > 0) buf.append(allocator, ' ') catch return;
        const tag = jsi.imports.jsi_typeof(arg.handle);
        switch (tag) {
            4 => { // string
                const len = jsi.imports.jsi_string_length(arg.handle);
                const start = buf.items.len;
                buf.resize(allocator, start + len) catch return;
                jsi.imports.jsi_string_read(arg.handle, @intFromPtr(buf.items.ptr + start), len);
            },
            3 => { // number
                const n = jsi.imports.jsi_to_number(arg.handle);
                if (n == @floor(n) and n >= -1e15 and n <= 1e15) {
                    const i64val: i64 = @intFromFloat(n);
                    var tmp: [32]u8 = undefined;
                    const s = std.fmt.bufPrint(&tmp, "{d}", .{i64val}) catch return;
                    buf.appendSlice(allocator, s) catch return;
                } else {
                    var tmp: [64]u8 = undefined;
                    const s = std.fmt.bufPrint(&tmp, "{d}", .{n}) catch return;
                    buf.appendSlice(allocator, s) catch return;
                }
            },
            2 => { // boolean
                const b = jsi.imports.jsi_to_boolean(arg.handle) != 0;
                buf.appendSlice(allocator, if (b) "true" else "false") catch return;
            },
            0 => buf.appendSlice(allocator, "undefined") catch return,
            1 => buf.appendSlice(allocator, "null") catch return,
            else => buf.appendSlice(allocator, "[object]") catch return,
        }
    }
    buf.append(allocator, '\n') catch return;
    jsi.imports.jsi_print(@intFromPtr(buf.items.ptr), buf.items.len, level);
}

pub fn consoleLogFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

pub fn consoleWarnFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

pub fn consoleErrorFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

pub fn consoleInfoFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

pub fn consoleDebugFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

pub fn urlParseHostFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return jsi.Value.null_;
    const url_str = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(url_str);

    const uri = std.Uri.parse(url_str) catch return jsi.Value.null_;
    const obj = state.runtime_g.makeObject();

    state.runtime_g.setProperty(obj, "href", state.runtime_g.makeString(url_str));
    state.runtime_g.setProperty(obj, "scheme", state.runtime_g.makeString(uri.scheme));
    const protocol = try std.fmt.allocPrint(allocator, "{s}:", .{uri.scheme});
    defer allocator.free(protocol);
    state.runtime_g.setProperty(obj, "protocol", state.runtime_g.makeString(protocol));

    const hostname_str: []const u8 = if (uri.host) |h| switch (h) {
        .raw, .percent_encoded => |ss| ss,
    } else "";
    if (uri.port) |port| {
        const full_host = try std.fmt.allocPrint(allocator, "{s}:{d}", .{ hostname_str, port });
        defer allocator.free(full_host);
        const port_str = try std.fmt.allocPrint(allocator, "{d}", .{port});
        defer allocator.free(port_str);
        state.runtime_g.setProperty(obj, "host",     state.runtime_g.makeString(full_host));
        state.runtime_g.setProperty(obj, "hostname", state.runtime_g.makeString(hostname_str));
        state.runtime_g.setProperty(obj, "port",     state.runtime_g.makeString(port_str));
    } else {
        state.runtime_g.setProperty(obj, "host",     state.runtime_g.makeString(hostname_str));
        state.runtime_g.setProperty(obj, "hostname", state.runtime_g.makeString(hostname_str));
        state.runtime_g.setProperty(obj, "port",     state.runtime_g.makeString(""));
    }

    const path_str: []const u8 = switch (uri.path) { .raw, .percent_encoded => |ss| ss };
    state.runtime_g.setProperty(obj, "pathname",
        state.runtime_g.makeString(if (path_str.len > 0) path_str else "/"));

    if (uri.query) |q| {
        const q_str: []const u8 = switch (q) { .raw, .percent_encoded => |ss| ss };
        const search = try std.fmt.allocPrint(allocator, "?{s}", .{q_str});
        defer allocator.free(search);
        state.runtime_g.setProperty(obj, "search", state.runtime_g.makeString(search));
    } else {
        state.runtime_g.setProperty(obj, "search", state.runtime_g.makeString(""));
    }

    if (uri.fragment) |f| {
        const f_str: []const u8 = switch (f) { .raw, .percent_encoded => |ss| ss };
        const hash = try std.fmt.allocPrint(allocator, "#{s}", .{f_str});
        defer allocator.free(hash);
        state.runtime_g.setProperty(obj, "hash", state.runtime_g.makeString(hash));
    } else {
        state.runtime_g.setProperty(obj, "hash", state.runtime_g.makeString(""));
    }

    state.runtime_g.setProperty(obj, "auth", jsi.Value.null_);
    return obj;
}

// ──────────────────────────────────────────────────────────
// Timer tag tables
// ──────────────────────────────────────────────────────────

/// High bit marks timer callback tags to distinguish from host_function tags.
const TIMER_TAG_BASE: u32 = 0x8000_0000;
const TIMER_TAG_REPEATING: u32 = 0x4000_0000;
const TIMER_TAG_INDEX_MASK: u32 = 0x3fff_ffff;

/// Stores JS fn handles (u32) indexed by slot; slot index is embedded in the tag.
var timer_cb_table: std.ArrayListUnmanaged(u32) = .{};

/// Append `handle` to timer_cb_table and return a packed tag with the slot index.
fn callbackTagForHandle(handle: u32, repeating: bool) !u32 {
    const idx: u32 = @intCast(timer_cb_table.items.len);
    if (idx > TIMER_TAG_INDEX_MASK) return error.OutOfMemory;
    try timer_cb_table.append(allocator, handle);
    return TIMER_TAG_BASE | (if (repeating) TIMER_TAG_REPEATING else @as(u32, 0)) | idx;
}

fn releaseTimerTag(tag: u32) void {
    if ((tag & TIMER_TAG_BASE) == 0) return;
    const idx = tag & TIMER_TAG_INDEX_MASK;
    if (idx >= timer_cb_table.items.len) return;
    const cb_handle = timer_cb_table.items[idx];
    if (cb_handle <= jsi.Value.global.handle) return;
    jsi.imports.jsi_release(cb_handle);
    timer_cb_table.items[idx] = jsi.Value.undefined_.handle;
}

pub fn dispatchTimerCallback(tag: u32) void {
    if ((tag & TIMER_TAG_BASE) == 0) return;
    const is_repeating = (tag & TIMER_TAG_REPEATING) != 0;
    const idx = tag & TIMER_TAG_INDEX_MASK;
    if (idx >= timer_cb_table.items.len) return;
    const cb_handle = timer_cb_table.items[idx];
    if (cb_handle <= jsi.Value.global.handle) return;
    const result = jsi.imports.jsi_call(cb_handle, jsi.Value.undefined_.handle, 0, 0);
    if (result != jsi.Value.exception_sentinel and result > jsi.Value.global.handle) {
        jsi.imports.jsi_release(result);
    }
    if (!is_repeating) releaseTimerTag(tag);
}

pub fn setTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const delay_ms: u64 = if (args.len >= 2)
        @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle)))
    else 0;
    const tag = try callbackTagForHandle(cb_handle, false);
    const id = try state.timer_g.set(delay_ms, tag);
    return state.runtime_g.makeNumber(@floatFromInt(id));
}

pub fn setIntervalFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const period_ms: u64 = if (args.len >= 2)
        @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle)))
    else 0;
    const tag = try callbackTagForHandle(cb_handle, true);
    const id = try state.timer_g.setInterval(period_ms, tag);
    return state.runtime_g.makeNumber(@floatFromInt(id));
}

pub fn clearTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len >= 1) {
        const id: u32 = @intFromFloat(jsi.imports.jsi_to_number(args[0].handle));
        if (state.timer_g.callbackTagForId(id)) |tag| releaseTimerTag(tag);
        state.timer_g.clear(id);
    }
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// Bun.* host functions
// ──────────────────────────────────────────────────────────

pub fn bunFileReadFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return error.JSIException;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const data = state.vfs_g.readFile(path) catch return error.JSIException;
    defer allocator.free(data);
    return state.runtime_g.makeArrayBuffer(data, true);
}

pub fn bunFileSizeFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return state.runtime_g.makeNumber(0);
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const st = state.vfs_g.stat(path) catch return state.runtime_g.makeNumber(0);
    return state.runtime_g.makeNumber(@floatFromInt(st.size));
}

pub fn bunFileWriteFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return state.runtime_g.makeNumber(0);
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const dir = state.pathDirname(path);
    if (!std.mem.eql(u8, dir, "/")) state.vfs_g.mkdir(dir, 0o755) catch {};
    const type_tag = jsi.imports.jsi_typeof(args[1].handle);
    if (type_tag == @intFromEnum(jsi.TypeTag.string)) {
        const data = try state.runtime_g.dupeString(args[1]);
        defer allocator.free(data);
        state.vfs_g.writeFile(path, data, 0o644) catch return error.JSIException;
        return state.runtime_g.makeNumber(@floatFromInt(data.len));
    } else if (type_tag == @intFromEnum(jsi.TypeTag.arraybuffer) or
        type_tag == @intFromEnum(jsi.TypeTag.typed_array))
    {
        const byte_len = jsi.imports.jsi_arraybuffer_byteLength(args[1].handle);
        if (byte_len < 0) return state.runtime_g.makeNumber(0);
        const buf = try allocator.alloc(u8, @intCast(byte_len));
        defer allocator.free(buf);
        const n = jsi.imports.jsi_read_arraybuffer(args[1].handle, @intFromPtr(buf.ptr), @intCast(byte_len));
        if (n < 0) return state.runtime_g.makeNumber(0);
        state.vfs_g.writeFile(path, buf[0..@intCast(n)], 0o644) catch return error.JSIException;
        return state.runtime_g.makeNumber(@floatFromInt(n));
    }
    return state.runtime_g.makeNumber(0);
}

pub fn bunResolveSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return error.JSIException;
    const spec = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(spec);
    const from_raw = try state.runtime_g.dupeString(args[1]);
    defer allocator.free(from_raw);
    const base_dir = state.pathDirname(from_raw);

    if (state.isNodeBuiltin(spec)) {
        const vpath = state.builtinVirtualPath(allocator, spec) catch return error.JSIException;
        defer allocator.free(vpath);
        return state.runtime_g.makeString(vpath);
    }

    const is_bare = !(spec.len == 0 or spec[0] == '.' or spec[0] == '/');
    const resolved: bundler_abi.ResolveResult = if (is_bare) blk: {
        if (bundler_abi.resolveViaTsconfigPaths(allocator, base_dir, spec)) |r| break :blk r else |_| {}
        break :blk bundler_abi.resolveBareInVfs(allocator, base_dir, spec) catch return error.JSIException;
    } else bundler_abi.resolveRelative(allocator, base_dir, spec) catch return error.JSIException;
    defer allocator.free(resolved.path);
    return state.runtime_g.makeString(resolved.path);
}

pub fn bunGunzipSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const byte_len = jsi.imports.jsi_arraybuffer_byteLength(args[0].handle);
    if (byte_len < 0) return error.JSIException;
    const input = try allocator.alloc(u8, @intCast(byte_len));
    defer allocator.free(input);
    const read_n = jsi.imports.jsi_read_arraybuffer(args[0].handle, @intFromPtr(input.ptr), @intCast(byte_len));
    if (read_n < 0) return error.JSIException;
    const decompressed = state.inflateImpl(input[0..@intCast(read_n)], 0) catch return error.JSIException;
    defer allocator.free(decompressed);
    return state.runtime_g.makeArrayBuffer(decompressed, true);
}

pub fn bunTranspileCodeFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return error.JSIException;
    const code = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(code);
    const filename = try state.runtime_g.dupeString(args[1]);
    defer allocator.free(filename);
    const result_h = jsi.imports.jsi_transpile(
        @intFromPtr(code.ptr), code.len,
        @intFromPtr(filename.ptr), filename.len,
    );
    if (result_h == jsi.Value.exception_sentinel) return error.JSIException;
    return .{ .handle = result_h };
}

// ──────────────────────────────────────────────────────────
// setupGlobals
// ──────────────────────────────────────────────────────────

pub fn setupGlobals(rt: *jsi.Runtime) !void {
    timer_cb_table = .{};

    // console
    const console_obj = rt.makeObject();
    const console_fns = [_]struct { name: []const u8, func: jsi.host_function.HostFn }{
        .{ .name = "log",   .func = consoleLogFn   },
        .{ .name = "warn",  .func = consoleWarnFn  },
        .{ .name = "error", .func = consoleErrorFn },
        .{ .name = "info",  .func = consoleInfoFn  },
        .{ .name = "debug", .func = consoleDebugFn },
    };
    inline for (console_fns) |f| {
        const v = try rt.createHostFunction(f.func, f.name, 1);
        rt.setProperty(console_obj, f.name, v);
    }
    rt.setProperty(rt.global, "console", console_obj);

    // require / process.exit — register via __bun_* then finalise with JS
    const require_fn  = try rt.createHostFunction(rfs.requireFn,     "__bun_require",       1);
    const exit_fn     = try rt.createHostFunction(rfs.processExitFn, "__bun_process_exit",  1);
    rt.setProperty(rt.global, "__bun_require",      require_fn);
    rt.setProperty(rt.global, "__bun_process_exit", exit_fn);

    // timers — register via __bun_* then finalise with JS
    const setTimeout_fn   = try rt.createHostFunction(setTimeoutFn,   "__bun_set_timeout",  2);
    const setInterval_fn  = try rt.createHostFunction(setIntervalFn,  "__bun_set_interval", 2);
    const clearTimer_fn   = try rt.createHostFunction(clearTimeoutFn, "__bun_clear_timer",  1);
    rt.setProperty(rt.global, "__bun_set_timeout",  setTimeout_fn);
    rt.setProperty(rt.global, "__bun_set_interval", setInterval_fn);
    rt.setProperty(rt.global, "__bun_clear_timer",  clearTimer_fn);

    // Bun.* host bridges
    const bun_file_read_fn  = try rt.createHostFunction(bunFileReadFn,     "__bun_file_read",    1);
    const bun_file_size_fn  = try rt.createHostFunction(bunFileSizeFn,     "__bun_file_size",    1);
    const bun_file_write_fn = try rt.createHostFunction(bunFileWriteFn,    "__bun_file_write",   2);
    const bun_resolve_fn    = try rt.createHostFunction(bunResolveSyncFn,  "__bun_resolve_sync", 2);
    const bun_gunzip_fn     = try rt.createHostFunction(bunGunzipSyncFn,   "__bun_gunzip_sync",  1);
    const bun_transpile_fn  = try rt.createHostFunction(bunTranspileCodeFn,"__bun_transpile_code", 2);
    const url_parse_fn      = try rt.createHostFunction(urlParseHostFn,    "__bun_url_parse",    1);
    rt.setProperty(rt.global, "__bun_file_read",      bun_file_read_fn);
    rt.setProperty(rt.global, "__bun_file_size",      bun_file_size_fn);
    rt.setProperty(rt.global, "__bun_file_write",     bun_file_write_fn);
    rt.setProperty(rt.global, "__bun_resolve_sync",   bun_resolve_fn);
    rt.setProperty(rt.global, "__bun_gunzip_sync",    bun_gunzip_fn);
    rt.setProperty(rt.global, "__bun_transpile_code", bun_transpile_fn);
    rt.setProperty(rt.global, "__bun_url_parse",      url_parse_fn);

    // JS polyfill: wire __bun_* into process / timers / Bun
    _ = try rt.evalScript(
        \\globalThis.require = globalThis.__bun_require;
        \\delete globalThis.__bun_require;
        \\globalThis.process = {
        \\  version: 'v0.1.0-bun-browser',
        \\  platform: 'browser',
        \\  env: {},
        \\  argv: ['bun'],
        \\  cwd() { return globalThis.__bun_cwd || '/'; },
        \\  exit: globalThis.__bun_process_exit,
        \\  nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); },
        \\};
        \\globalThis.__bun_cwd = '/';
        \\delete globalThis.__bun_process_exit;
        \\globalThis.setTimeout   = globalThis.__bun_set_timeout;
        \\globalThis.setInterval  = globalThis.__bun_set_interval;
        \\globalThis.clearTimeout  = globalThis.__bun_clear_timer;
        \\globalThis.clearInterval = globalThis.__bun_clear_timer;
        \\delete globalThis.__bun_set_timeout;
        \\delete globalThis.__bun_set_interval;
        \\delete globalThis.__bun_clear_timer;
    ,
        "<bun-browser:polyfill>",
    );

    // Buffer polyfill (sets global.Buffer)
    _ = try rt.evalScript(rfs.BUFFER_POLYFILL_SRC, "<bun-browser:buffer>");
    // Bun global polyfill (sets Bun.hash, etc.)
    _ = try rt.evalScript(rfs.BUN_GLOBAL_SRC, "<bun-browser:Bun>");
}
