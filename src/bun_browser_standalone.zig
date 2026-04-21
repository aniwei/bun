//! Bun Browser Runtime — Standalone WASM entry point.
//!
//! This is a self-contained version of `bun_browser.zig` that does NOT
//! import `@import("bun")`.  It can be compiled by `build-wasm-smoke.zig`
//! (or any lightweight build script) into a real `bun-core.wasm` binary
//! without pulling in the full Bun dependency graph (JSC, libuv, etc.).
//!
//! Exported ABI (consumed by packages/bun-browser/src/kernel-worker.ts):
//!
//!   bun_browser_init()                     — one-time runtime init
//!   bun_browser_run(ptr, len) i32          — run an entry path from VFS
//!   bun_browser_eval(sp,sl,fp,fl) i32      — eval raw JS source
//!   bun_vfs_load_snapshot(ptr, len) u32    — load VFS snapshot
//!   bun_tick() u32                         — drive event loop; returns ms until next timer (0=idle)
//!   bun_vfs_write(p,pl,d,dl) i32           — write a file into VFS from Host
//!   jsi_host_invoke(id,this,argv,argc) u32 — HostFn dispatch
//!   jsi_host_arg_scratch(argc) [*]u32      — HostFn argv scratch
//!   bun_malloc(n) u32                      — linear-memory alloc (for host)
//!   bun_free(ptr)                          — linear-memory free

const std = @import("std");
const Timer = @import("timer.zig").Timer;

// ── External JSI / sys_wasm imports (injected via build module map) ──
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");

// ── Allocator: wasm_allocator grows the wasm linear memory via memory.grow ──
const allocator = std.heap.wasm_allocator;

// ──────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────

var vfs_g: sys_wasm.VFS = undefined;
var runtime_g: jsi.Runtime = undefined;
var loader_g: ModuleLoader = undefined;
var timer_g: Timer = undefined;
var host_arg_scratch: std.ArrayListUnmanaged(u32) = .{};
var initialized: bool = false;
var g_exit_code: i32 = 0;
var g_explicit_exit: bool = false;


/// Host clock — provided by `env.jsi_now_ms`.
extern "env" fn jsi_now_ms() u64;

fn clockMs() u64 {
    return jsi_now_ms();
}



// ──────────────────────────────────────────────────────────
// Path utilities  (identical to bun_browser.zig)
// ──────────────────────────────────────────────────────────

fn normPath(alloc: std.mem.Allocator, path: []const u8) std.mem.Allocator.Error![]u8 {
    var parts: std.ArrayListUnmanaged([]const u8) = .{};
    defer parts.deinit(alloc);

    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |seg| {
        if (seg.len == 0 or std.mem.eql(u8, seg, ".")) continue;
        if (std.mem.eql(u8, seg, "..")) {
            if (parts.items.len > 0) parts.shrinkRetainingCapacity(parts.items.len - 1);
        } else {
            try parts.append(alloc, seg);
        }
    }

    var buf: std.ArrayListUnmanaged(u8) = .{};
    for (parts.items) |seg| {
        try buf.append(alloc, '/');
        try buf.appendSlice(alloc, seg);
    }
    if (buf.items.len == 0) try buf.append(alloc, '/');
    return buf.toOwnedSlice(alloc);
}

fn joinPath(alloc: std.mem.Allocator, base_dir: []const u8, rel: []const u8) ![]u8 {
    if (rel.len > 0 and rel[0] == '/') return alloc.dupe(u8, rel);
    const combined = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ base_dir, rel });
    defer alloc.free(combined);
    return normPath(alloc, combined);
}

fn pathDirname(path: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, path, '/')) |idx| {
        return if (idx == 0) "/" else path[0..idx];
    }
    return "/";
}

// ──────────────────────────────────────────────────────────
// CJS Module Loader
// ──────────────────────────────────────────────────────────

const ModuleLoader = struct {
    alloc: std.mem.Allocator,
    vfs: *sys_wasm.VFS,
    rt: *jsi.Runtime,
    cache: std.StringHashMap(u32),
    current_dir: []const u8,

    fn init(alloc_: std.mem.Allocator, v: *sys_wasm.VFS, rt: *jsi.Runtime) ModuleLoader {
        return .{
            .alloc = alloc_,
            .vfs = v,
            .rt = rt,
            .cache = std.StringHashMap(u32).init(alloc_),
            .current_dir = "/",
        };
    }

    fn resolve(self: *ModuleLoader, specifier: []const u8) ![]u8 {
        const abs = try joinPath(self.alloc, self.current_dir, specifier);
        errdefer self.alloc.free(abs);

        if (self.vfs.stat(abs)) |_| return abs else |_| {}

        for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json" }) |ext| {
            const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ abs, ext });
            if (self.vfs.stat(with_ext)) |_| {
                self.alloc.free(abs);
                return with_ext;
            } else |_| self.alloc.free(with_ext);
        }

        return error.ModuleNotFound;
    }

    fn load(self: *ModuleLoader, specifier: []const u8) !u32 {
        const abs_path = try self.resolve(specifier);
        defer self.alloc.free(abs_path);

        if (self.cache.get(abs_path)) |h| return h;

        const source = try self.vfs.readFile(abs_path);
        defer self.alloc.free(source);

        // JSON: eval as expression
        if (std.mem.endsWith(u8, abs_path, ".json")) {
            const eval_code = try std.fmt.allocPrint(self.alloc, "return ({s})", .{source});
            defer self.alloc.free(eval_code);
            const result_handle = jsi.imports.jsi_eval(
                @intFromPtr(eval_code.ptr),
                eval_code.len,
                @intFromPtr(abs_path.ptr),
                abs_path.len,
            );
            if (result_handle == jsi.Value.exception_sentinel) return error.JSIException;
            _ = jsi.imports.jsi_retain(result_handle);
            const key = try self.alloc.dupe(u8, abs_path);
            try self.cache.put(key, result_handle);
            return result_handle;
        }

        // TypeScript: transpile first
        const is_ts = std.mem.endsWith(u8, abs_path, ".ts") or
            std.mem.endsWith(u8, abs_path, ".tsx") or
            std.mem.endsWith(u8, abs_path, ".mts") or
            std.mem.endsWith(u8, abs_path, ".cts");
        const js_source: []const u8 = if (is_ts) blk: {
            const h = jsi.imports.jsi_transpile(
                @intFromPtr(source.ptr),
                source.len,
                @intFromPtr(abs_path.ptr),
                abs_path.len,
            );
            if (h == jsi.Value.exception_sentinel) return error.JSIException;
            defer jsi.imports.jsi_release(h);
            const js_len = jsi.imports.jsi_string_length(h);
            const js_buf = try self.alloc.alloc(u8, js_len);
            jsi.imports.jsi_string_read(h, @intFromPtr(js_buf.ptr), js_len);
            break :blk js_buf;
        } else source;
        defer if (is_ts) self.alloc.free(js_source);

        // Wrap in CJS
        const wrapper = try std.fmt.allocPrint(
            self.alloc,
            "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.require);return __m.exports;",
            .{js_source},
        );
        defer self.alloc.free(wrapper);

        const saved_dir = self.current_dir;
        self.current_dir = pathDirname(abs_path);
        const result_handle = jsi.imports.jsi_eval(
            @intFromPtr(wrapper.ptr),
            wrapper.len,
            @intFromPtr(abs_path.ptr),
            abs_path.len,
        );
        self.current_dir = saved_dir;

        if (result_handle == jsi.Value.exception_sentinel) return error.JSIException;
        _ = jsi.imports.jsi_retain(result_handle);
        const key = try self.alloc.dupe(u8, abs_path);
        try self.cache.put(key, result_handle);
        return result_handle;
    }
};

// ──────────────────────────────────────────────────────────
// process.exit HostFn
// ──────────────────────────────────────────────────────────

fn processExitFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    const code: f64 = if (args.len > 0) jsi.imports.jsi_to_number(args[0].handle) else 0;
    g_exit_code = @intFromFloat(@trunc(code));
    g_explicit_exit = true;
    return error.ProcessExit;
}

// ──────────────────────────────────────────────────────────
// Built-in module sources (path, fs)
// ──────────────────────────────────────────────────────────

const PATH_MODULE_SRC: []const u8 =
    \\const sep = '/';
    \\function normalize(p) {
    \\  const abs = p.startsWith('/');
    \\  const segs = p.split('/').reduce((a, s) => {
    \\    if (s === '' || s === '.') return a;
    \\    if (s === '..') { a.pop(); return a; }
    \\    a.push(s); return a;
    \\  }, []);
    \\  return (abs ? '/' : '') + segs.join('/');
    \\}
    \\function join(...parts) { return normalize(parts.filter(Boolean).join('/')); }
    \\function resolve(...ps) {
    \\  let r = typeof globalThis.__bun_cwd === 'string' ? globalThis.__bun_cwd : '/';
    \\  for (const p of ps) r = p.startsWith('/') ? p : r.endsWith('/') ? r+p : r+'/'+p;
    \\  return normalize(r);
    \\}
    \\function dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? (i===0?'/':'.') : p.slice(0,i); }
    \\function basename(p, ext) { let b = p.split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, b.length - ext.length); return b; }
    \\function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
    \\function isAbsolute(p) { return p.startsWith('/'); }
    \\function relative(from, to) {
    \\  const f = resolve(from).split('/').filter(Boolean);
    \\  const t = resolve(to).split('/').filter(Boolean);
    \\  let i = 0; while (i < f.length && f[i] === t[i]) i++;
    \\  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
    \\}
    \\module.exports = { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, posix: module.exports };
;

fn evalBuiltinSrc(src: []const u8, url: []const u8) !jsi.Value {
    const wrapper = try std.fmt.allocPrint(
        allocator,
        "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.__bun_require);return __m.exports;",
        .{src},
    );
    defer allocator.free(wrapper);
    const h = jsi.imports.jsi_eval(@intFromPtr(wrapper.ptr), wrapper.len, @intFromPtr(url.ptr), url.len);
    if (h == jsi.Value.exception_sentinel) return error.JSIException;
    return .{ .handle = h };
}

fn makeFsModule() !jsi.Value {
    const obj = runtime_g.makeObject();
    const fns = [_]struct { name: []const u8, func: jsi.host_function.HostFn }{
        .{ .name = "readFileSync",  .func = fsReadFileSyncFn  },
        .{ .name = "writeFileSync", .func = fsWriteFileSyncFn },
        .{ .name = "existsSync",    .func = fsExistsSyncFn    },
        .{ .name = "mkdirSync",     .func = fsMkdirSyncFn     },
        .{ .name = "readdirSync",   .func = fsReaddirSyncFn   },
        .{ .name = "statSync",      .func = fsStatSyncFn      },
    };
    inline for (fns) |f| {
        const v = try runtime_g.createHostFunction(f.func, f.name, 1);
        runtime_g.setProperty(obj, f.name, v);
    }
    return obj;
}

fn requireFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (!initialized) return jsi.Value.undefined_;
    if (args.len == 0) return jsi.Value.undefined_;

    const len = jsi.imports.jsi_string_length(args[0].handle);
    const specifier = try allocator.alloc(u8, len);
    defer allocator.free(specifier);
    jsi.imports.jsi_string_read(args[0].handle, @intFromPtr(specifier.ptr), len);

    // ── Built-in module interception ──────────────────────
    if (std.mem.eql(u8, specifier, "path") or std.mem.eql(u8, specifier, "node:path")) {
        return evalBuiltinSrc(PATH_MODULE_SRC, "<path>");
    }
    if (std.mem.eql(u8, specifier, "fs") or std.mem.eql(u8, specifier, "node:fs")) {
        return makeFsModule();
    }

    // ── VFS CJS loader ────────────────────────────────────
    const l = &loader_g;
    const handle = try l.load(specifier);
    _ = jsi.imports.jsi_retain(handle);
    return .{ .handle = handle };
}

// ──────────────────────────────────────────────────────────
// require("fs") HostFunctions
// ──────────────────────────────────────────────────────────

fn fsReadFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const data = vfs_g.readFile(path) catch return error.JSIException;
    defer allocator.free(data);

    // If second arg is "utf8" or "utf-8", return string; else return Buffer-like (ArrayBuffer)
    if (args.len > 1 and jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        return runtime_g.makeString(data);
    }
    return runtime_g.makeArrayBuffer(data, true);
}

fn fsWriteFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);

    // Ensure parent dirs exist
    const dir = pathDirname(path);
    if (!std.mem.eql(u8, dir, "/")) {
        vfs_g.mkdir(dir, 0o755) catch {};
    }

    if (jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        const content = try runtime_g.dupeString(args[1]);
        defer allocator.free(content);
        vfs_g.writeFile(path, content, 0o644) catch return error.JSIException;
    } else {
        // ArrayBuffer / Buffer: best-effort — return undefined
    }
    return jsi.Value.undefined_;
}

fn fsExistsSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return runtime_g.makeBool(false);
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const exists = if (vfs_g.stat(path)) |_| true else |_| false;
    return runtime_g.makeBool(exists);
}

fn fsMkdirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return jsi.Value.undefined_;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    vfs_g.mkdir(path, 0o755) catch {};
    return jsi.Value.undefined_;
}

fn fsReaddirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);

    var entries = std.array_list.Managed(sys_wasm.DirEntry).init(allocator);
    defer {
        for (entries.items) |e| allocator.free(e.name);
        entries.deinit();
    }
    vfs_g.readdir(path, &entries) catch return error.JSIException;

    const arr = runtime_g.makeArray(@intCast(entries.items.len));
    for (entries.items, 0..) |entry, idx| {
        const name_val = runtime_g.makeString(entry.name);
        defer jsi.imports.jsi_release(name_val.handle);
        runtime_g.setIndex(arr, @intCast(idx), name_val);
    }
    return arr;
}

fn fsStatSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const st = vfs_g.stat(path) catch return error.JSIException;

    const obj = runtime_g.makeObject();
    runtime_g.setProperty(obj, "size", runtime_g.makeNumber(@floatFromInt(st.size)));
    runtime_g.setProperty(obj, "isFile", try runtime_g.createHostFunction(statIsFileFn, "isFile", 0));
    runtime_g.setProperty(obj, "isDirectory", try runtime_g.createHostFunction(statIsDirFn, "isDirectory", 0));
    // store kind as a hidden property for the above callbacks
    runtime_g.setProperty(obj, "__kind", runtime_g.makeNumber(@floatFromInt(@intFromEnum(st.kind))));
    return obj;
}

fn statIsFileFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return runtime_g.makeBool(k == .file);
}

fn statIsDirFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return runtime_g.makeBool(k == .directory);
}


// ──────────────────────────────────────────────────────────
// console.* HostFunctions
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

fn consoleLogFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

fn consoleWarnFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

fn consoleErrorFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

fn consoleInfoFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

fn consoleDebugFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// Timer HostFunctions (timer_g-based)
// ──────────────────────────────────────────────────────────

/// High bit distinguishes timer callback tags from host_function tags.
const TIMER_TAG_BASE: u32 = 0x8000_0000;
var timer_cb_table: std.ArrayListUnmanaged(u32) = .{};

/// Stores a JS fn handle in timer_cb_table; returns its tag.
fn callbackTagForHandle(handle: u32) !u32 {
    const idx: u32 = @intCast(timer_cb_table.items.len);
    try timer_cb_table.append(allocator, handle);
    return TIMER_TAG_BASE | idx;
}

/// Called by timer_g.tick() for each expired timer.
fn dispatchTimerCallback(tag: u32) void {
    if ((tag & TIMER_TAG_BASE) == 0) return;
    const idx = tag & ~TIMER_TAG_BASE;
    if (idx >= timer_cb_table.items.len) return;
    const cb_handle = timer_cb_table.items[idx];
    _ = jsi.imports.jsi_call(cb_handle, jsi.Value.undefined_.handle, 0, 0);
}

fn setTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const delay_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle);
    const id = try timer_g.set(delay_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn setIntervalFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const period_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle);
    const id = try timer_g.setInterval(period_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn clearTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len >= 1) {
        const id: u32 = @intFromFloat(jsi.imports.jsi_to_number(args[0].handle));
        timer_g.clear(id);
    }
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// VFS write-file helper (called from Host to add files)
// ──────────────────────────────────────────────────────────

fn setupGlobals(rt: *jsi.Runtime) !void {
    // ── require / process.exit ────────────────────────────
    const require_val = try rt.createHostFunction(requireFn, "__bun_require", 1);
    rt.setProperty(rt.global, "__bun_require", require_val);
    const exit_fn = try rt.createHostFunction(processExitFn, "exit", 1);
    rt.setProperty(rt.global, "__bun_process_exit", exit_fn);

    // ── console ───────────────────────────────────────────
    const log_fn   = try rt.createHostFunction(consoleLogFn,   "log",   0);
    const warn_fn  = try rt.createHostFunction(consoleWarnFn,  "warn",  0);
    const err_fn   = try rt.createHostFunction(consoleErrorFn, "error", 0);
    const info_fn  = try rt.createHostFunction(consoleInfoFn,  "info",  0);
    const debug_fn = try rt.createHostFunction(consoleDebugFn, "debug", 0);
    rt.setProperty(rt.global, "__bun_console_log",   log_fn);
    rt.setProperty(rt.global, "__bun_console_warn",  warn_fn);
    rt.setProperty(rt.global, "__bun_console_error", err_fn);
    rt.setProperty(rt.global, "__bun_console_info",  info_fn);
    rt.setProperty(rt.global, "__bun_console_debug", debug_fn);

    // ── timers ────────────────────────────────────────────
    const set_timeout_fn   = try rt.createHostFunction(setTimeoutFn,  "setTimeout",   2);
    const set_interval_fn  = try rt.createHostFunction(setIntervalFn, "setInterval",  2);
    const clear_timer_fn   = try rt.createHostFunction(clearTimeoutFn,  "clearTimeout", 1);
    rt.setProperty(rt.global, "__bun_set_timeout",   set_timeout_fn);
    rt.setProperty(rt.global, "__bun_set_interval",  set_interval_fn);
    rt.setProperty(rt.global, "__bun_clear_timer",   clear_timer_fn);

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
        \\// console — assign HostFns directly so deleting globals doesn't break them
        \\globalThis.console = {
        \\  log:   globalThis.__bun_console_log,
        \\  warn:  globalThis.__bun_console_warn,
        \\  error: globalThis.__bun_console_error,
        \\  info:  globalThis.__bun_console_info,
        \\  debug: globalThis.__bun_console_debug,
        \\};
        \\delete globalThis.__bun_console_log;
        \\delete globalThis.__bun_console_warn;
        \\delete globalThis.__bun_console_error;
        \\delete globalThis.__bun_console_info;
        \\delete globalThis.__bun_console_debug;
        \\// timers — assign HostFns directly
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
}

// ──────────────────────────────────────────────────────────
// Exported WASM ABI
// ──────────────────────────────────────────────────────────

export fn bun_browser_init() void {
    if (initialized) return;
    initialized = true;

    vfs_g = sys_wasm.VFS.init(allocator, &clockMs) catch @panic("VFS init OOM");
    runtime_g = jsi.Runtime.init(allocator);
    loader_g = ModuleLoader.init(allocator, &vfs_g, &runtime_g);
    timer_g = Timer.init(allocator, &clockMs);
    setupGlobals(&runtime_g) catch @panic("setupGlobals OOM");
}

/// Drive the WASM-side timer queue.
/// Returns milliseconds until the next timer fires (0 = no pending timers).
/// The host (kernel-worker.ts) should call this every animation frame or after
/// awaiting the returned duration.
export fn bun_tick() u32 {
    if (!initialized) return 0;
    return timer_g.tick(&dispatchTimerCallback);
}

export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 {
    if (!initialized) return 0;
    const count = vfs_g.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

export fn bun_browser_run(path_ptr: [*]const u8, path_len: u32) i32 {
    if (!initialized) return 1;
    g_exit_code = 0;
    g_explicit_exit = false;
    const path = path_ptr[0..path_len];
    loader_g.current_dir = pathDirname(path);
    const handle = loader_g.load(path) catch {
        return if (g_explicit_exit) g_exit_code else 2;
    };
    jsi.imports.jsi_release(handle);
    return if (g_explicit_exit) g_exit_code else 0;
}

export fn bun_browser_eval(src_ptr: [*]const u8, src_len: u32, file_ptr: [*]const u8, file_len: u32) i32 {
    if (!initialized) return 1;
    const src = src_ptr[0..src_len];
    const file = file_ptr[0..file_len];
    const result = jsi.imports.jsi_eval(
        @intFromPtr(src.ptr),
        src.len,
        @intFromPtr(file.ptr),
        file.len,
    );
    if (result == jsi.Value.exception_sentinel) return 3;
    jsi.imports.jsi_release(result);
    return 0;
}

export fn jsi_host_invoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 {
    if (!initialized) return jsi.Value.exception_sentinel;

    // argv_ptr may alias host_arg_scratch memory (set by jsi_host_arg_scratch).
    // Copy args to a stack-local temp BEFORE mutating the scratch buffer.
    var args_tmp: [64]u32 = undefined;
    const safe_count = @min(argc, args_tmp.len);
    for (0..safe_count) |i| args_tmp[i] = argv_ptr[i];

    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.append(allocator, this_handle) catch return jsi.Value.exception_sentinel;
    host_arg_scratch.appendSlice(allocator, args_tmp[0..safe_count]) catch return jsi.Value.exception_sentinel;

    return jsi.host_function.dispatchHostFn(
        &runtime_g.host_fns,
        @as(*anyopaque, @ptrCast(&runtime_g)),
        fn_id,
        host_arg_scratch.items,
    );
}

export fn jsi_host_arg_scratch(argc: u32) [*]u32 {
    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.resize(allocator, argc) catch @panic("host_arg_scratch OOM");
    return host_arg_scratch.items.ptr;
}

/// Simple malloc/free for host-side read/write of WASM linear memory.
export fn bun_malloc(n: u32) u32 {
    const buf = allocator.alloc(u8, n) catch return 0;
    return @intCast(@intFromPtr(buf.ptr));
}

export fn bun_free(ptr: u32) void {
    // wasm_allocator doesn't support free of individual slices without length;
    // use page_allocator semantic: noop here, relies on GC-like behavior.
    // For a production build, pair with a proper slab allocator.
    _ = ptr;
}
