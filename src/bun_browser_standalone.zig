//! Bun Browser Runtime — Standalone WASM entry point.
//!
//! Compiled by `build-wasm-smoke.zig` into a real `bun-core.wasm` binary.
//! Uses `bun_wasm_shim` instead of the full Bun dependency graph.
//!
//! Exported ABI (consumed by packages/bun-browser/src/kernel-worker.ts):
//!
//!   bun_browser_init()                            — one-time runtime init
//!   bun_browser_run(ptr, len) i32                 — run an entry path from VFS
//!   bun_browser_eval(sp,sl,fp,fl) i32             — eval raw JS source
//!   bun_vfs_load_snapshot(ptr, len) u32           — load VFS snapshot
//!   bun_vfs_dump_snapshot() u64                    — dump current VFS as snapshot (T5.6.1)
//!   bun_vfs_read_file(ptr, len) u64              — read a single file from VFS; returns packed ptr+len (host must bun_free)
//!   bun_tick() u32                                — drive event loop
//!   bun_vfs_write(p,pl,d,dl) i32                 — write a file into VFS
//!   jsi_host_invoke(id,this,argv,argc) u32        — HostFn dispatch
//!   jsi_host_arg_scratch(argc) [*]u32             — HostFn argv scratch
//!   bun_malloc(n) u32                             — linear-memory alloc (for host)
//!   bun_free(ptr)                                 — linear-memory free
//!   bun_semver_select(vp,vl,rp,rl) u64           — pick best version from JSON array
//!   bun_integrity_verify(dp,dl,ip,il) u32        — verify tarball integrity (SRI)
//!   bun_transform(opts_ptr, opts_len) u64         — Phase 5.2: TS/JSX → JS (内置转译器)
//!   bun_tgz_extract(input_ptr, input_len) u64     — Phase 5.4 T5.4.3: extract .tgz into VFS
//!   bun_npm_parse_metadata(jp,jl,rp,rl) u64      — Phase 5.4 T5.4.1: parse npm metadata + resolve version
//!   bun_npm_resolve_graph(ptr, len) u64          — Phase 5.4 T5.4.2: BFS dependency graph flatten (WASM-side)
//!   bun_npm_install_begin(ptr, len) u64          — Phase 5.4 T5.4.4: start async install session
//!   bun_npm_need_fetch() u64                     — Phase 5.4 T5.4.4: pop next pending fetch request
//!   bun_npm_feed_response(id, ptr, len) u64      — Phase 5.4 T5.4.4: feed fetch response to state machine
//!   bun_npm_install_result() u64                 — Phase 5.4 T5.4.4: get resolved packages JSON
//!   bun_npm_install_end()                        — Phase 5.4 T5.4.4: free install session
//!   bun_lockfile_write(ptr, len) u64             — Phase 5.4 T5.4.5: generate bun.lock text
//!   bun_sourcemap_lookup(ptr, len) u64           — Phase 5.7 T5.7.2: VLQ sourcemap position lookup
//!   bun_html_rewrite(ptr, len) u64               — Phase 5.7 T5.7.3: minimal HTML element rewriter
//!   bun_shell_parse(ptr, len) u64                — Phase 5.13 T5.13.1: shell source → JSON AST

const std = @import("std");
const Timer = @import("timer.zig").Timer;
// ── Phase 5.2: 内置 TS/JSX strip 转译器 ──
const bun_wasm_transform = @import("bun_wasm_transform.zig");
// ── T5.10.5: 真身 VLQ 编解码器（src/sourcemap/VLQ.zig）──
const VLQ = @import("sourcemap/VLQ.zig");

// ── External JSI / sys_wasm imports (injected via build module map) ──
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
// ── bun_wasm_shim: gives access to bun.Semver.* for the WASM build ──
const bun = @import("bun");

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
var host_allocs: std.AutoHashMapUnmanaged(u32, usize) = .{};


/// Host clock — provided by `env.jsi_now_ms`.
extern "env" fn jsi_now_ms() u64;

fn clockMs() u64 {
    return jsi_now_ms();
}



// ──────────────────────────────────────────────────────────
// Path utilities  (identical to bun_browser.zig)
// ──────────────────────────────────────────────────────────

/// Normalize a POSIX path (resolve `.` / `..`, collapse duplicate `/`).
/// Uses std.fs.path.resolvePosix for correctness.
fn normPath(alloc: std.mem.Allocator, path: []const u8) std.mem.Allocator.Error![]u8 {
    return std.fs.path.resolvePosix(alloc, &.{path});
}

fn joinPath(alloc: std.mem.Allocator, base_dir: []const u8, rel: []const u8) ![]u8 {
    if (rel.len > 0 and rel[0] == '/') return normPath(alloc, rel);
    const combined = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ base_dir, rel });
    defer alloc.free(combined);
    return normPath(alloc, combined);
}

fn pathDirname(path: []const u8) []const u8 {
    return std.fs.path.dirnamePosix(path) orelse "/";
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

        for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".css" }) |ext| {
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

const PATH_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/path.js");

const URL_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/url.js");

const UTIL_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/util.js");

const BUFFER_POLYFILL_SRC: []const u8 = @embedFile("js/browser-polyfills/buffer-polyfill.js");

// ── Phase 5.8: Node.js 内置模块 polyfill（inline JS，供 requireFn + builtinPolyfillSource 使用）──

/// `events` — 完整 EventEmitter 实现
const EVENTS_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/events.js");

/// `buffer` — Buffer class, exports { Buffer }
/// 比全局安装版（BUFFER_POLYFILL_SRC）更完整，支持 read/write 方法
const BUFFER_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/buffer.js");

/// `assert` — Node.js assert 模块
const ASSERT_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/assert.js");

/// `querystring` — URL 查询字符串解析与序列化
const QUERYSTRING_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/querystring.js");

/// `string_decoder` — StringDecoder
const STRING_DECODER_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/string_decoder.js");

// ── Phase 5.9: 更多 Node.js 内置模块 polyfill ────────────────────────────────

/// stream — Readable/Writable/Transform/PassThrough/Duplex/pipeline/finished
/// 依赖 require('events') (Phase 5.8 EventEmitter)
const STREAM_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/stream.js");

/// crypto — createHash(sha256/sha1)/createHmac/randomBytes/randomUUID/timingSafeEqual
/// 纯 JS 实现（SHA-256 + SHA-1），无外部依赖（Buffer 通过 try/require 软依赖）
const CRYPTO_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/crypto.js");

/// os — 平台信息 stub（纯 JS，无外部依赖）
const OS_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/os.js");

/// zlib — 解压由 Bun.gunzipSync 驱动，压缩 stub（浏览器模式不支持）
/// createGunzip/createInflate 返回 PassThrough（stream 软依赖）
const ZLIB_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/zlib.js");

/// http/https — 基于 fetch 的 HTTP 客户端 + 无操作服务端 stub
/// 依赖 require('events')
const HTTP_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/http.js");

/// child_process — stubs（浏览器 WASM 不支持真实进程）
/// 依赖 require('events')
const CHILD_PROCESS_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/child_process.js");

/// worker_threads — stubs（浏览器 WASM 单线程模式）
const WORKER_THREADS_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/worker_threads.js");

/// process — 代理到 globalThis.process，否则返回最小兼容对象
const PROCESS_MODULE_SRC: []const u8 = @embedFile("js/browser-polyfills/process.js");

/// Bun 全局对象 polyfill。
/// Bun.serve({ fetch, port? }) — 注册路由到 `globalThis.__bun_routes`；Host 侧可通过
/// `kernel.fetch(port, init)` 把请求派发给已注册的 fetch handler。
/// 端口 0 或缺省时自动分配（从 40000 起递增）。
/// RFC Phase 3 T3.4：最小可工作的 Bun.serve 注入；真实 TCP 在 Phase 4+。
/// Phase 5.7 T5.7.1：扩充 Bun 对象 — env/argv/main/sleep/which/inspect/file/write/
///   resolveSync/gunzipSync/Transpiler/hash/password。
const BUN_GLOBAL_SRC: []const u8 = @embedFile("js/browser-polyfills/bun-global.js");

fn evalBuiltinSrc(src: []const u8, url: []const u8) !jsi.Value {
    const wrapper = try std.fmt.allocPrint(
        allocator,
        "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.require);return __m.exports;",
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
    // Single dispatch path — builtinPolyfillSource is the sole mapping table.
    // Only "fs" / "node:fs" is special-cased because it returns a HostFn-backed object
    // rather than evaluated JS source.
    if (isNodeBuiltin(specifier)) {
        if (std.mem.eql(u8, specifier, "fs") or std.mem.eql(u8, specifier, "node:fs")) {
            return makeFsModule();
        }
        const vpath = try std.fmt.allocPrint(allocator, "<{s}>", .{specifier});
        defer allocator.free(vpath);
        return evalBuiltinSrc(builtinPolyfillSource(specifier), vpath);
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

// ── URL parser HostFn (Phase 5.1 T5.1.4) ─────────────────────────────────────
/// Parse a URL string using std.Uri and return a JS object with URL components.
/// Called from the embedded URL_MODULE_SRC JS via __bun_url_parse.
fn urlParseHostFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return jsi.Value.null_;
    const url_str = try runtime_g.dupeString(args[0]);
    defer allocator.free(url_str);

    const uri = std.Uri.parse(url_str) catch return jsi.Value.null_;

    const obj = runtime_g.makeObject();

    // href = original string
    runtime_g.setProperty(obj, "href", runtime_g.makeString(url_str));

    // scheme + protocol
    runtime_g.setProperty(obj, "scheme", runtime_g.makeString(uri.scheme));
    const protocol = try std.fmt.allocPrint(allocator, "{s}:", .{uri.scheme});
    defer allocator.free(protocol);
    runtime_g.setProperty(obj, "protocol", runtime_g.makeString(protocol));

    // host / hostname / port
    const hostname_str: []const u8 = if (uri.host) |h| switch (h) {
        .raw, .percent_encoded => |s| s,
    } else "";
    if (uri.port) |port| {
        const full_host = try std.fmt.allocPrint(allocator, "{s}:{d}", .{ hostname_str, port });
        defer allocator.free(full_host);
        const port_str = try std.fmt.allocPrint(allocator, "{d}", .{port});
        defer allocator.free(port_str);
        runtime_g.setProperty(obj, "host", runtime_g.makeString(full_host));
        runtime_g.setProperty(obj, "hostname", runtime_g.makeString(hostname_str));
        runtime_g.setProperty(obj, "port", runtime_g.makeString(port_str));
    } else {
        runtime_g.setProperty(obj, "host", runtime_g.makeString(hostname_str));
        runtime_g.setProperty(obj, "hostname", runtime_g.makeString(hostname_str));
        runtime_g.setProperty(obj, "port", runtime_g.makeString(""));
    }

    // pathname
    const path_str: []const u8 = switch (uri.path) {
        .raw, .percent_encoded => |s| s,
    };
    runtime_g.setProperty(obj, "pathname",
        runtime_g.makeString(if (path_str.len > 0) path_str else "/"));

    // search (query with leading ?)
    if (uri.query) |q| {
        const q_str: []const u8 = switch (q) { .raw, .percent_encoded => |s| s };
        const search = try std.fmt.allocPrint(allocator, "?{s}", .{q_str});
        defer allocator.free(search);
        runtime_g.setProperty(obj, "search", runtime_g.makeString(search));
    } else {
        runtime_g.setProperty(obj, "search", runtime_g.makeString(""));
    }

    // hash (fragment with leading #)
    if (uri.fragment) |f| {
        const f_str: []const u8 = switch (f) { .raw, .percent_encoded => |s| s };
        const hash = try std.fmt.allocPrint(allocator, "#{s}", .{f_str});
        defer allocator.free(hash);
        runtime_g.setProperty(obj, "hash", runtime_g.makeString(hash));
    } else {
        runtime_g.setProperty(obj, "hash", runtime_g.makeString(""));
    }

    runtime_g.setProperty(obj, "auth", jsi.Value.null_);
    return obj;
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
const TIMER_TAG_REPEATING: u32 = 0x4000_0000;
const TIMER_TAG_INDEX_MASK: u32 = 0x3fff_ffff;
var timer_cb_table: std.ArrayListUnmanaged(u32) = .{};

/// Stores a JS fn handle in timer_cb_table; returns its tag.
fn callbackTagForHandle(handle: u32, repeating: bool) !u32 {
    const idx: u32 = @intCast(timer_cb_table.items.len);
    if (idx > TIMER_TAG_INDEX_MASK) return error.OutOfMemory;
    try timer_cb_table.append(allocator, handle);
    return TIMER_TAG_BASE |
        (if (repeating) TIMER_TAG_REPEATING else 0) |
        idx;
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

/// Called by timer_g.tick() for each expired timer.
fn dispatchTimerCallback(tag: u32) void {
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

    if (!is_repeating) {
        releaseTimerTag(tag);
    }
}

fn setTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const delay_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle, false);
    const id = try timer_g.set(delay_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn setIntervalFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const period_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle, true);
    const id = try timer_g.setInterval(period_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn clearTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len >= 1) {
        const id: u32 = @intFromFloat(jsi.imports.jsi_to_number(args[0].handle));
        if (timer_g.callbackTagForId(id)) |tag| {
            releaseTimerTag(tag);
        }
        timer_g.clear(id);
    }
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// Phase 5.7 T5.7.1 — Bun.* HostFunctions
// ──────────────────────────────────────────────────────────

/// Bun.file(path) helper — reads VFS file as an ArrayBuffer handle.
/// Throws if the file does not exist.
fn bunFileReadFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const data = vfs_g.readFile(path) catch return error.JSIException;
    defer allocator.free(data);
    return runtime_g.makeArrayBuffer(data, true);
}

/// Bun.file(path).size — returns the byte size of a VFS file (or 0 if missing).
fn bunFileSizeFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return runtime_g.makeNumber(0);
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const st = vfs_g.stat(path) catch return runtime_g.makeNumber(0);
    return runtime_g.makeNumber(@floatFromInt(st.size));
}

/// Bun.write(path, data) — write string or binary data to VFS.
/// Returns number of bytes written.
fn bunFileWriteFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return runtime_g.makeNumber(0);
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const dir = pathDirname(path);
    if (!std.mem.eql(u8, dir, "/")) vfs_g.mkdir(dir, 0o755) catch {};
    const type_tag = jsi.imports.jsi_typeof(args[1].handle);
    if (type_tag == @intFromEnum(jsi.TypeTag.string)) {
        const data = try runtime_g.dupeString(args[1]);
        defer allocator.free(data);
        vfs_g.writeFile(path, data, 0o644) catch return error.JSIException;
        return runtime_g.makeNumber(@floatFromInt(data.len));
    } else if (type_tag == @intFromEnum(jsi.TypeTag.arraybuffer) or
        type_tag == @intFromEnum(jsi.TypeTag.typed_array))
    {
        const byte_len = jsi.imports.jsi_arraybuffer_byteLength(args[1].handle);
        if (byte_len < 0) return runtime_g.makeNumber(0);
        const buf = try allocator.alloc(u8, @intCast(byte_len));
        defer allocator.free(buf);
        const n = jsi.imports.jsi_read_arraybuffer(args[1].handle, @intFromPtr(buf.ptr), @intCast(byte_len));
        if (n < 0) return runtime_g.makeNumber(0);
        vfs_g.writeFile(path, buf[0..@intCast(n)], 0o644) catch return error.JSIException;
        return runtime_g.makeNumber(@floatFromInt(n));
    }
    return runtime_g.makeNumber(0);
}

/// Bun.resolveSync(spec, from) — resolve a module specifier from a given file path.
fn bunResolveSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0 or args[0].isNullOrUndefined()) return error.JSIException;
    const spec = try runtime_g.dupeString(args[0]);
    defer allocator.free(spec);
    const from = if (args.len > 1 and !args[1].isNullOrUndefined())
        try runtime_g.dupeString(args[1])
    else
        try allocator.dupe(u8, "/");
    defer allocator.free(from);

    const base_dir: []const u8 = if (from.len > 0 and from[0] == '/') pathDirname(from) else "/";

    if (isNodeBuiltin(spec)) {
        const vpath = builtinVirtualPath(allocator, spec) catch return error.JSIException;
        defer allocator.free(vpath);
        return runtime_g.makeString(vpath);
    }
    const is_bare = spec.len > 0 and !(spec[0] == '/' or spec[0] == '.');
    const resolved: ResolveResult = if (is_bare) blk: {
        if (resolveViaTsconfigPaths(allocator, base_dir, spec)) |r| break :blk r else |err| switch (err) {
            error.OutOfMemory => return error.JSIException,
            error.ModuleNotFound => {},
        }
        break :blk resolveBareInVfs(allocator, base_dir, spec) catch return error.JSIException;
    } else resolveRelative(allocator, base_dir, spec) catch return error.JSIException;
    defer allocator.free(resolved.path);
    return runtime_g.makeString(resolved.path);
}

/// Bun.gunzipSync(data: Uint8Array) → Uint8Array — gzip decompression using inflateImpl.
fn bunGunzipSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const byte_len = jsi.imports.jsi_arraybuffer_byteLength(args[0].handle);
    if (byte_len < 0) return error.JSIException;
    const input = try allocator.alloc(u8, @intCast(byte_len));
    defer allocator.free(input);
    const read_n = jsi.imports.jsi_read_arraybuffer(args[0].handle, @intFromPtr(input.ptr), @intCast(byte_len));
    if (read_n < 0) return error.JSIException;
    const decompressed = inflateImpl(input[0..@intCast(read_n)], 0) catch return error.JSIException;
    defer allocator.free(decompressed);
    return runtime_g.makeArrayBuffer(decompressed, true);
}

/// Bun.Transpiler host bridge — transpiles code with the same pipeline as the bundler.
fn bunTranspileCodeFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return jsi.Value.null_;
    const code = try runtime_g.dupeString(args[0]);
    defer allocator.free(code);
    const filename = try runtime_g.dupeString(args[1]);
    defer allocator.free(filename);
    const result = transpileIfNeeded(allocator, filename, code) catch return jsi.Value.null_;
    defer allocator.free(result);
    return runtime_g.makeString(result);
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

    // ── URL parser (Phase 5.1 T5.1.4) ────────────────────
    const url_parse_fn = try rt.createHostFunction(urlParseHostFn, "__bun_url_parse", 1);
    rt.setProperty(rt.global, "__bun_url_parse", url_parse_fn);

    // ── Phase 5.7 T5.7.1: Bun.* host bridges ─────────────
    const bun_file_read_fn  = try rt.createHostFunction(bunFileReadFn,    "__bun_file_read",    1);
    const bun_file_size_fn  = try rt.createHostFunction(bunFileSizeFn,    "__bun_file_size",    1);
    const bun_file_write_fn = try rt.createHostFunction(bunFileWriteFn,   "__bun_file_write",   2);
    const bun_resolve_fn    = try rt.createHostFunction(bunResolveSyncFn, "__bun_resolve_sync", 2);
    const bun_gunzip_fn     = try rt.createHostFunction(bunGunzipSyncFn,  "__bun_gunzip_sync",  1);
    const bun_transpile_fn  = try rt.createHostFunction(bunTranspileCodeFn, "__bun_transpile_code", 2);
    rt.setProperty(rt.global, "__bun_file_read",      bun_file_read_fn);
    rt.setProperty(rt.global, "__bun_file_size",      bun_file_size_fn);
    rt.setProperty(rt.global, "__bun_file_write",     bun_file_write_fn);
    rt.setProperty(rt.global, "__bun_resolve_sync",   bun_resolve_fn);
    rt.setProperty(rt.global, "__bun_gunzip_sync",    bun_gunzip_fn);
    rt.setProperty(rt.global, "__bun_transpile_code", bun_transpile_fn);

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
    _ = try rt.evalScript(BUFFER_POLYFILL_SRC, "<bun-browser:buffer>");
    _ = try rt.evalScript(BUN_GLOBAL_SRC, "<bun-browser:Bun>");
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

/// Wakeup hook for host-driven loops.
/// The current timer loop is polled by `bun_tick()`, so this is a no-op placeholder
/// kept for ABI compatibility with the browser runtime protocol.
export fn bun_wakeup() void {}

export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 {
    if (!initialized) return 0;
    const count = vfs_g.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

/// T5.6.1: Serialize current VFS state as a binary snapshot (same format as bun_vfs_load_snapshot).
/// Returns packed u64: high 32 bits = ptr, low 32 bits = len.
/// Returns 0 on error or empty VFS.
/// Host MUST call bun_free(ptr) after consuming the data.
export fn bun_vfs_dump_snapshot() u64 {
    if (!initialized) return 0;
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    _ = vfs_g.exportSnapshot(&out) catch return 0;
    const len = out.items.len;
    if (len == 0) return 0;
    const buf = allocator.dupe(u8, out.items) catch return 0;
    return handOff(buf);
}

/// Read a single file from the VFS and hand its content to the host.
/// Returns packed u64: high 32 bits = ptr, low 32 bits = len.
/// Returns 0 if not initialized, file not found, or OOM.
/// Host MUST call bun_free(ptr) after consuming the data.
export fn bun_vfs_read_file(path_ptr: [*]const u8, path_len: u32) u64 {
    if (!initialized) return 0;
    const path = path_ptr[0..path_len];
    const data = vfs_g.readFile(path) catch return 0;
    return handOff(data);
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

/// Synchronously spawn a "bun" sub-process in-process.
///
/// `cmd_ptr/cmd_len` points to a JSON array string, e.g. `["bun","-e","code"]`.
///
/// Supported forms:
///   ["bun", "-e", "<js code>"]      — eval JS inline
///   ["bun", "run", "<vfs path>"]    — load + run from VFS
///
/// Returns the exit code (0 = success).  In Phase 2 this is synchronous;
/// true process isolation is a Phase 4 concern.
export fn bun_spawn(cmd_ptr: [*]const u8, cmd_len: u32) i32 {
    if (!initialized) return 1;

    const cmd_json = cmd_ptr[0..cmd_len];

    // Stash the JSON in a temp global so JS-side JSON.parse can reach it.
    const json_val = runtime_g.makeString(cmd_json);
    defer jsi.imports.jsi_release(json_val.handle);
    runtime_g.setProperty(runtime_g.global, "__spawn_cmd", json_val);

    const parse_src = "var __r=JSON.parse(globalThis.__spawn_cmd);delete globalThis.__spawn_cmd;return __r;";
    const arr = runtime_g.evalScript(parse_src, "<spawn:parse>") catch return 2;
    defer jsi.imports.jsi_release(arr.handle);

    // argv length
    const len_val = runtime_g.getProperty(arr, "length");
    defer jsi.imports.jsi_release(len_val.handle);
    const argc: u32 = @intFromFloat(jsi.imports.jsi_to_number(len_val.handle));

    if (argc == 0) return 1;

    // argv[0] must be "bun"
    const cmd0 = runtime_g.getIndex(arr, 0);
    defer jsi.imports.jsi_release(cmd0.handle);
    if (jsi.imports.jsi_typeof(cmd0.handle) != @intFromEnum(jsi.TypeTag.string)) return 1;
    const exe = runtime_g.dupeString(cmd0) catch return 2;
    defer allocator.free(exe);
    if (!std.mem.eql(u8, exe, "bun")) return 1;

    if (argc < 2) return 0; // bare "bun" — nothing to do

    // argv[1] = subcommand / flag
    const cmd1 = runtime_g.getIndex(arr, 1);
    defer jsi.imports.jsi_release(cmd1.handle);
    const subcmd = runtime_g.dupeString(cmd1) catch return 2;
    defer allocator.free(subcmd);

    g_exit_code = 0;
    g_explicit_exit = false;

    if (std.mem.eql(u8, subcmd, "-e")) {
        // bun -e "<js code>"
        if (argc < 3) return 0;
        const code_val = runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(code_val.handle);
        const code_src = runtime_g.dupeString(code_val) catch return 2;
        defer allocator.free(code_src);

        const url_lit = "<bun:-e>";
        const result = jsi.imports.jsi_eval(
            @intFromPtr(code_src.ptr),
            code_src.len,
            @intFromPtr(url_lit.ptr),
            url_lit.len,
        );
        if (result != jsi.Value.exception_sentinel) {
            jsi.imports.jsi_release(result);
        }
        return if (g_explicit_exit) g_exit_code else 0;
    }

    if (std.mem.eql(u8, subcmd, "run")) {
        // bun run <vfs-path>
        if (argc < 3) return 1;
        const file_val = runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(file_val.handle);
        const file = runtime_g.dupeString(file_val) catch return 2;
        defer allocator.free(file);

        loader_g.current_dir = pathDirname(file);
        const handle = loader_g.load(file) catch {
            return if (g_explicit_exit) g_exit_code else 2;
        };
        jsi.imports.jsi_release(handle);
        return if (g_explicit_exit) g_exit_code else 0;
    }

    return 0; // unknown subcommand — no-op, treat as success
}

/// Stub: signal a spawned process. Currently all spawns are synchronous and
/// inline, so this is a no-op kept for ABI completeness.
export fn bun_kill(_: u32, _: u32) void {}

/// Stub: write to a spawned process's stdin.
export fn bun_feed_stdin(_: u32, _: [*]const u8, _: u32) void {}

/// Stub: close a spawned process's stdin.
export fn bun_close_stdin(_: u32) void {}

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
    const alloc_len: usize = if (n == 0) 1 else n;
    const buf = allocator.alloc(u8, alloc_len) catch return 0;
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));

    host_allocs.put(allocator, ptr, alloc_len) catch {
        allocator.free(buf);
        return 0;
    };

    return ptr;
}

export fn bun_free(ptr: u32) void {
    if (host_allocs.fetchRemove(ptr)) |entry| {
        const p: [*]u8 = @ptrFromInt(entry.key);
        allocator.free(p[0..entry.value]);
    }
}

// ──────────────────────────────────────────────────────────
// Phase 1 T1.1：bun_lockfile_parse（最小可验证切片）
//
// 输入：bun.lock 文本（v1 JSON 格式）的 UTF-8 字节流。
// 输出：指向 host_allocs 登记的 JSON 摘要字符串的指针，编码为 u64：
//         高 32 位 = ptr（需由 host 调用 bun_free 释放）
//         低 32 位 = len
//       若 ptr == 0 则解析失败；此时低 32 位是错误码（1 = OOM / 2 = JSON 语法 / 3 = 缺 lockfileVersion）。
//
// 摘要 JSON：{ "lockfileVersion": N, "workspaceCount": N, "packageCount": N,
//              "packages": [{ "key": "...", "name": "...", "version": "..." }, ...] }
//
// 对应 RFC：docs/rfc/bun-wasm-browser-runtime-implementation-plan.md §4.3 T1.1
// 当前实现不依赖 src/install/lockfile.zig（该模块强耦合 JSC/PackageManager），
// 而是直接对 bun.lock 的 JSON 表示做轻量提取，满足 Phase 1 验收条件
// "bun_lockfile_parse 能解析一个真实 bun.lock 文件"。
// ──────────────────────────────────────────────────────────

fn packResult(ptr: u32, len: u32) u64 {
    return (@as(u64, ptr) << 32) | @as(u64, len);
}

fn packError(code: u32) u64 {
    return @as(u64, code);
}

/// 将 buf 所有权转交给 host_allocs，返回打包后的 (ptr, len)。
fn handOff(buf: []u8) u64 {
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));
    host_allocs.put(allocator, ptr, buf.len) catch {
        allocator.free(buf);
        return packError(1);
    };
    return packResult(ptr, @intCast(buf.len));
}

// ──────────────────────────────────────────────────────────────────────────────
// bun_semver_select — real semver via src/semver/* (Zig reuse step 2)
// ──────────────────────────────────────────────────────────────────────────────
//
// ABI: (versions_json_ptr, versions_json_len, range_ptr, range_len) → u64
//
// `versions_json` is a JSON array of version strings, e.g. ["1.0.0","2.0.0"].
// `range` is a semver range string, e.g. "^1.0.0".
//
// Returns a packed (ptr << 32 | len) pointing to a heap-allocated UTF-8 string
// of the best matching version, or packError(1) if none matched.
// The returned buffer must be freed by the host via `bun_free`.
export fn bun_semver_select(
    versions_ptr: [*]const u8,
    versions_len: u32,
    range_ptr: [*]const u8,
    range_len: u32,
) u64 {
    if (!initialized) return packError(1);

    const versions_json = versions_ptr[0..versions_len];
    const range_str = range_ptr[0..range_len];

    return semverSelect(versions_json, range_str) catch packError(1);
}

/// Pick the best matching version from a flat slice of version strings.
/// Skips pre-release versions unless the range explicitly targets them.
/// Returns `error.NoMatch` when nothing satisfies the range.
fn semverSelectFromList(ver_list: []const []const u8, range_str: []const u8) ![]const u8 {
    const Semver = bun.Semver;
    const Version = Semver.Version;
    const Query = Semver.Query;
    const SlicedString = Semver.SlicedString;

    const range_sliced = SlicedString{ .buf = range_str, .slice = range_str };
    var group = try Query.parse(allocator, range_str, range_sliced);
    defer group.deinit();

    var best: ?struct { ver: Version, str: []const u8 } = null;

    for (ver_list) |ver_str| {
        const parse_result = Version.parseUTF8(ver_str);
        if (!parse_result.valid) continue;
        const ver = parse_result.version.min();

        // Skip pre-release versions unless the range explicitly requests them.
        if (ver.tag.hasPre()) continue;

        if (!group.satisfies(ver, range_str, ver_str)) continue;

        // Keep the highest version that satisfies.
        if (best) |b| {
            if (ver.order(b.ver, ver_str, b.str) != .gt) continue;
        }
        best = .{ .ver = ver, .str = ver_str };
    }

    return (best orelse return error.NoMatch).str;
}

fn semverSelect(versions_json: []const u8, range_str: []const u8) !u64 {
    // Parse the JSON array of version strings.
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, versions_json, .{});
    defer parsed.deinit();

    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return packError(1),
    };

    var ver_list: std.ArrayList([]const u8) = .empty;
    defer ver_list.deinit(allocator);

    for (arr.items) |item| {
        const ver_str = switch (item) {
            .string => |s| s,
            else => continue,
        };
        try ver_list.append(allocator, ver_str);
    }

    const chosen = semverSelectFromList(ver_list.items, range_str) catch return packError(1);
    const buf = try allocator.dupe(u8, chosen);
    return handOff(buf);
}

// ──────────────────────────────────────────────────────────────────────────────
// T5.4.1 — bun_npm_parse_metadata
// Parse a full npm registry metadata JSON, apply semver range (or dist-tag),
// and return the resolved version info as a compact JSON object.
// ──────────────────────────────────────────────────────────────────────────────
//
// Input:
//   json_ptr/json_len  — raw bytes from GET https://registry.npmjs.org/<pkgname>
//   range_ptr/range_len — semver range or dist-tag ("^1.0.0", "latest", "1.2.3", "*")
//
// Returns packed (ptr << 32 | len) → JSON:
//   {"version":"1.2.3","tarball":"https://...","integrity":"sha512-...","shasum":"...","dependencies":{...}}
// Errors:
//   packError(1) = OOM
//   packError(2) = invalid / unparsable JSON or missing required fields
//   packError(3) = no version satisfying the range

/// Returns true if the string looks like a semver range, not a dist-tag.
fn isVersionLike(s: []const u8) bool {
    if (s.len == 0) return false;
    const c = s[0];
    return (c >= '0' and c <= '9') or c == '^' or c == '~' or
        c == '>' or c == '<' or c == '=' or c == '*' or c == 'x' or c == 'X';
}

export fn bun_npm_parse_metadata(
    json_ptr: [*]const u8,
    json_len: u32,
    range_ptr: [*]const u8,
    range_len: u32,
) u64 {
    if (!initialized) return packError(2);
    const json_bytes = json_ptr[0..json_len];
    const range_str = range_ptr[0..range_len];
    return npmParseMetadata(json_bytes, range_str) catch |err| switch (err) {
        error.NoMatch => packError(3),
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

fn npmParseMetadata(json_bytes: []const u8, range_str: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json_bytes, .{
        .duplicate_field_behavior = .use_last,
    });
    defer parsed.deinit();

    const root = switch (parsed.value) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    // Extract versions object.
    const versions_obj = switch (root.get("versions") orelse return error.SyntaxError) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    // Extract dist-tags (optional but required for dist-tag range resolution).
    const dist_tags_opt: ?std.json.ObjectMap = if (root.get("dist-tags")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    // Resolve effective semver range from the raw range argument.
    // Rules:
    //   - Wildcard ("", "*", "x", "X") → use "latest" dist-tag if present
    //   - Non-version-like string       → treat as dist-tag, look up in dist-tags
    //   - Everything else               → pass directly to semverSelectFromList
    var effective_range_buf: [256]u8 = undefined;
    var effective_range: []const u8 = std.mem.trim(u8, range_str, " \t");

    if (effective_range.len == 0 or
        std.mem.eql(u8, effective_range, "*") or
        std.mem.eql(u8, effective_range, "x") or
        std.mem.eql(u8, effective_range, "X"))
    {
        // Wildcard: try to pin to "latest" first.
        if (dist_tags_opt) |dt| {
            if (dt.get("latest")) |lv| {
                if (lv == .string and lv.string.len < effective_range_buf.len) {
                    @memcpy(effective_range_buf[0..lv.string.len], lv.string);
                    effective_range = effective_range_buf[0..lv.string.len];
                }
            }
        }
        // Still wildcard after dist-tag lookup → leave as "*" for semver.
        if (effective_range.len == 0) effective_range = "*";
    } else if (!isVersionLike(effective_range)) {
        // Dist-tag (e.g. "latest", "next", "beta").
        if (dist_tags_opt) |dt| {
            if (dt.get(effective_range)) |tv| {
                if (tv == .string and tv.string.len < effective_range_buf.len) {
                    @memcpy(effective_range_buf[0..tv.string.len], tv.string);
                    effective_range = effective_range_buf[0..tv.string.len];
                }
            }
        }
    }

    // Build a flat list of version strings for semver selection.
    var ver_list: std.ArrayList([]const u8) = .empty;
    defer ver_list.deinit(allocator);
    {
        var it = versions_obj.iterator();
        while (it.next()) |entry| {
            try ver_list.append(allocator, entry.key_ptr.*);
        }
    }

    // Select the best matching version.
    // Exact match first (avoids full semver parse for pinned versions).
    const chosen_ver: []const u8 = blk: {
        if (versions_obj.get(effective_range) != null) break :blk effective_range;
        break :blk semverSelectFromList(ver_list.items, effective_range) catch |e| switch (e) {
            error.NoMatch => return error.NoMatch,
            else => return e,
        };
    };

    // Fetch version-specific metadata.
    const ver_meta = switch (versions_obj.get(chosen_ver) orelse return error.NoMatch) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    // Extract dist fields.
    const dist_opt: ?std.json.ObjectMap = if (ver_meta.get("dist")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    const tarball: []const u8 = if (dist_opt) |d| switch (d.get("tarball") orelse .null) {
        .string => |s| s,
        else => "",
    } else "";
    const integrity: []const u8 = if (dist_opt) |d| switch (d.get("integrity") orelse .null) {
        .string => |s| s,
        else => "",
    } else "";
    const shasum: []const u8 = if (dist_opt) |d| switch (d.get("shasum") orelse .null) {
        .string => |s| s,
        else => "",
    } else "";

    // Extract dependencies (optional).
    const deps_opt: ?std.json.ObjectMap = if (ver_meta.get("dependencies")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    // Serialize output JSON.
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{\"version\":");
    try jsonEscapeTo(&out, chosen_ver);
    try out.appendSlice(allocator, ",\"tarball\":");
    try jsonEscapeTo(&out, tarball);
    if (integrity.len > 0) {
        try out.appendSlice(allocator, ",\"integrity\":");
        try jsonEscapeTo(&out, integrity);
    }
    if (shasum.len > 0) {
        try out.appendSlice(allocator, ",\"shasum\":");
        try jsonEscapeTo(&out, shasum);
    }
    try out.appendSlice(allocator, ",\"dependencies\":{");
    if (deps_opt) |deps| {
        var dep_it = deps.iterator();
        var first = true;
        while (dep_it.next()) |dep_entry| {
            if (!first) try out.append(allocator, ',');
            first = false;
            try jsonEscapeTo(&out, dep_entry.key_ptr.*);
            try out.append(allocator, ':');
            const dep_range = switch (dep_entry.value_ptr.*) {
                .string => |s| s,
                else => "*",
            };
            try jsonEscapeTo(&out, dep_range);
        }
    }
    try out.appendSlice(allocator, "}}");

    return handOff(try out.toOwnedSlice(allocator));
}

export fn bun_lockfile_parse(src_ptr: [*]const u8, src_len: u32) u64 {
    if (!initialized) return packError(1);
    const raw = src_ptr[0..src_len];

    // bun.lock 是 JSON5-风味文本（允许尾随逗号），std.json 不支持；
    // 用一个最小预处理：删除对象/数组闭合括号前的尾随逗号。
    // 同时保留字符串内的逗号。
    const preprocessed = stripTrailingCommas(allocator, raw) catch return packError(1);
    defer allocator.free(preprocessed);

    var parsed = std.json.parseFromSlice(
        std.json.Value,
        allocator,
        preprocessed,
        .{ .duplicate_field_behavior = .use_last },
    ) catch return packError(2);
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) return packError(2);

    const version_node = root.object.get("lockfileVersion") orelse return packError(3);
    const version_num: i64 = switch (version_node) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => return packError(3),
    };

    // 组装摘要
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    appendFmt(&out, "{{\"lockfileVersion\":{d}", .{version_num}) catch return packError(1);

    var workspace_count: usize = 0;
    if (root.object.get("workspaces")) |ws| switch (ws) {
        .object => |obj| workspace_count = obj.count(),
        else => {},
    };
    appendFmt(&out, ",\"workspaceCount\":{d}", .{workspace_count}) catch return packError(1);

    var package_count: usize = 0;
    if (root.object.get("packages")) |pkgs| switch (pkgs) {
        .object => |obj| package_count = obj.count(),
        else => {},
    };
    appendFmt(&out, ",\"packageCount\":{d},\"packages\":[", .{package_count}) catch return packError(1);

    // Enumerate packages when present. bun.lock 格式：
    //   "packages": { "<key>": ["<name>@<spec>", ...], ... }
    if (root.object.get("packages")) |pkgs| if (pkgs == .object) {
        var it = pkgs.object.iterator();
        var first = true;
        while (it.next()) |entry| {
            if (!first) out.append(allocator, ',') catch return packError(1);
            first = false;
            const key = entry.key_ptr.*;
            var pkg_name: []const u8 = key;
            var pkg_version: []const u8 = "";
            if (entry.value_ptr.* == .array and entry.value_ptr.array.items.len >= 1 and entry.value_ptr.array.items[0] == .string) {
                const spec = entry.value_ptr.array.items[0].string;
                if (std.mem.lastIndexOfScalar(u8, spec, '@')) |at| {
                    if (at > 0) {
                        pkg_name = spec[0..at];
                        pkg_version = spec[at + 1 ..];
                    }
                }
            }
            out.appendSlice(allocator, "{\"key\":") catch return packError(1);
            jsonEscapeTo(&out, key) catch return packError(1);
            out.appendSlice(allocator, ",\"name\":") catch return packError(1);
            jsonEscapeTo(&out, pkg_name) catch return packError(1);
            out.appendSlice(allocator, ",\"version\":") catch return packError(1);
            jsonEscapeTo(&out, pkg_version) catch return packError(1);
            out.append(allocator, '}') catch return packError(1);
        }
    };

    out.appendSlice(allocator, "]}") catch return packError(1);
    const owned = out.toOwnedSlice(allocator) catch return packError(1);
    return handOff(owned);
}

fn appendFmt(out: *std.ArrayList(u8), comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error!void {
    const needed = std.fmt.count(fmt, args);
    try out.ensureUnusedCapacity(allocator, needed);
    var buf: [128]u8 = undefined;
    if (needed <= buf.len) {
        const s = std.fmt.bufPrint(&buf, fmt, args) catch unreachable;
        try out.appendSlice(allocator, s);
    } else {
        const heap = try allocator.alloc(u8, needed);
        defer allocator.free(heap);
        const s = std.fmt.bufPrint(heap, fmt, args) catch unreachable;
        try out.appendSlice(allocator, s);
    }
}

fn jsonEscapeTo(out: *std.ArrayList(u8), s: []const u8) std.mem.Allocator.Error!void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0...0x08, 0x0b, 0x0c, 0x0e...0x1f => {
                var buf: [6]u8 = undefined;
                const formatted = std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c}) catch unreachable;
                try out.appendSlice(allocator, formatted);
            },
            else => try out.append(allocator, c),
        }
    }
    try out.append(allocator, '"');
}

/// 去除对象/数组闭合括号前的尾随逗号。字符串字面量内的逗号保持不变。
/// 不支持 JSON5 注释（bun.lock 也不写注释）。
fn stripTrailingCommas(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    try out.ensureTotalCapacity(alloc, src.len);

    var i: usize = 0;
    var in_string: bool = false;
    var escape: bool = false;
    while (i < src.len) : (i += 1) {
        const c = src[i];
        if (in_string) {
            try out.append(alloc, c);
            if (escape) {
                escape = false;
            } else if (c == '\\') {
                escape = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        if (c == '"') {
            in_string = true;
            try out.append(alloc, c);
            continue;
        }
        if (c == ',') {
            // 向前看，跳过空白与换行；若首个非空白字符是 } 或 ]，丢弃逗号。
            var j = i + 1;
            while (j < src.len) : (j += 1) {
                const cj = src[j];
                if (cj == ' ' or cj == '\t' or cj == '\n' or cj == '\r') continue;
                break;
            }
            if (j < src.len and (src[j] == '}' or src[j] == ']')) {
                continue; // 丢弃这个逗号
            }
        }
        try out.append(alloc, c);
    }
    return out.toOwnedSlice(alloc);
}

// ──────────────────────────────────────────────────────────
// Phase 1 T1.1：bun_resolve / bun_bundle (最小可验证切片)
//
// 这两个导出与 bun_lockfile_parse 共用 packError / packResult / handOff 协议。
// 设计原则与 lockfile 一致：standalone WASM 不链接 src/resolver/ 与 src/bundler/
// （它们强依赖 JSC / AnyEventLoop），因此在 VFS 之上做一份满足 RFC Phase 1 验收
// 的最小实现——足以支撑 "输入 TypeScript → 点击 Transform → Bundle 输出 JS"。
// ──────────────────────────────────────────────────────────

/// 将 `specifier` 解析为 VFS 绝对路径，使用 Node/bun 风格的扩展名探测与 index.*。
/// 结果 JSON：`{ "path": "...", "loader": "ts|tsx|js|mjs|cjs|json" }`
/// 错误码：1 = OOM，2 = 未找到模块，3 = 空 specifier，4 = 裸包（尚未支持）。
export fn bun_resolve(
    spec_ptr: [*]const u8,
    spec_len: u32,
    from_ptr: [*]const u8,
    from_len: u32,
) u64 {
    if (!initialized) return packError(1);
    const spec = spec_ptr[0..spec_len];
    const from = from_ptr[0..from_len];
    if (spec.len == 0) return packError(3);

    // base_dir 优先使用 from 文件的 dirname；from 为空或非绝对路径时退化到 /
    const base_dir: []const u8 = if (from.len > 0 and from[0] == '/') pathDirname(from) else "/";

    // T5.3.1i: Node builtin modules → virtual path (never in VFS)
    if (isNodeBuiltin(spec)) {
        const vpath = builtinVirtualPath(allocator, spec) catch return packError(1);
        defer allocator.free(vpath);
        return emitResolveResult(vpath, "js");
    }

    // 裸包（例如 "react"）：不以 / . 开头
    const is_bare = !(spec[0] == '/' or spec[0] == '.');
    if (is_bare) {
        // Phase 5.3: tsconfig paths first (aliases like "@/foo" usually look like bare).
        if (resolveViaTsconfigPaths(allocator, base_dir, spec)) |r| {
            defer allocator.free(r.path);
            return emitResolveResult(r.path, r.loader);
        } else |err| switch (err) {
            error.OutOfMemory => return packError(1),
            error.ModuleNotFound => {},
        }

        // 在 VFS 中可能仍有 /node_modules/<spec>/package.json —— 尝试作为最小支持
        const resolved = resolveBareInVfs(allocator, base_dir, spec) catch |err| switch (err) {
            error.OutOfMemory => return packError(1),
            error.ModuleNotFound => return packError(4),
        };
        defer allocator.free(resolved.path);
        return emitResolveResult(resolved.path, resolved.loader);
    }

    const resolved = resolveRelative(allocator, base_dir, spec) catch |err| switch (err) {
        error.OutOfMemory => return packError(1),
        error.ModuleNotFound => return packError(2),
    };
    defer allocator.free(resolved.path);
    return emitResolveResult(resolved.path, resolved.loader);
}

/// Phase 1 T1.1：单入口打包器。
/// 输入：`entry` —— VFS 绝对路径。
/// 输出：self-contained IIFE JS，安装一张 __modules__ 表并执行入口。
///
/// 错误码：1 = OOM / 2 = 入口找不到 / 3 = 循环依赖超出深度 / 4 = 转译失败。
export fn bun_bundle(entry_ptr: [*]const u8, entry_len: u32) u64 {
    if (!initialized) return packError(1);
    const entry = entry_ptr[0..entry_len];

    var bundler = Bundler.init(allocator) catch return packError(1);
    defer bundler.deinit();

    bundler.addEntry(entry) catch |err| switch (err) {
        error.OutOfMemory => return packError(1),
        error.ModuleNotFound => return packError(2),
        error.TooDeep => return packError(3),
        error.TranspileFailed => return packError(4),
    };

    const emitted = bundler.emit() catch return packError(1);
    return handOff(emitted);
}

/// T5.3.3: `bun_bundle2` — bundle with full JSON config.
///
/// Input JSON schema:
///   {
///     "entrypoint": "/app/index.ts",   // required
///     "external": ["react", "lodash"], // optional: skip bundling, delegate to globalThis.require
///     "define": {                      // optional: text substitutions applied after transpile
///       "process.env.NODE_ENV": "\"production\""
///     }
///   }
///
/// Returns the same IIFE bundle format as bun_bundle.
/// Error codes: 1=OOM/parse, 2=entry not found, 3=too deep, 4=transpile failed, 5=missing entrypoint
export fn bun_bundle2(cfg_ptr: [*]const u8, cfg_len: u32) u64 {
    if (!initialized) return packError(1);
    const cfg_json = cfg_ptr[0..cfg_len];

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, cfg_json, .{
        .ignore_unknown_fields = true,
    }) catch return packError(1);
    defer parsed.deinit();

    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return packError(1),
    };

    // Extract required entrypoint
    const entry_val = obj.get("entrypoint") orelse return packError(5);
    const entry = switch (entry_val) {
        .string => |s| s,
        else => return packError(5),
    };

    var bundler = Bundler.init(allocator) catch return packError(1);
    defer bundler.deinit();

    // Parse optional externals array
    if (obj.get("external")) |ext_val| {
        if (ext_val == .array) {
            for (ext_val.array.items) |item| {
                if (item != .string) continue;
                const copy = allocator.dupe(u8, item.string) catch return packError(1);
                bundler.externals.append(allocator, copy) catch {
                    allocator.free(copy);
                    return packError(1);
                };
            }
        }
    }

    // Parse optional define object
    if (obj.get("define")) |def_val| {
        if (def_val == .object) {
            var it = def_val.object.iterator();
            while (it.next()) |kv| {
                if (kv.value_ptr.* != .string) continue;
                const key = allocator.dupe(u8, kv.key_ptr.*) catch return packError(1);
                const val = allocator.dupe(u8, kv.value_ptr.*.string) catch {
                    allocator.free(key);
                    return packError(1);
                };
                bundler.defines.append(allocator, .{ .key = key, .value = val }) catch {
                    allocator.free(key);
                    allocator.free(val);
                    return packError(1);
                };
            }
        }
    }

    bundler.addEntry(entry) catch |err| switch (err) {
        error.OutOfMemory => return packError(1),
        error.ModuleNotFound => return packError(2),
        error.TooDeep => return packError(3),
        error.TranspileFailed => return packError(4),
    };

    const emitted = bundler.emit() catch return packError(1);
    return handOff(emitted);
}

const ResolveResult = struct { path: []u8, loader: []const u8 };

fn classifyLoader(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".tsx")) return "tsx";
    if (std.mem.endsWith(u8, path, ".ts")) return "ts";
    if (std.mem.endsWith(u8, path, ".mts")) return "ts";
    if (std.mem.endsWith(u8, path, ".cts")) return "ts";
    if (std.mem.endsWith(u8, path, ".jsx")) return "jsx";
    if (std.mem.endsWith(u8, path, ".mjs")) return "mjs";
    if (std.mem.endsWith(u8, path, ".cjs")) return "cjs";
    if (std.mem.endsWith(u8, path, ".json")) return "json";
    if (std.mem.endsWith(u8, path, ".css")) return "css";
    return "js";
}

/// 尝试以下次序：
///   1. `base/spec` 原样（如果存在，且是文件）
///   2. `base/spec{ext}` for ext in .ts .tsx .mts .cts .mjs .cjs .js .jsx .json
///   3. `base/spec/index{ext}` for ext ...
fn resolveRelative(alloc: std.mem.Allocator, base_dir: []const u8, spec: []const u8) !ResolveResult {
    const abs = try joinPath(alloc, base_dir, spec);
    if (isFile(abs)) {
        return .{ .path = abs, .loader = classifyLoader(abs) };
    }

    const exts = [_][]const u8{ ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json", ".css" };
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}{s}", .{ abs, ext });
        if (isFile(p)) {
            alloc.free(abs);
            return .{ .path = p, .loader = classifyLoader(p) };
        }
        alloc.free(p);
    }
    // index.* 探测
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}/index{s}", .{ abs, ext });
        if (isFile(p)) {
            alloc.free(abs);
            return .{ .path = p, .loader = classifyLoader(p) };
        }
        alloc.free(p);
    }
    alloc.free(abs);
    return error.ModuleNotFound;
}

fn resolveBareInVfs(alloc: std.mem.Allocator, base_dir: []const u8, name: []const u8) !ResolveResult {
    // split "scoped/name/sub/path" → pkg="scoped/name", subpath="./sub/path" or "."
    var pkg_name: []const u8 = name;
    var subpath: []const u8 = ".";
    var sub_buf: ?[]u8 = null;
    defer if (sub_buf) |b| alloc.free(b);

    // skip first '/' for scoped packages "@scope/pkg/..."
    const scan_start: usize = if (name.len > 0 and name[0] == '@')
        (std.mem.indexOfScalar(u8, name, '/') orelse name.len) + 1
    else
        0;
    if (std.mem.indexOfScalarPos(u8, name, scan_start, '/')) |slash| {
        pkg_name = name[0..slash];
        const rest = name[slash + 1 ..];
        if (rest.len > 0) {
            const joined = try std.fmt.allocPrint(alloc, "./{s}", .{rest});
            sub_buf = joined;
            subpath = joined;
        }
    }

    // 自下而上查找 /node_modules/<pkg_name>
    var cur: []const u8 = base_dir;
    while (true) {
        const nm_root = try std.fmt.allocPrint(alloc, "{s}/node_modules/{s}", .{ cur, pkg_name });
        defer alloc.free(nm_root);
        if (isDir(nm_root)) {
            return resolvePackageEntry(alloc, nm_root, subpath) catch |err| switch (err) {
                // fall back to plain index.* / main-less behavior
                error.ModuleNotFound => return resolveRelative(alloc, nm_root, subpath),
                else => return err,
            };
        }
        if (std.mem.eql(u8, cur, "/")) break;
        cur = pathDirname(cur);
    }
    return error.ModuleNotFound;
}

/// Phase 5.3: honor package.json `exports["."]` (string), `module`, `main`.
/// For subpath requests other than "." we also try `exports[subpath]` as a string;
/// otherwise fall through to `resolveRelative(pkg_dir, subpath)`.
fn resolvePackageEntry(alloc: std.mem.Allocator, pkg_dir: []const u8, subpath: []const u8) !ResolveResult {
    if (!std.mem.eql(u8, subpath, ".")) {
        // Subpath request: first try exports["./<subpath>"] exact, then "*" patterns.
        if (readPackageJson(alloc, pkg_dir)) |parsed_val| {
            defer parsed_val.deinit();
            if (parsed_val.value == .object) {
                if (parsed_val.value.object.get("exports")) |exports_node| {
                    if (exports_node == .object) {
                        // 1) exact key match, e.g. "./foo/bar"
                        if (exports_node.object.get(subpath)) |v| {
                            if (pickExportsString(v)) |s| {
                                return resolveRelative(alloc, pkg_dir, s);
                            }
                        }
                        // 2) wildcard key match, e.g. "./features/*" -> "./dist/features/*.js"
                        if (resolveExportsWildcard(alloc, exports_node.object, subpath)) |rendered| {
                            defer alloc.free(rendered);
                            return resolveRelative(alloc, pkg_dir, rendered);
                        }
                    }
                }
            }
        } else |_| {}
        return resolveRelative(alloc, pkg_dir, subpath);
    }

    // "." — prefer exports["."], then module, then main.
    const parsed_or_err = readPackageJson(alloc, pkg_dir);
    if (parsed_or_err) |parsed_val| {
        defer parsed_val.deinit();
        if (parsed_val.value == .object) {
            const obj = parsed_val.value.object;
            if (obj.get("exports")) |exports_node| {
                const entry_spec = resolveExportsDot(exports_node);
                if (entry_spec) |s| return resolveRelative(alloc, pkg_dir, s);
            }
            if (obj.get("module")) |m| if (m == .string) return resolveRelative(alloc, pkg_dir, m.string);
            if (obj.get("main")) |m| if (m == .string) return resolveRelative(alloc, pkg_dir, m.string);
        }
    } else |_| {}
    // fallback: resolveRelative treats "." as pkg_dir → tries index.*
    return resolveRelative(alloc, pkg_dir, ".");
}

/// Walk `exports` object entries whose key contains a single `*` wildcard.
/// Returns a newly-allocated rendered target spec, or null if none match.
fn resolveExportsWildcard(
    alloc: std.mem.Allocator,
    obj: std.json.ObjectMap,
    subpath: []const u8,
) ?[]u8 {
    var it = obj.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        const star = std.mem.indexOfScalar(u8, key, '*') orelse continue;
        const prefix = key[0..star];
        const suffix = key[star + 1 ..];
        if (!std.mem.startsWith(u8, subpath, prefix)) continue;
        if (!std.mem.endsWith(u8, subpath, suffix)) continue;
        if (subpath.len < prefix.len + suffix.len) continue;
        const matched = subpath[prefix.len .. subpath.len - suffix.len];
        const target = pickExportsString(entry.value_ptr.*) orelse continue;
        const t_star = std.mem.indexOfScalar(u8, target, '*') orelse {
            return alloc.dupe(u8, target) catch null;
        };
        return std.fmt.allocPrint(alloc, "{s}{s}{s}", .{
            target[0..t_star],
            matched,
            target[t_star + 1 ..],
        }) catch null;
    }
    return null;
}

fn readPackageJson(alloc: std.mem.Allocator, pkg_dir: []const u8) !std.json.Parsed(std.json.Value) {
    const pj_path = try std.fmt.allocPrint(alloc, "{s}/package.json", .{pkg_dir});
    defer alloc.free(pj_path);
    const raw = vfs_g.readFile(pj_path) catch return error.ModuleNotFound;
    defer alloc.free(raw);
    return std.json.parseFromSlice(std.json.Value, alloc, raw, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.ModuleNotFound;
}

fn pickExportsString(v: std.json.Value) ?[]const u8 {
    return switch (v) {
        .string => |s| s,
        .object => |o| blk: {
            // prefer "import" → "default" for ESM priority; "browser" if present
            if (o.get("browser")) |x| if (x == .string) break :blk x.string;
            if (o.get("import")) |x| if (x == .string) break :blk x.string;
            if (o.get("default")) |x| if (x == .string) break :blk x.string;
            if (o.get("require")) |x| if (x == .string) break :blk x.string;
            break :blk null;
        },
        else => null,
    };
}

/// Resolve the package-level `exports` field to the "." entry string.
/// Forms handled:
///   "exports": "./index.js"                         → "./index.js"
///   "exports": { ".": "./index.js" }                → "./index.js"
///   "exports": { ".": { "import": "./esm.js" } }    → "./esm.js"
fn resolveExportsDot(exports_node: std.json.Value) ?[]const u8 {
    return switch (exports_node) {
        .string => |s| s,
        .object => |o| blk: {
            if (o.get(".")) |v| break :blk pickExportsString(v);
            break :blk pickExportsString(.{ .object = o });
        },
        else => null,
    };
}

/// Phase 5.3: tsconfig.json `compilerOptions.paths` matching.
/// Walks upward from `base_dir` searching for a tsconfig.json with `compilerOptions.paths`.
/// Returns the resolved absolute path, or error.ModuleNotFound if no pattern matched.
///
/// Supports the Node-style subset: literal keys and single-`*` wildcard patterns.
///   "paths": { "@/*": ["./src/*"], "utils": ["./src/utils/index.ts"] }
fn resolveViaTsconfigPaths(alloc: std.mem.Allocator, base_dir: []const u8, spec: []const u8) !ResolveResult {
    var cur: []const u8 = base_dir;
    while (true) {
        const tsc_path = try std.fmt.allocPrint(alloc, "{s}/tsconfig.json", .{cur});
        defer alloc.free(tsc_path);
        if (isFile(tsc_path)) {
            // Collect (baseUrl, paths) with extends-chain resolution.
            var merged = loadTsconfigMerged(alloc, tsc_path, 0) catch null;
            defer if (merged) |*m| m.deinit(alloc);
            if (merged) |m| {
                if (m.paths) |paths_obj| {
                    const base_url = m.base_url orelse cur;
                    var it = paths_obj.iterator();
                    while (it.next()) |e| {
                        const pattern = e.key_ptr.*;
                        const targets = e.value_ptr.*;
                        if (targets != .array) continue;
                        if (matchTsconfigPath(alloc, pattern, spec)) |matched| {
                            defer alloc.free(matched);
                            for (targets.array.items) |t| {
                                if (t != .string) continue;
                                const rendered = renderTsconfigTarget(alloc, t.string, matched) catch continue;
                                defer alloc.free(rendered);
                                const r = resolveRelative(alloc, base_url, rendered) catch continue;
                                return r;
                            }
                        }
                    }
                }
            }
        }
        if (std.mem.eql(u8, cur, "/")) break;
        cur = pathDirname(cur);
    }
    return error.ModuleNotFound;
}

/// Aggregated view of a tsconfig with `extends` chain applied.
/// Holds ownership of the parsed JSON (first one in the chain) and a resolved baseUrl string.
const MergedTsconfig = struct {
    /// Root parsed value (kept alive so `paths_obj` entries remain valid).
    /// Additional parsed values from the `extends` chain are stashed in `extras`.
    root: std.json.Parsed(std.json.Value),
    extras: std.array_list.Managed(std.json.Parsed(std.json.Value)),
    /// Absolute baseUrl (duped). null ⇒ use the enclosing dir at query time.
    base_url: ?[]u8,
    /// Reference to the first `compilerOptions.paths` object in the chain.
    paths: ?std.json.ObjectMap,

    fn deinit(self: *MergedTsconfig, alloc: std.mem.Allocator) void {
        self.root.deinit();
        for (self.extras.items) |*p| p.deinit();
        self.extras.deinit();
        if (self.base_url) |b| alloc.free(b);
    }
};

/// Load a tsconfig.json and follow `extends` recursively (up to 8 levels).
/// Nearest-wins semantics: the first ancestor that defines `paths` / `baseUrl`
/// supplies them. We do NOT deep-merge `paths` objects (keeping semantics simple).
fn loadTsconfigMerged(
    alloc: std.mem.Allocator,
    path: []const u8,
    depth: u32,
) !MergedTsconfig {
    if (depth > 8) return error.TooDeep;
    const raw = vfs_g.readFile(path) catch return error.ModuleNotFound;
    defer alloc.free(raw);
    const stripped = stripTrailingCommas(alloc, raw) catch return error.OutOfMemory;
    defer alloc.free(stripped);
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, stripped, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.ModuleNotFound;
    errdefer parsed.deinit();

    const parent_dir = pathDirname(path);

    var merged: MergedTsconfig = .{
        .root = parsed,
        .extras = std.array_list.Managed(std.json.Parsed(std.json.Value)).init(alloc),
        .base_url = null,
        .paths = null,
    };
    errdefer merged.extras.deinit();

    var base_url_raw: ?[]const u8 = null;

    if (parsed.value == .object) {
        if (parsed.value.object.get("compilerOptions")) |co| {
            if (co == .object) {
                if (co.object.get("baseUrl")) |bu| if (bu == .string) {
                    base_url_raw = bu.string;
                };
                if (co.object.get("paths")) |p| if (p == .object) {
                    merged.paths = p.object;
                };
            }
        }
    }

    // Follow `extends` until we find what's missing.
    const needs_extend = (merged.paths == null or base_url_raw == null) and
        (parsed.value == .object and parsed.value.object.get("extends") != null);
    if (needs_extend) {
        const ext_node = parsed.value.object.get("extends").?;
        if (ext_node == .string) {
            const ext_spec = ext_node.string;
            const ext_path_opt: ?[]u8 = if (ext_spec.len > 0 and (ext_spec[0] == '.' or ext_spec[0] == '/'))
                blk: {
                    // Normalize and auto-append .json if missing
                    var joined = try joinPath(alloc, parent_dir, ext_spec);
                    if (!std.mem.endsWith(u8, joined, ".json")) {
                        const extended = try std.fmt.allocPrint(alloc, "{s}.json", .{joined});
                        alloc.free(joined);
                        joined = extended;
                    }
                    break :blk joined;
                }
            else
                null; // bare-package extends not supported in Phase 5.3a
            if (ext_path_opt) |ext_path| {
                defer alloc.free(ext_path);
                if (loadTsconfigMerged(alloc, ext_path, depth + 1)) |child| {
                    var c = child;
                    if (merged.paths == null and c.paths != null) {
                        merged.paths = c.paths;
                        // Keep the parsed JSON alive by moving it into `extras`.
                        try merged.extras.append(c.root);
                        // Swallow child's extras too (transitive extends).
                        try merged.extras.appendSlice(c.extras.items);
                        c.extras.items.len = 0; // prevent double-free
                        c.extras.deinit();
                        if (c.base_url) |cbase| {
                            if (merged.base_url == null) merged.base_url = cbase else alloc.free(cbase);
                        }
                        // Do NOT deinit c.root here — ownership moved.
                        base_url_raw = null; // already absolutized by child
                    } else {
                        c.deinit(alloc);
                    }
                } else |_| {}
            }
        }
    }

    if (merged.base_url == null) {
        const br = base_url_raw orelse ".";
        merged.base_url = try joinPath(alloc, parent_dir, br);
    }
    return merged;
}


/// Returns the portion matched by `*` (newly-allocated, or empty string for literal match),
/// or null when pattern doesn't match spec.
fn matchTsconfigPath(alloc: std.mem.Allocator, pattern: []const u8, spec: []const u8) ?[]u8 {
    if (std.mem.indexOfScalar(u8, pattern, '*')) |star| {
        const prefix = pattern[0..star];
        const suffix = pattern[star + 1 ..];
        if (!std.mem.startsWith(u8, spec, prefix)) return null;
        if (!std.mem.endsWith(u8, spec, suffix)) return null;
        if (spec.len < prefix.len + suffix.len) return null;
        const mid = spec[prefix.len .. spec.len - suffix.len];
        return alloc.dupe(u8, mid) catch null;
    }
    // literal match
    if (std.mem.eql(u8, pattern, spec)) return alloc.dupe(u8, "") catch null;
    return null;
}

fn renderTsconfigTarget(alloc: std.mem.Allocator, target: []const u8, matched: []const u8) ![]u8 {
    if (std.mem.indexOfScalar(u8, target, '*')) |star| {
        return std.fmt.allocPrint(alloc, "{s}{s}{s}", .{
            target[0..star],
            matched,
            target[star + 1 ..],
        });
    }
    return alloc.dupe(u8, target);
}

fn isFile(path: []const u8) bool {
    const st = vfs_g.stat(path) catch return false;
    return st.kind == .file;
}

fn isDir(path: []const u8) bool {
    const st = vfs_g.stat(path) catch return false;
    return st.kind == .directory;
}

// ──────────────────────────────────────────────────────────────────────────────
// T5.3.1i — Node builtin recognition & virtual path polyfill
// ──────────────────────────────────────────────────────────────────────────────

/// Bare names (without "node:" prefix) that are recognised as Node.js builtins.
const NODE_BUILTIN_BARE_NAMES = [_][]const u8{
    "fs",              "path",         "url",       "util",      "crypto",
    "buffer",          "os",           "net",        "http",      "https",
    "events",          "stream",       "assert",     "vm",        "module",
    "child_process",   "string_decoder", "querystring", "tls",    "readline",
    "zlib",            "dns",          "dgram",      "cluster",   "tty",
    "constants",       "timers",       "async_hooks", "perf_hooks", "worker_threads",
    "punycode",        "process",
};

/// Returns true when `spec` is a Node.js built-in specifier
/// ("node:fs", "fs", "path", "node:crypto", etc.).
fn isNodeBuiltin(spec: []const u8) bool {
    if (std.mem.startsWith(u8, spec, "node:")) return true;
    for (NODE_BUILTIN_BARE_NAMES) |name| {
        if (std.mem.eql(u8, spec, name)) return true;
    }
    return false;
}

/// Allocates and returns the virtual path for a builtin specifier.
/// "fs" → "<builtin:node:fs>",  "node:path" → "<builtin:node:path>"
fn builtinVirtualPath(alloc: std.mem.Allocator, spec: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, spec, "node:")) {
        return std.fmt.allocPrint(alloc, "<builtin:{s}>", .{spec});
    }
    return std.fmt.allocPrint(alloc, "<builtin:node:{s}>", .{spec});
}

/// Extracts the canonical "node:<name>" module name from a virtual path
/// like "<builtin:node:fs>".  Returns null if the format doesn't match.
fn canonicalFromVirtualPath(path: []const u8) ?[]const u8 {
    const prefix = "<builtin:";
    const suffix = ">";
    if (!std.mem.startsWith(u8, path, prefix)) return null;
    if (!std.mem.endsWith(u8, path, suffix)) return null;
    return path[prefix.len .. path.len - suffix.len];
}

/// Returns the CJS-compatible JS polyfill source for a builtin module.
/// `canonical` is the canonical form, e.g. "node:path", "node:fs".
/// - path / url / util  → inline JS polyfill (already defined as constants)
/// - fs / crypto / etc. → inline or delegate
/// - all others         → empty-object stub
fn builtinPolyfillSource(canonical: []const u8) []const u8 {
    if (std.mem.eql(u8, canonical, "node:path") or std.mem.eql(u8, canonical, "path"))
        return PATH_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:url") or std.mem.eql(u8, canonical, "url"))
        return URL_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:util") or std.mem.eql(u8, canonical, "util"))
        return UTIL_MODULE_SRC;
    // Phase 5.8: inline polyfills
    if (std.mem.eql(u8, canonical, "node:events") or std.mem.eql(u8, canonical, "events"))
        return EVENTS_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:buffer") or std.mem.eql(u8, canonical, "buffer"))
        return BUFFER_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:assert") or std.mem.eql(u8, canonical, "assert") or
        std.mem.eql(u8, canonical, "node:assert/strict"))
        return ASSERT_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:querystring") or std.mem.eql(u8, canonical, "querystring"))
        return QUERYSTRING_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:string_decoder") or std.mem.eql(u8, canonical, "string_decoder"))
        return STRING_DECODER_MODULE_SRC;
    // Phase 5.9: inline polyfills for stream/crypto/os/zlib/http/child_process/worker_threads/process
    if (std.mem.eql(u8, canonical, "node:stream") or std.mem.eql(u8, canonical, "stream") or
        std.mem.eql(u8, canonical, "node:stream/promises"))
        return STREAM_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:crypto") or std.mem.eql(u8, canonical, "crypto"))
        return CRYPTO_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:os") or std.mem.eql(u8, canonical, "os"))
        return OS_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:zlib") or std.mem.eql(u8, canonical, "zlib"))
        return ZLIB_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:http") or std.mem.eql(u8, canonical, "http") or
        std.mem.eql(u8, canonical, "node:https") or std.mem.eql(u8, canonical, "https"))
        return HTTP_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:child_process") or std.mem.eql(u8, canonical, "child_process"))
        return CHILD_PROCESS_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:worker_threads") or std.mem.eql(u8, canonical, "worker_threads"))
        return WORKER_THREADS_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:process") or std.mem.eql(u8, canonical, "process"))
        return PROCESS_MODULE_SRC;
    // fs: HostFn-backed — delegate through globalThis.require at runtime
    if (std.mem.eql(u8, canonical, "node:fs") or std.mem.eql(u8, canonical, "fs"))
        return "module.exports=(typeof globalThis!==\"undefined\"&&typeof globalThis.require===\"function\")?globalThis.require(\"node:fs\"):{};";
    // Unknown builtin → empty-object stub (forward-compatible)
    return "module.exports={};";
}

fn emitResolveResult(path: []const u8, loader: []const u8) u64 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.appendSlice(allocator, "{\"path\":") catch return packError(1);
    jsonEscapeTo(&out, path) catch return packError(1);
    out.appendSlice(allocator, ",\"loader\":") catch return packError(1);
    jsonEscapeTo(&out, loader) catch return packError(1);
    out.append(allocator, '}') catch return packError(1);
    const owned = out.toOwnedSlice(allocator) catch return packError(1);
    return handOff(owned);
}

// ──────────────────────────────────────────────────────────
// Bundler (Phase 1 T1.1 最小可验证切片)
//
// 策略：
//   1. 从 entry 开始 DFS，每个文件：读取 → 转译（.ts/.tsx）→ 扫描 require("...")
//      与 import ... from "..."（静态形式）与 import("...")。
//   2. 按解析顺序分配 numeric id，建 __modules__ 表。
//   3. 输出一个 IIFE，包含所有模块的工厂函数 + __require() 实现。
//
// 限制（已在 commit message 明文标注）：
//   - 仅支持静态字符串 specifier；`require(expr)` 不处理。
//   - 不做 tree-shaking、代码压缩。
//   - ES module 的 import 统一转为 CJS 语义（转译器已经把 import/export 降级为 CJS）。
// ──────────────────────────────────────────────────────────

const Bundler = struct {
    alloc: std.mem.Allocator,
    /// absPath → id
    by_path: std.StringHashMap(u32),
    /// 按顺序持有：每项为 { path, js_source, deps: []DepEdge }
    entries: std.ArrayListUnmanaged(BundleEntry),
    entry_id: u32 = 0,
    /// T5.3.3: external package names (skipped bundling, delegated to outer require)
    externals: std.ArrayListUnmanaged([]u8) = .{},
    /// T5.3.3: define substitutions e.g. process.env.NODE_ENV → "production"
    defines: std.ArrayListUnmanaged(DefineEntry) = .{},

    const DefineEntry = struct { key: []u8, value: []u8 };

    const BundleEntry = struct {
        path: []u8,
        js_source: []u8,
        deps: std.ArrayListUnmanaged(DepEdge) = .{},
    };
    const DepEdge = struct {
        specifier: []u8,
        target_id: u32,
    };

    const BundlerError = error{
        OutOfMemory,
        ModuleNotFound,
        TooDeep,
        TranspileFailed,
    };

    fn init(alloc: std.mem.Allocator) BundlerError!Bundler {
        return .{
            .alloc = alloc,
            .by_path = std.StringHashMap(u32).init(alloc),
            .entries = .{},
        };
    }

    fn deinit(self: *Bundler) void {
        var it = self.by_path.iterator();
        while (it.next()) |e| self.alloc.free(e.key_ptr.*);
        self.by_path.deinit();
        for (self.entries.items) |*e| {
            self.alloc.free(e.path);
            self.alloc.free(e.js_source);
            for (e.deps.items) |*d| self.alloc.free(d.specifier);
            e.deps.deinit(self.alloc);
        }
        self.entries.deinit(self.alloc);
        for (self.externals.items) |s| self.alloc.free(s);
        self.externals.deinit(self.alloc);
        for (self.defines.items) |d| { self.alloc.free(d.key); self.alloc.free(d.value); }
        self.defines.deinit(self.alloc);
    }

    fn addEntry(self: *Bundler, entry_path: []const u8) BundlerError!void {
        self.entry_id = try self.addFile(entry_path, "/", 0);
    }

    /// T5.3.3: Register an external specifier as a synthetic module that delegates to
    /// the outer globalThis.require at runtime (consistent with node builtin polyfill pattern).
    fn addExternalModule(self: *Bundler, specifier: []const u8) BundlerError!u32 {
        const synthetic_path = std.fmt.allocPrint(self.alloc, "<external:{s}>", .{specifier}) catch return error.OutOfMemory;
        if (self.by_path.get(synthetic_path)) |existing_id| {
            self.alloc.free(synthetic_path);
            return existing_id;
        }
        // Emit: module.exports via globalThis.require (same pattern as node builtin delegate)
        var js_buf: std.ArrayList(u8) = .empty;
        defer js_buf.deinit(self.alloc);
        js_buf.appendSlice(self.alloc, "module.exports=(typeof globalThis!==\"undefined\"&&typeof globalThis.require===\"function\")?globalThis.require(") catch return error.OutOfMemory;
        jsonEscapeTo(&js_buf, specifier) catch return error.OutOfMemory;
        js_buf.appendSlice(self.alloc, "):{};") catch return error.OutOfMemory;
        const js = js_buf.toOwnedSlice(self.alloc) catch return error.OutOfMemory;

        const id: u32 = @intCast(self.entries.items.len);
        const key = self.alloc.dupe(u8, synthetic_path) catch {
            self.alloc.free(js);
            self.alloc.free(synthetic_path);
            return error.OutOfMemory;
        };
        self.by_path.put(key, id) catch {
            self.alloc.free(key);
            self.alloc.free(js);
            self.alloc.free(synthetic_path);
            return error.OutOfMemory;
        };
        self.entries.append(self.alloc, .{
            .path = synthetic_path,
            .js_source = js,
            .deps = .{},
        }) catch return error.OutOfMemory;
        return id;
    }

    /// Phase 5.3: union resolver — relative/abs → resolveRelative,
    /// bare → tsconfig paths → node_modules (package.json main/exports).
    /// T5.3.1i: node builtins → virtual "<builtin:node:X>" paths.
    fn resolveModule(self: *Bundler, specifier: []const u8, base_dir: []const u8) !ResolveResult {
        if (specifier.len == 0) return error.ModuleNotFound;
        // T5.3.1i: catch Node builtins before any VFS or bare-package lookup
        if (isNodeBuiltin(specifier)) {
            const vpath = builtinVirtualPath(self.alloc, specifier) catch return error.OutOfMemory;
            return .{ .path = vpath, .loader = "js" };
        }
        const is_bare = !(specifier[0] == '/' or specifier[0] == '.');
        if (is_bare) {
            if (resolveViaTsconfigPaths(self.alloc, base_dir, specifier)) |r| return r else |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.ModuleNotFound => {},
            }
            return resolveBareInVfs(self.alloc, base_dir, specifier);
        }
        return resolveRelative(self.alloc, base_dir, specifier);
    }

    fn addFile(self: *Bundler, specifier: []const u8, base_dir: []const u8, depth: u32) BundlerError!u32 {
        if (depth > 256) return error.TooDeep;

        // T5.3.3: check externals before any resolution
        for (self.externals.items) |ext| {
            if (std.mem.eql(u8, specifier, ext)) {
                return self.addExternalModule(specifier);
            }
        }

        const resolved = self.resolveModule(specifier, base_dir) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.ModuleNotFound => return error.ModuleNotFound,
        };

        if (self.by_path.get(resolved.path)) |id| {
            self.alloc.free(resolved.path);
            return id;
        }

        // T5.3.1i: virtual builtin path → inline polyfill source, skip VFS
        if (canonicalFromVirtualPath(resolved.path)) |canonical| {
            const polyfill = builtinPolyfillSource(canonical);
            const js = self.alloc.dupe(u8, polyfill) catch {
                self.alloc.free(resolved.path);
                return error.OutOfMemory;
            };
            const id: u32 = @intCast(self.entries.items.len);
            const key = self.alloc.dupe(u8, resolved.path) catch {
                self.alloc.free(js);
                self.alloc.free(resolved.path);
                return error.OutOfMemory;
            };
            errdefer self.alloc.free(key);
            try self.by_path.put(key, id);
            try self.entries.append(self.alloc, .{
                .path = resolved.path, // ownership transferred to entry
                .js_source = js,
                .deps = .{},
            });
            // Scan polyfill's own require() calls and bundle them recursively.
            // Polyfills only depend on other builtins, so base_dir "/" is fine.
            var deps = scanDependencies(self.alloc, js) catch return error.OutOfMemory;
            errdefer {
                for (deps.items) |*d| self.alloc.free(d.specifier);
                deps.deinit(self.alloc);
            }
            var di: usize = 0;
            while (di < deps.items.len) : (di += 1) {
                const child_id = self.addFile(deps.items[di].specifier, "/", depth + 1) catch |err| switch (err) {
                    error.ModuleNotFound => {
                        deps.items[di].target_id = std.math.maxInt(u32);
                        continue;
                    },
                    else => return err,
                };
                deps.items[di].target_id = child_id;
            }
            self.entries.items[id].deps = deps;
            return id;
        }

        // 读取 & 转译
        const raw = vfs_g.readFile(resolved.path) catch {
            self.alloc.free(resolved.path);
            return error.ModuleNotFound;
        };
        // T5.3.3: apply define substitutions BEFORE transpile so the host transpiler
        // sees already-replaced values (and won't substitute its own env defines).
        const pre_transpile = if (self.defines.items.len > 0) blk: {
            const defined = applyDefines(self.alloc, raw, self.defines.items) catch {
                self.alloc.free(raw);
                self.alloc.free(resolved.path);
                return error.OutOfMemory;
            };
            self.alloc.free(raw);
            break :blk defined;
        } else raw;
        defer self.alloc.free(pre_transpile);

        const js = transpileIfNeeded(self.alloc, resolved.path, pre_transpile) catch |err| switch (err) {
            error.OutOfMemory => {
                self.alloc.free(resolved.path);
                return error.OutOfMemory;
            },
            error.TranspileFailed => {
                self.alloc.free(resolved.path);
                return error.TranspileFailed;
            },
        };

        const id: u32 = @intCast(self.entries.items.len);
        try self.by_path.put(try self.alloc.dupe(u8, resolved.path), id);
        try self.entries.append(self.alloc, .{
            .path = resolved.path,
            .js_source = js,
            .deps = .{},
        });

        // 扫描依赖并递归加载（先占位再填充 deps，避免自递归时 id 未分配）
        var deps = scanDependencies(self.alloc, js) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
        };
        errdefer {
            for (deps.items) |*d| self.alloc.free(d.specifier);
            deps.deinit(self.alloc);
        }

        const this_dir = pathDirname(self.entries.items[id].path);
        var i: usize = 0;
        while (i < deps.items.len) : (i += 1) {
            // JSON 或裸包：跳过（作为缺失依赖保留 specifier，但不递归）
            const child_id = self.addFile(deps.items[i].specifier, this_dir, depth + 1) catch |err| switch (err) {
                error.ModuleNotFound => {
                    // 将其标记为 -1 (0xffffffff) —— 运行时报错而非编译期失败，方便调试
                    deps.items[i].target_id = std.math.maxInt(u32);
                    continue;
                },
                else => return err,
            };
            deps.items[i].target_id = child_id;
        }
        self.entries.items[id].deps = deps;
        return id;
    }

    fn emit(self: *Bundler) std.mem.Allocator.Error![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(self.alloc);
        try out.appendSlice(self.alloc,
            \\(function(){
            \\var __modules__=[];
            \\var __cache__={};
            \\function __require(id){
            \\  if(id<0||id>=__modules__.length)throw new Error("module id out of range: "+id);
            \\  if(__cache__[id])return __cache__[id].exports;
            \\  var m={exports:{}};__cache__[id]=m;
            \\  __modules__[id].call(m.exports,m,m.exports,function(spec){
            \\    var t=__modules__[id].__deps__[spec];
            \\    if(t===undefined)throw new Error("unresolved dependency "+spec+" in module "+id);
            \\    return __require(t);
            \\  });
            \\  return m.exports;
            \\}
            \\
        );
        // 每个模块：
        //   __modules__[i]=function(module,exports,require){ ...js... };
        //   __modules__[i].__deps__={ "<spec>": id, ... };
        for (self.entries.items, 0..) |entry, i| {
            try appendFmt(&out, "// {s}\n", .{entry.path});
            try appendFmt(&out, "__modules__[{d}]=function(module,exports,require){{\n", .{i});
            // T5.3.7: inject __filename and __dirname for Node.js compatibility
            try out.appendSlice(self.alloc, "var __filename=");
            try jsonEscapeTo(&out, entry.path);
            try out.appendSlice(self.alloc, ",__dirname=");
            try jsonEscapeTo(&out, pathDirname(entry.path));
            try out.appendSlice(self.alloc, ";\n");
            try out.appendSlice(self.alloc, entry.js_source);
            try out.appendSlice(self.alloc, "\n};\n");
            try appendFmt(&out, "__modules__[{d}].__deps__={{", .{i});
            for (entry.deps.items, 0..) |dep, di| {
                if (di != 0) try out.append(self.alloc, ',');
                try jsonEscapeTo(&out, dep.specifier);
                if (dep.target_id == std.math.maxInt(u32)) {
                    try appendFmt(&out, ":-1", .{});
                } else {
                    try appendFmt(&out, ":{d}", .{dep.target_id});
                }
            }
            try out.appendSlice(self.alloc, "};\n");
        }
        try appendFmt(&out, "return __require({d});\n}})();\n", .{self.entry_id});
        return out.toOwnedSlice(self.alloc);
    }
};

/// T5.3.3: Apply define substitutions to JS source.
/// Replaces occurrences of define keys that appear at identifier boundaries.
/// E.g. `process.env.NODE_ENV` → `"production"`.
fn applyDefines(alloc: std.mem.Allocator, src: []const u8, defines: []const Bundler.DefineEntry) error{OutOfMemory}![]u8 {
    if (defines.len == 0) return alloc.dupe(u8, src);
    var out: std.ArrayListUnmanaged(u8) = .{};
    errdefer out.deinit(alloc);
    var i: usize = 0;
    outer: while (i < src.len) {
        for (defines) |def| {
            if (def.key.len == 0) continue;
            if (i + def.key.len > src.len) continue;
            if (!std.mem.eql(u8, src[i .. i + def.key.len], def.key)) continue;
            // Left boundary: not preceded by identifier char
            if (i > 0) {
                const p = src[i - 1];
                if ((p >= 'a' and p <= 'z') or (p >= 'A' and p <= 'Z') or
                    (p >= '0' and p <= '9') or p == '_' or p == '$') continue;
            }
            // Right boundary: not followed by identifier char or '.' (avoid partial match)
            const after = i + def.key.len;
            if (after < src.len) {
                const n = src[after];
                if ((n >= 'a' and n <= 'z') or (n >= 'A' and n <= 'Z') or
                    (n >= '0' and n <= '9') or n == '_' or n == '$' or n == '.') continue;
            }
            try out.appendSlice(alloc, def.value);
            i += def.key.len;
            continue :outer;
        }
        try out.append(alloc, src[i]);
        i += 1;
    }
    return out.toOwnedSlice(alloc);
}

fn transpileIfNeeded(alloc: std.mem.Allocator, path: []const u8, src: []const u8) error{ OutOfMemory, TranspileFailed }![]u8 {
    const is_ts = std.mem.endsWith(u8, path, ".ts") or
        std.mem.endsWith(u8, path, ".tsx") or
        std.mem.endsWith(u8, path, ".mts") or
        std.mem.endsWith(u8, path, ".cts");
    if (std.mem.endsWith(u8, path, ".json")) {
        // JSON 作为模块：包装成 module.exports = <json>
        return std.fmt.allocPrint(alloc, "module.exports={s};", .{src}) catch error.OutOfMemory;
    }
    if (std.mem.endsWith(u8, path, ".css")) {
        // T5.3.2: CSS as side-effect module — inject a <style> tag when DOM is available.
        var css_buf: std.ArrayList(u8) = .empty;
        defer css_buf.deinit(alloc);
        try css_buf.appendSlice(alloc, "(function(){if(typeof document!==\"undefined\"){var s=document.createElement(\"style\");s.textContent=");
        try jsonEscapeTo(&css_buf, src);
        try css_buf.appendSlice(alloc, ";document.head.appendChild(s);}})();module.exports={};");
        return css_buf.toOwnedSlice(alloc) catch error.OutOfMemory;
    }
    if (!is_ts) return alloc.dupe(u8, src) catch error.OutOfMemory;

    // ── 优先使用 Host jsi_transpile（支持完整 ESM→CJS 降级）──────────
    const h = jsi.imports.jsi_transpile(
        @intFromPtr(src.ptr),
        src.len,
        @intFromPtr(path.ptr),
        path.len,
    );
    if (h != jsi.Value.exception_sentinel) {
        defer jsi.imports.jsi_release(h);
        const js_len = jsi.imports.jsi_string_length(h);
        const js_buf = alloc.alloc(u8, js_len) catch return error.OutOfMemory;
        jsi.imports.jsi_string_read(h, @intFromPtr(js_buf.ptr), js_len);
        // T5.2.8: Host 返回与输入相同（identity 模式）→ 回退到内置 WASM 转译器
        if (!std.mem.eql(u8, js_buf, src)) {
            return js_buf; // Host 做了真实转换，直接使用
        }
        alloc.free(js_buf);
        // fall through to WASM transform with ESM→CJS
    }

    // ── Host 不可用或 identity → 内置 WASM 转译器（T5.2.6: 含 ESM→CJS）────────────
    const opts = bun_wasm_transform.TransformOptions{
        .source = src,
        .filename = path,
        .esm_to_cjs = true, // T5.2.6: WASM 内置 ESM→CJS 转换
        .jsx = if (std.mem.endsWith(u8, path, ".tsx") or std.mem.endsWith(u8, path, ".jsx"))
            .react
        else
            .none,
    };
    var result = bun_wasm_transform.transform(alloc, opts) catch return error.OutOfMemory;
    defer result.deinit();

    if (result.code) |code| {
        return alloc.dupe(u8, code) catch error.OutOfMemory;
    }

    return error.TranspileFailed;
}

/// 扫描源码中的 `require("...")`, `require('...')`, `import ... from "..."`,
/// `import "..."`, 和 `import("...")`。
/// 仅处理静态字符串 specifier。忽略字符串/注释中的匹配（简单状态机）。
fn scanDependencies(alloc: std.mem.Allocator, src: []const u8) error{OutOfMemory}!std.ArrayListUnmanaged(Bundler.DepEdge) {
    var out: std.ArrayListUnmanaged(Bundler.DepEdge) = .{};
    errdefer {
        for (out.items) |*d| alloc.free(d.specifier);
        out.deinit(alloc);
    }

    // 先剥离注释 + 字符串（替换为等长空格），再做简单 substring 扫描，
    // 这样 scanner 逻辑简单且不会把 "require(" 在字符串里误匹配。
    const sanitized = stripCommentsAndStrings(alloc, src) catch return error.OutOfMemory;
    defer alloc.free(sanitized);

    var i: usize = 0;
    while (i < sanitized.len) {
        const next = findNextImportSite(sanitized, i) orelse break;
        // 从 next.after_paren_or_from 开始找字符串字面量
        const spec = extractStringFromOriginal(src, next.quote_search_from) orelse {
            i = next.advance_past;
            continue;
        };
        const copy = alloc.dupe(u8, spec.value) catch return error.OutOfMemory;
        try out.append(alloc, .{ .specifier = copy, .target_id = 0 });
        i = spec.end_in_src;
    }
    return out;
}

const ImportSite = struct {
    /// 原始源码里字符串字面量可能开始的位置（含前导空白）。
    quote_search_from: usize,
    /// sanitized 扫描指针下一步应跳到的位置。
    advance_past: usize,
};

fn findNextImportSite(san: []const u8, from: usize) ?ImportSite {
    var i: usize = from;
    while (i < san.len) : (i += 1) {
        // 形如 `require(` — 需 'e','q','u','i','r','e','(' 且前一个字符为 identifier-stop
        if (san[i] == 'r' and san.len - i >= 8 and std.mem.startsWith(u8, san[i..], "require(")) {
            if (isIdentBoundary(san, i)) {
                return .{ .quote_search_from = i + 8, .advance_past = i + 8 };
            }
        }
        // `import "x"` / `import('x')` / `import x from "x"` / `export ... from "x"`
        if ((san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import ")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import(")) or
            // import"x" / import'x' (no space — Bun transpiler output normalization)
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import\"")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import'")) or
            (san[i] == 'e' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "export ")))
        {
            if (!isIdentBoundary(san, i)) continue;
            // 从此开始寻找第一个 "from " 或直接的字符串字面量
            const fromIdx = findKeywordFromOrQuote(san, i + 6);
            if (fromIdx) |p| return .{ .quote_search_from = p, .advance_past = p };
        }
    }
    return null;
}

fn isIdentBoundary(san: []const u8, at: usize) bool {
    if (at == 0) return true;
    const p = san[at - 1];
    if (p >= 'a' and p <= 'z') return false;
    if (p >= 'A' and p <= 'Z') return false;
    if (p >= '0' and p <= '9') return false;
    if (p == '_' or p == '$') return false;
    return true;
}

fn findKeywordFromOrQuote(san: []const u8, start: usize) ?usize {
    var i: usize = start;
    while (i < san.len) : (i += 1) {
        const c = san[i];
        if (c == '"' or c == '\'') return i;
        if (c == ';' or c == '\n') {
            // 结束 import 语句
            // 但 export 可能跨多行；接受之
            if (c == ';') return null;
        }
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from ") and isIdentBoundary(san, i)) {
            // 跳过 "from "，继续寻找引号
            return findQuote(san, i + 5);
        }
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from\t") and isIdentBoundary(san, i)) {
            return findQuote(san, i + 5);
        }
    }
    return null;
}

fn findQuote(san: []const u8, start: usize) ?usize {
    var i: usize = start;
    while (i < san.len) : (i += 1) {
        const c = san[i];
        if (c == '"' or c == '\'') return i;
        if (c == ';' or c == '\n') return null;
    }
    return null;
}

const StringLiteral = struct { value: []const u8, end_in_src: usize };

fn extractStringFromOriginal(src: []const u8, from: usize) ?StringLiteral {
    var i: usize = from;
    while (i < src.len and (src[i] == ' ' or src[i] == '\t')) : (i += 1) {}
    if (i >= src.len) return null;
    const q = src[i];
    if (q != '"' and q != '\'') return null;
    const start = i + 1;
    var j: usize = start;
    while (j < src.len) : (j += 1) {
        const c = src[j];
        if (c == '\\') {
            j += 1;
            continue;
        }
        if (c == q) break;
    }
    if (j >= src.len) return null;
    return .{ .value = src[start..j], .end_in_src = j + 1 };
}

/// 将 src 中的字符串/模板/注释替换为等长空白（换行保留以保持行号）。
fn stripCommentsAndStrings(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
    const out = try alloc.alloc(u8, src.len);
    @memcpy(out, src);
    var i: usize = 0;
    while (i < out.len) {
        const c = out[i];
        if (c == '/' and i + 1 < out.len and out[i + 1] == '/') {
            // 行注释
            while (i < out.len and out[i] != '\n') : (i += 1) out[i] = ' ';
            continue;
        }
        if (c == '/' and i + 1 < out.len and out[i + 1] == '*') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            while (i + 1 < out.len and !(out[i] == '*' and out[i + 1] == '/')) : (i += 1) {
                if (out[i] != '\n') out[i] = ' ';
            }
            if (i + 1 < out.len) {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
            }
            continue;
        }
        if (c == '"' or c == '\'' or c == '`') {
            const quote = c;
            out[i] = ' ';
            i += 1;
            while (i < out.len) {
                if (out[i] == '\\' and i + 1 < out.len) {
                    out[i] = ' ';
                    if (out[i + 1] != '\n') out[i + 1] = ' ';
                    i += 2;
                    continue;
                }
                if (out[i] == quote) {
                    out[i] = ' ';
                    i += 1;
                    break;
                }
                if (out[i] != '\n') out[i] = ' ';
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// bun_integrity_verify
// ──────────────────────────────────────────────────────────────────────────────
//
// ABI: (data_ptr, data_len, integrity_ptr, integrity_len) → u32
//
// `data`      — raw bytes (e.g. a downloaded .tgz tarball).
// `integrity` — Subresource Integrity (SRI) string, e.g. "sha512-<base64>".
//               Also accepts plain sha1 hex ("sha1-<hex>") and bare shasum
//               (40-char hex, treated as sha1).
//
// Returns:
//   0 — verification passed (or integrity string is empty/unknown → treated as pass)
//   1 — verification failed (hash mismatch)
//   2 — bad integrity string / unsupported algorithm
//
export fn bun_integrity_verify(
    data_ptr: [*]const u8,
    data_len: u32,
    integrity_ptr: [*]const u8,
    integrity_len: u32,
) u32 {
    const data = data_ptr[0..data_len];
    const sri = integrity_ptr[0..integrity_len];
    return integrityVerify(data, sri);
}

fn integrityVerify(data: []const u8, sri: []const u8) u32 {
    const Base64NoPad = std.base64.standard_no_pad;

    if (sri.len == 0) return 0; // no integrity → pass

    // Locate the '-' separator: "sha512-<base64>"
    const dash = std.mem.indexOfScalar(u8, sri, '-') orelse {
        // Could be a bare 40-char hex shasum (legacy npm field)
        if (sri.len == 40) {
            // Parse hex → sha1 digest
            var expected: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
            if (!hexDecode(&expected, sri)) return 2;
            var actual: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
            std.crypto.hash.Sha1.hash(data, &actual, .{});
            return if (std.mem.eql(u8, &actual, &expected)) 0 else 1;
        }
        return 2;
    };

    const algo = sri[0..dash];
    const b64 = std.mem.trimRight(u8, sri[dash + 1 ..], "=");

    if (std.mem.eql(u8, algo, "sha512")) {
        const len = std.crypto.hash.sha2.Sha512.digest_length;
        var expected: [len]u8 = undefined;
        const decoded_size = Base64NoPad.Decoder.calcSizeForSlice(b64) catch return 2;
        if (decoded_size != len) return 2;
        Base64NoPad.Decoder.decode(&expected, b64) catch return 2;
        var actual: [len]u8 = undefined;
        std.crypto.hash.sha2.Sha512.hash(data, &actual, .{});
        return if (std.mem.eql(u8, &actual, &expected)) 0 else 1;
    } else if (std.mem.eql(u8, algo, "sha384")) {
        const len = std.crypto.hash.sha2.Sha384.digest_length;
        var expected: [len]u8 = undefined;
        const decoded_size = Base64NoPad.Decoder.calcSizeForSlice(b64) catch return 2;
        if (decoded_size != len) return 2;
        Base64NoPad.Decoder.decode(&expected, b64) catch return 2;
        var actual: [len]u8 = undefined;
        std.crypto.hash.sha2.Sha384.hash(data, &actual, .{});
        return if (std.mem.eql(u8, &actual, &expected)) 0 else 1;
    } else if (std.mem.eql(u8, algo, "sha256")) {
        const len = std.crypto.hash.sha2.Sha256.digest_length;
        var expected: [len]u8 = undefined;
        const decoded_size = Base64NoPad.Decoder.calcSizeForSlice(b64) catch return 2;
        if (decoded_size != len) return 2;
        Base64NoPad.Decoder.decode(&expected, b64) catch return 2;
        var actual: [len]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(data, &actual, .{});
        return if (std.mem.eql(u8, &actual, &expected)) 0 else 1;
    } else if (std.mem.eql(u8, algo, "sha1")) {
        const len = std.crypto.hash.Sha1.digest_length;
        var expected: [len]u8 = undefined;
        const decoded_size = Base64NoPad.Decoder.calcSizeForSlice(b64) catch return 2;
        if (decoded_size != len) return 2;
        Base64NoPad.Decoder.decode(&expected, b64) catch return 2;
        var actual: [len]u8 = undefined;
        std.crypto.hash.Sha1.hash(data, &actual, .{});
        return if (std.mem.eql(u8, &actual, &expected)) 0 else 1;
    }

    // Unknown algorithm — treat as pass (forward-compatible)
    return 0;
}

/// Decode a lowercase hex string into `out`. Returns false if the input is
/// not valid hex or has the wrong length.
fn hexDecode(out: []u8, hex: []const u8) bool {
    if (hex.len != out.len * 2) return false;
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        const hi = hexNibble(hex[i * 2]) orelse return false;
        const lo = hexNibble(hex[i * 2 + 1]) orelse return false;
        out[i] = (@as(u8, hi) << 4) | @as(u8, lo);
    }
    return true;
}

inline fn hexNibble(c: u8) ?u4 {
    return switch (c) {
        '0'...'9' => @as(u4, @intCast(c - '0')),
        'a'...'f' => @as(u4, @intCast(c - 'a' + 10)),
        'A'...'F' => @as(u4, @intCast(c - 'A' + 10)),
        else => null,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.1 T5.1.2 — bun_hash / bun_base64_encode / bun_base64_decode
// ──────────────────────────────────────────────────────────────────────────────

/// Compute a raw cryptographic digest of `data`.
///
/// algo: 0=SHA-1(20B), 1=SHA-256(32B), 2=SHA-512(64B), 3=SHA-384(48B), 4=MD5(16B)
/// Signature: (data_ptr, data_len, algo) — algo is the THIRD argument to match
/// the TypeScript callPackedRaw(fnName, data, extra) convention.
///
/// Returns packed (ptr << 32 | len) pointing to raw digest bytes in host_allocs.
/// Host must call bun_free(ptr) when done.
/// Returns packError(1) on OOM, packError(2) on unknown algo.
export fn bun_hash(data_ptr: [*]const u8, data_len: u32, algo: u32) u64 {
    const data = data_ptr[0..data_len];
    const digest = doHash(algo, data) catch |err| return switch (err) {
        error.OutOfMemory => packError(1),
        error.UnknownAlgo => packError(2),
    };
    return handOff(digest);
}

fn doHash(algo: u32, data: []const u8) error{ OutOfMemory, UnknownAlgo }![]u8 {
    switch (algo) {
        0 => {
            var d: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
            std.crypto.hash.Sha1.hash(data, &d, .{});
            return allocator.dupe(u8, &d);
        },
        1 => {
            var d: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(data, &d, .{});
            return allocator.dupe(u8, &d);
        },
        2 => {
            var d: [std.crypto.hash.sha2.Sha512.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha512.hash(data, &d, .{});
            return allocator.dupe(u8, &d);
        },
        3 => {
            var d: [std.crypto.hash.sha2.Sha384.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha384.hash(data, &d, .{});
            return allocator.dupe(u8, &d);
        },
        4 => {
            var d: [std.crypto.hash.Md5.digest_length]u8 = undefined;
            std.crypto.hash.Md5.hash(data, &d, .{});
            return allocator.dupe(u8, &d);
        },
        else => return error.UnknownAlgo,
    }
}

/// Encode `data` as standard Base64 (with `=` padding).
///
/// Returns packed (ptr << 32 | len) pointing to ASCII bytes in host_allocs.
/// Host must call bun_free(ptr) when done.
/// Returns packError(1) on OOM.
export fn bun_base64_encode(data_ptr: [*]const u8, data_len: u32) u64 {
    const data = data_ptr[0..data_len];
    const enc_len = std.base64.standard.Encoder.calcSize(data.len);
    const buf = allocator.alloc(u8, enc_len) catch return packError(1);
    _ = std.base64.standard.Encoder.encode(buf, data);
    return handOff(buf);
}

/// Decode standard Base64 (strips trailing `=` for compatibility with no-pad input).
///
/// Returns packed (ptr << 32 | len) pointing to decoded bytes in host_allocs.
/// Host must call bun_free(ptr) when done.
/// Returns packError(1) on OOM, packError(2) on invalid base64.
export fn bun_base64_decode(data_ptr: [*]const u8, data_len: u32) u64 {
    const data = data_ptr[0..data_len];
    const decoded = base64DecodeImpl(data) catch |err| return switch (err) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
    return handOff(decoded);
}

fn base64DecodeImpl(data: []const u8) ![]u8 {
    // Strip trailing '=' padding; use no-pad decoder so both padded and unpadded input work.
    const stripped = std.mem.trimRight(u8, data, "=");
    const Dec = std.base64.standard_no_pad.Decoder;
    const decoded_size = try Dec.calcSizeForSlice(stripped);
    const buf = try allocator.alloc(u8, decoded_size);
    errdefer allocator.free(buf);
    try Dec.decode(buf, stripped);
    return buf;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.1 T5.1.3 — bun_inflate / bun_deflate
// ──────────────────────────────────────────────────────────────────────────────

/// Decompress `src` using the flate algorithm (gzip, zlib, or raw deflate).
///
/// format: 0=gzip, 1=zlib, 2=raw deflate
///
/// Returns packed (ptr << 32 | len) pointing to decompressed bytes in host_allocs.
/// Host must call bun_free(ptr) when done.
/// Returns packError(1) on OOM, packError(2) on decompression error or unknown format.
export fn bun_inflate(src_ptr: [*]const u8, src_len: u32, format: u32) u64 {
    const src = src_ptr[0..src_len];
    const decompressed = inflateImpl(src, format) catch |err| return switch (err) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
    return handOff(decompressed);
}

fn inflateImpl(src: []const u8, format: u32) ![]u8 {
    const container: std.compress.flate.Container = switch (format) {
        0 => .gzip,
        1 => .zlib,
        2 => .raw,
        else => return error.InvalidArgument,
    };
    var r: std.Io.Reader = .fixed(src);
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var decomp: std.compress.flate.Decompress = .init(&r, container, &.{});
    _ = try decomp.reader.streamRemaining(&aw.writer);
    return try allocator.dupe(u8, aw.written());
}
// Note: bun_deflate (compression) is deferred — std.compress.flate.Compress in Zig 0.15.2
// has an internal I/O API mismatch between Compress.zig (new std.Io.Writer) and
// BlockWriter.zig (old std.io.Writer). Decompression (bun_inflate) is unaffected.

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.3 — bun_tgz_extract
// Decompress a .tgz tarball and write extracted files directly into the WASM VFS.
// ──────────────────────────────────────────────────────────────────────────────

const TAR_BLOCK: usize = 512;

/// Read a null-terminated ASCII octal number from a tar header field.
fn tarReadOctal(buf: []const u8) u64 {
    var result: u64 = 0;
    for (buf) |c| {
        if (c == 0 or c == ' ') break;
        if (c >= '0' and c <= '7') {
            result = result *% 8 +% @as(u64, c - '0');
        }
    }
    return result;
}

/// Return the slice up to the first NUL byte (null-terminator for tar strings).
fn tarReadStr(buf: []const u8) []const u8 {
    for (buf, 0..) |c, i| {
        if (c == 0) return buf[0..i];
    }
    return buf;
}

/// Strip the first path component ("package/...") — standard npm tarball layout.
fn tarStripFirstComponent(path: []const u8) []const u8 {
    const slash = std.mem.indexOfScalar(u8, path, '/') orelse return path;
    return if (slash + 1 < path.len) path[slash + 1 ..] else "";
}

/// Parse a PAX extended header block to extract the "path" field value.
/// Returns a slice into `data` on success, null if not found.
fn tarParsePaxPath(data: []const u8) ?[]const u8 {
    var off: usize = 0;
    while (off < data.len) {
        // Each record: "<decimal-len> <key>=<value>\n"
        const sp = std.mem.indexOfScalarPos(u8, data, off, ' ') orelse break;
        const eq = std.mem.indexOfScalarPos(u8, data, sp + 1, '=') orelse break;
        const nl = std.mem.indexOfScalarPos(u8, data, eq + 1, '\n') orelse break;
        const key = data[sp + 1 .. eq];
        if (std.mem.eql(u8, key, "path")) return data[eq + 1 .. nl];
        const record_len = std.fmt.parseInt(usize, data[off..sp], 10) catch break;
        off += record_len;
    }
    return null;
}

/// T5.4.3 — Extract a .tgz tarball directly into the WASM VFS.
///
/// Input layout (packed buffer):
///   [prefix_len: u32 LE][prefix bytes][tgz bytes]
///
/// `prefix` is prepended to each extracted path (e.g. "/node_modules/react").
/// The leading "package/" component in npm tarballs is stripped.
///
/// Returns packed (ptr << 32 | len) → JSON `{"extracted":N}`.
/// Errors: packError(1)=OOM, packError(2)=decompress fail, packError(3)=bad input.
export fn bun_tgz_extract(input_ptr: [*]const u8, input_len: u32) u64 {
    if (input_len < 4) return packError(3);
    const buf = input_ptr[0..input_len];
    const prefix_len = std.mem.readInt(u32, buf[0..4], .little);
    if (4 + prefix_len > input_len) return packError(3);
    const prefix = buf[4 .. 4 + prefix_len];
    const tgz = buf[4 + prefix_len .. input_len];

    // 1. Decompress gzip → raw tar bytes
    const tar = inflateImpl(tgz, 0) catch return packError(2);
    defer allocator.free(tar);

    // 2. Parse tar + write files to VFS
    var off: usize = 0;
    var extracted: u32 = 0;

    // Buffers for GNU long-name / PAX path overrides
    var gnu_name_buf: [4096]u8 = undefined;
    var gnu_name_len: usize = 0;
    var pax_name_buf: [4096]u8 = undefined;
    var pax_name_len: usize = 0;
    // Buffer for ustar prefix+name concatenation
    var ustar_path_buf: [4096]u8 = undefined;

    while (off + TAR_BLOCK <= tar.len) {
        const header = tar[off .. off + TAR_BLOCK];

        // End-of-archive: two consecutive zero-filled blocks.
        var all_zero = true;
        for (header) |c| {
            if (c != 0) { all_zero = false; break; }
        }
        if (all_zero) { off += TAR_BLOCK; continue; }

        const size: usize = @intCast(tarReadOctal(header[124..136]));
        const type_flag = header[156];
        const data_start = off + TAR_BLOCK;
        const padded = ((size + TAR_BLOCK - 1) / TAR_BLOCK) * TAR_BLOCK;
        const next_off = data_start + padded;

        if (data_start + size > tar.len) break; // truncated
        const data = tar[data_start .. data_start + size];
        off = next_off;

        switch (type_flag) {
            'L' => {
                // GNU long name: data contains the long filename (null-terminated).
                const n = @min(size, gnu_name_buf.len);
                @memcpy(gnu_name_buf[0..n], data[0..n]);
                gnu_name_len = n;
                // Trim trailing NULs
                while (gnu_name_len > 0 and gnu_name_buf[gnu_name_len - 1] == 0) gnu_name_len -= 1;
                continue;
            },
            'x' => {
                // PAX extended header
                if (tarParsePaxPath(data)) |pname| {
                    const n = @min(pname.len, pax_name_buf.len);
                    @memcpy(pax_name_buf[0..n], pname[0..n]);
                    pax_name_len = n;
                }
                continue;
            },
            'g' => { continue; }, // global PAX header — ignore
            '5' => {
                // Directory entry — reset pending names, skip
                gnu_name_len = 0;
                pax_name_len = 0;
                continue;
            },
            '0', '7', 0 => {}, // regular file — fall through to extraction
            else => {
                gnu_name_len = 0;
                pax_name_len = 0;
                continue;
            },
        }

        // Determine the raw path from the header
        // Priority: PAX extended path > GNU long name > ustar name+prefix
        const name_raw: []const u8 = name_blk: {
            if (pax_name_len > 0) {
                const n = pax_name_len;
                pax_name_len = 0;
                gnu_name_len = 0;
                break :name_blk pax_name_buf[0..n];
            }
            if (gnu_name_len > 0) {
                const n = gnu_name_len;
                gnu_name_len = 0;
                break :name_blk gnu_name_buf[0..n];
            }
            // Standard ustar path
            const name_field = tarReadStr(header[0..100]);
            const prefix_field = tarReadStr(header[345..500]);
            const ustar_magic = header[257..263];
            if (std.mem.startsWith(u8, ustar_magic, "ustar") and prefix_field.len > 0) {
                const total = prefix_field.len + 1 + name_field.len;
                if (total <= ustar_path_buf.len) {
                    @memcpy(ustar_path_buf[0..prefix_field.len], prefix_field);
                    ustar_path_buf[prefix_field.len] = '/';
                    @memcpy(ustar_path_buf[prefix_field.len + 1 .. prefix_field.len + 1 + name_field.len], name_field);
                    break :name_blk ustar_path_buf[0..total];
                }
            }
            break :name_blk name_field;
        };

        // Strip leading "package/" (npm convention) or any single top-level dir
        const stripped = tarStripFirstComponent(name_raw);
        if (stripped.len == 0) continue; // only the root dir itself

        // Build absolute VFS path: prefix + "/" + stripped
        const full_path = joinPath(allocator, prefix, stripped) catch return packError(1);
        defer allocator.free(full_path);

        // Ensure parent directory exists (including intermediate dirs)
        if (std.mem.lastIndexOfScalar(u8, full_path, '/')) |last_slash| {
            if (last_slash > 0) {
                vfs_g.mkdirp(full_path[0..last_slash]) catch {};
            }
        }

        // Write file content to VFS
        vfs_g.writeFile(full_path, data, 0o644) catch return packError(1);
        extracted += 1;
    }

    // Return JSON result
    var result: std.ArrayList(u8) = .empty;
    defer result.deinit(allocator);
    std.fmt.format(result.writer(allocator), "{{\"extracted\":{d}}}", .{extracted}) catch return packError(1);
    const out = allocator.dupe(u8, result.items) catch return packError(1);
    return handOff(out);
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.1 T5.1.1 — bun_path_normalize / bun_path_dirname / bun_path_join
// Uses std.fs.path (pure Zig stdlib, no system calls → WASM-safe).
// All functions follow the packed (ptr << 32 | len) return convention.
// ──────────────────────────────────────────────────────────────────────────────

/// Normalize a POSIX path: resolve `.` / `..`, collapse duplicate separators.
/// Input: UTF-8 path string.
/// Returns packed (ptr << 32 | len) pointing to the result. Host must bun_free(ptr).
/// Returns packError(1) on OOM.
export fn bun_path_normalize(ptr: [*]const u8, len: u32) u64 {
    const path = ptr[0..len];
    const result = std.fs.path.resolvePosix(allocator, &.{path}) catch return packError(1);
    return handOff(result);
}

/// Return the POSIX dirname of a path (everything before the last `/`).
/// Returns "/" for root paths and paths with no `/`.
/// Returns packed (ptr << 32 | len) pointing to the result. Host must bun_free(ptr).
/// Returns packError(1) on OOM.
export fn bun_path_dirname(ptr: [*]const u8, len: u32) u64 {
    const path = ptr[0..len];
    const dir = std.fs.path.dirnamePosix(path) orelse "/";
    const result = allocator.dupe(u8, dir) catch return packError(1);
    return handOff(result);
}

/// Join two POSIX path segments: base_dir + "/" + rel, then normalize.
/// `paths_ptr` points to a packed buffer: [base_len: u32 LE][base bytes][rel bytes]
/// `paths_len` = total buffer length.
/// Returns packed (ptr << 32 | len) pointing to the result. Host must bun_free(ptr).
/// Returns packError(1) on OOM, packError(2) on malformed input.
export fn bun_path_join(paths_ptr: [*]const u8, paths_len: u32) u64 {
    if (paths_len < 4) return packError(2);
    const buf = paths_ptr[0..paths_len];
    const base_len = std.mem.readInt(u32, buf[0..4], .little);
    if (4 + base_len > paths_len) return packError(2);
    const base = buf[4 .. 4 + base_len];
    const rel = buf[4 + base_len .. paths_len];
    const result = joinPath(allocator, base, rel) catch return packError(1);
    return handOff(result);
}


// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.2 — bun_transform (TS/JSX → JS 内置转译器)
// ──────────────────────────────────────────────────────────────────────────────

/// Transform TypeScript/JSX source to plain JS using the built-in WASM transformer.
///
/// opts_ptr: pointer to JSON string: { "code": <TS source>, "filename": <file.ts>, "jsx": "react"|... }
/// opts_len: length of JSON string
/// Returns packed (ptr << 32 | len) pointing to JSON string: { "code": <JS>, "errors": [] } or { "code": null, "errors": ["..."] }
/// Returns 0 on OOM (low 32 bits = error code)
export fn bun_transform(opts_ptr: [*]const u8, opts_len: u32) u64 {
    if (!initialized) return packError(1);
    const opts_json = opts_ptr[0..opts_len];
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, opts_json, .{}) catch return packError(2);
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return packError(2);
    const code_val = root.object.get("code") orelse return packError(2);
    const filename_val = root.object.get("filename") orelse return packError(2);
    const jsx_val = root.object.get("jsx");
    const code = switch (code_val) { .string => |s| s, else => return packError(2), };
    const filename = switch (filename_val) { .string => |s| s, else => return packError(2), };
    var jsx_mode: bun_wasm_transform.TransformOptions.JsxMode = .react;
    if (jsx_val) |jv| {
        if (jv == .string) {
            if (std.mem.eql(u8, jv.string, "react")) jsx_mode = .react
            else if (std.mem.eql(u8, jv.string, "react-jsx")) jsx_mode = .react_jsx
            else if (std.mem.eql(u8, jv.string, "preserve")) jsx_mode = .preserve
            else jsx_mode = .none;
        }
    }
    const opts = bun_wasm_transform.TransformOptions{
        .source = code,
        .filename = filename,
        .jsx = jsx_mode,
        .esm_to_cjs = if (root.object.get("esm_to_cjs")) |v| switch (v) {
            .bool => |b| b,
            else => false,
        } else false,
        .source_map = if (root.object.get("source_map")) |v| switch (v) {
            .bool => |b| b,
            else => false,
        } else false,
    };
    var result = bun_wasm_transform.transform(allocator, opts) catch {
        const err_json = "{\"code\":null,\"errors\":[\"transform failed\"]}";
        const buf = allocator.dupe(u8, err_json) catch return packError(1);
        return handOff(buf);
    };
    defer result.deinit();
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    if (result.code) |js| {
        out.appendSlice(allocator, "{\"code\":") catch return packError(1);
        jsonEscapeTo(&out, js) catch return packError(1);
        if (result.map) |m| {
            out.appendSlice(allocator, ",\"map\":") catch return packError(1);
            jsonEscapeTo(&out, m) catch return packError(1);
        }
        out.appendSlice(allocator, ",\"errors\":[]}") catch return packError(1);
    } else {
        out.appendSlice(allocator, "{\"code\":null,\"errors\":[") catch return packError(1);
        for (result.errors, 0..) |e, i| {
            if (i != 0) out.append(allocator, ',') catch return packError(1);
            jsonEscapeTo(&out, e) catch return packError(1);
        }
        out.appendSlice(allocator, "]}") catch return packError(1);
    }
    const owned = out.toOwnedSlice(allocator) catch return packError(1);
    return handOff(owned);
}

/// Parse a URL string and return a JSON object with its components.
///
/// Returns packed (ptr << 32 | len) pointing to a JSON UTF-8 string.
/// Host must bun_free(ptr) when done.
/// Returns packError(1) on OOM, packError(2) on parse error.
///
/// JSON shape matches UrlComponents interface:
/// { "href", "scheme", "protocol", "host", "hostname",
///   "port", "pathname", "search", "hash", "auth": null }
export fn bun_url_parse(ptr: [*]const u8, len: u32) u64 {
    const url_str = ptr[0..len];
    const uri = std.Uri.parse(url_str) catch return packError(2);

    // --- extract raw (percent-encoded) component strings ---
    const scheme = uri.scheme;

    const hostname_raw: []const u8 = if (uri.host) |h| switch (h) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    } else "";

    const path_raw: []const u8 = switch (uri.path) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    };

    const query_raw: ?[]const u8 = if (uri.query) |q| switch (q) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    } else null;

    const fragment_raw: ?[]const u8 = if (uri.fragment) |f| switch (f) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    } else null;

    // --- derived values ---
    // protocol = scheme + ":"
    const protocol = allocator.alloc(u8, scheme.len + 1) catch return packError(1);
    defer allocator.free(protocol);
    @memcpy(protocol[0..scheme.len], scheme);
    protocol[scheme.len] = ':';

    // port as string (empty string when absent)
    var port_buf: [8]u8 = undefined;
    const port_str: []const u8 = if (uri.port) |p|
        std.fmt.bufPrint(&port_buf, "{d}", .{p}) catch return packError(1)
    else
        "";

    // host = hostname + ":" + port (or just hostname)
    var host_buf: [256]u8 = undefined;
    const host_str: []const u8 = if (uri.port != null)
        std.fmt.bufPrint(&host_buf, "{s}:{s}", .{ hostname_raw, port_str }) catch return packError(1)
    else
        hostname_raw;

    // search = "?" + query (or "" when absent)
    const search_str: []const u8 = if (query_raw) |q| blk: {
        const s = allocator.alloc(u8, 1 + q.len) catch return packError(1);
        s[0] = '?';
        @memcpy(s[1..], q);
        break :blk s;
    } else "";
    defer if (query_raw != null) allocator.free(search_str);

    // hash = "#" + fragment (or "" when absent)
    const hash_str: []const u8 = if (fragment_raw) |f| blk: {
        const h = allocator.alloc(u8, 1 + f.len) catch return packError(1);
        h[0] = '#';
        @memcpy(h[1..], f);
        break :blk h;
    } else "";
    defer if (fragment_raw != null) allocator.free(hash_str);

    // --- serialize JSON ---
    var json_buf: std.ArrayListUnmanaged(u8) = .{};
    defer json_buf.deinit(allocator);

    const w = json_buf.writer(allocator);

    w.writeAll("{") catch return packError(1);
    jsonWriteStringField(w, "href", url_str) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "scheme", scheme) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "protocol", protocol) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "host", host_str) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "hostname", hostname_raw) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "port", port_str) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "pathname", if (path_raw.len > 0) path_raw else "/") catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "search", search_str) catch return packError(1);
    w.writeAll(",") catch return packError(1);
    jsonWriteStringField(w, "hash", hash_str) catch return packError(1);
    w.writeAll(",\"auth\":null}") catch return packError(1);

    const json_bytes = allocator.dupe(u8, json_buf.items) catch return packError(1);
    return handOff(json_bytes);
}

/// Write a JSON string field: `"key":"value"` (with JSON escaping).
fn jsonWriteStringField(
    w: std.ArrayListUnmanaged(u8).Writer,
    key: []const u8,
    value: []const u8,
) !void {
    try w.writeByte('"');
    try w.writeAll(key);
    try w.writeAll("\":");
    try jsonWriteString(w, value);
}

/// Write a JSON-escaped string literal (including surrounding `"`).
fn jsonWriteString(w: std.ArrayListUnmanaged(u8).Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0x00...0x08, 0x0b, 0x0c, 0x0e...0x1f => try std.fmt.format(w, "\\u{x:0>4}", .{c}),
            else => try w.writeByte(c),
        }
    }
    try w.writeByte('"');
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.5 — bun_lockfile_write
// Generate a minimal bun.lock JSON text from an installed packages manifest.
//
// Input JSON:
//   {
//     "packages": [{ "key":"react@18.2.0", "name":"react", "version":"18.2.0" }, ...],
//     "workspaceCount": 1
//   }
//
// Returns packed (ptr << 32 | len) → UTF-8 bun.lock text (JSON5-compatible).
// Errors: packError(1)=OOM, packError(2)=invalid input JSON.
// ──────────────────────────────────────────────────────────────────────────────

export fn bun_lockfile_write(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!initialized) return packError(2);
    const input = input_ptr[0..input_len];
    return lockfileWrite(input) catch |e| switch (e) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

fn lockfileWrite(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    const pkgs_arr: std.json.Array = switch (root.get("packages") orelse .null) {
        .array => |a| a,
        else => return error.SyntaxError,
    };
    const workspace_count: i64 = if (root.get("workspaceCount")) |wc| switch (wc) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => 1,
    } else 1;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator,
        "{\n  \"lockfileVersion\": 0,\n  \"workspaces\": {\n    \"\": {\n      \"name\": \"\"\n    }\n  },\n");
    _ = workspace_count;

    try out.appendSlice(allocator, "  \"packages\": {\n");
    for (pkgs_arr.items, 0..) |item, idx| {
        if (item != .object) continue;
        const pkg = item.object;
        const key = switch (pkg.get("key") orelse .null) { .string => |s| s, else => continue };
        const name = switch (pkg.get("name") orelse .null) { .string => |s| s, else => continue };
        const ver = switch (pkg.get("version") orelse .null) { .string => |s| s, else => continue };
        if (idx > 0) try out.appendSlice(allocator, ",\n");
        // "react@18.2.0": ["react@18.2.0", {...}]
        try out.appendSlice(allocator, "    ");
        try jsonEscapeTo(&out, key);
        try out.appendSlice(allocator, ": [");
        try jsonEscapeTo(&out, name);
        try out.append(allocator, '@');
        // The string was opened above — we already closed the first arg. Rebuild properly.
        // Actually restart: key-value pair format: "<key>": ["<name>@<ver>", {}]
        // Remove what we partially wrote — simpler to just assemble correctly:
        // Undo last append by truncating.
        out.shrinkRetainingCapacity(out.items.len - (1 + key.len + 4 + name.len + 1));
        // Correct assembly:
        try out.appendSlice(allocator, "    ");
        try jsonEscapeTo(&out, key);
        try out.appendSlice(allocator, ": [\"");
        try out.appendSlice(allocator, name);
        try out.append(allocator, '@');
        try out.appendSlice(allocator, ver);
        try out.appendSlice(allocator, "\", {}]");
    }
    try out.appendSlice(allocator, "\n  }\n}\n");

    return handOff(try out.toOwnedSlice(allocator));
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.2 — bun_npm_resolve_graph
// Flatten a dependency graph using BFS entirely inside WASM.
//
// Input JSON:
//   {
//     "deps": {"react": "^18.0.0", "lodash": "^4.17.0"},
//     "metadata": {
//       "react":  "<raw npm registry json>",
//       "lodash": "<raw npm registry json>"
//     }
//   }
//
// Returns packed (ptr << 32 | len) → JSON:
//   {
//     "resolved": [
//       {"name":"react","version":"18.2.0","tarball":"...","integrity":"...","shasum":"...","dependencies":{...}},
//       ...
//     ],
//     "missing": ["somepkg"]   // packages with metadata absent from the input map
//   }
//
// Error codes: 1=OOM, 2=bad input JSON.
// ──────────────────────────────────────────────────────────────────────────────

export fn bun_npm_resolve_graph(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!initialized) return packError(2);
    const input = input_ptr[0..input_len];
    return npmResolveGraph(input) catch |e| switch (e) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

fn npmResolveGraph(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .duplicate_field_behavior = .use_last,
    });
    defer parsed.deinit();

    const root = switch (parsed.value) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    // Initial direct deps: {"name": "range", ...}
    const top_deps: std.json.ObjectMap = switch (root.get("deps") orelse .null) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    // Metadata map: {"name": "<npm json string>", ...}
    const meta_map: std.json.ObjectMap = switch (root.get("metadata") orelse std.json.Value.null) {
        .object => |o| o,
        else => std.json.ObjectMap.init(allocator),
    };

    // BFS queue item type
    const QueueItem = struct { name: []const u8, range: []const u8 };
    // BFS structures
    var queue: std.ArrayListUnmanaged(QueueItem) = .empty;
    defer queue.deinit(allocator);
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    var resolved: std.ArrayListUnmanaged(u8) = .empty;
    defer resolved.deinit(allocator);
    var missing: std.ArrayListUnmanaged(u8) = .empty;
    defer missing.deinit(allocator);

    // Seed queue with top-level deps
    {
        var it = top_deps.iterator();
        while (it.next()) |entry| {
            const rng = switch (entry.value_ptr.*) { .string => |s| s, else => "*" };
            try queue.append(allocator, .{ .name = entry.key_ptr.*, .range = rng });
        }
    }

    var resolved_count: usize = 0;
    var missing_count: usize = 0;

    while (queue.items.len > 0) {
        const item = queue.orderedRemove(0);
        if (seen.contains(item.name)) continue;
        try seen.put(item.name, {});

        // Look up metadata for this package
        const meta_val = meta_map.get(item.name) orelse {
            // Missing metadata — report to caller
            if (missing_count > 0) try missing.append(allocator, ',');
            try jsonEscapeTo2(&missing, allocator, item.name);
            missing_count += 1;
            continue;
        };
        const meta_json: []const u8 = switch (meta_val) { .string => |s| s, else => continue };

        // Parse metadata + resolve version
        const result_packed = npmParseMetadata(meta_json, item.range) catch continue;
        const out_ptr = @as(u32, @truncate(result_packed >> 32));
        const out_len = @as(u32, @truncate(result_packed & 0xffffffff));
        if (out_ptr == 0) continue; // no match

        // Read the result JSON from WASM memory
        const result_slice = @as([*]const u8, @ptrFromInt(out_ptr))[0..out_len];
        // result_slice is a JSON object like {"version":...,"dependencies":{...}}
        // Inject "name" field
        if (resolved_count > 0) try resolved.append(allocator, ',');
        try resolved.appendSlice(allocator, "{\"name\":");
        try jsonEscapeTo2(&resolved, allocator, item.name);
        try resolved.append(allocator, ',');
        // Append the rest of the JSON object (skip leading '{')
        if (result_slice.len > 1) {
            try resolved.appendSlice(allocator, result_slice[1..]);
        } else {
            try resolved.append(allocator, '}');
        }
        resolved_count += 1;

        // Enqueue transitive deps by re-parsing the result JSON (before freeing)
        var sub_parsed = std.json.parseFromSlice(std.json.Value, allocator, result_slice, .{}) catch {
            allocator.free(result_slice);
            continue;
        };
        defer sub_parsed.deinit();
        if (sub_parsed.value == .object) {
            if (sub_parsed.value.object.get("dependencies")) |dv| {
                if (dv == .object) {
                    var dep_it = dv.object.iterator();
                    while (dep_it.next()) |dep_entry| {
                        const dname = dep_entry.key_ptr.*;
                        if (!seen.contains(dname)) {
                            const drng = switch (dep_entry.value_ptr.*) { .string => |s| s, else => "*" };
                            try queue.append(allocator, .{ .name = dname, .range = drng });
                        }
                    }
                }
            }
        }
        // Free the handOff allocation after we're done with it
        allocator.free(result_slice);
    }

    // Build output JSON
    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"resolved\":[");
    try out.appendSlice(allocator, resolved.items);
    try out.appendSlice(allocator, "],\"missing\":[");
    try out.appendSlice(allocator, missing.items);
    try out.appendSlice(allocator, "]}");
    return handOff(try allocator.dupe(u8, out.items));
}

fn jsonEscapeTo2(out: *std.ArrayListUnmanaged(u8), alloc: std.mem.Allocator, s: []const u8) !void {
    try out.append(alloc, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(alloc, "\\\""),
            '\\' => try out.appendSlice(alloc, "\\\\"),
            '\n' => try out.appendSlice(alloc, "\\n"),
            '\r' => try out.appendSlice(alloc, "\\r"),
            '\t' => try out.appendSlice(alloc, "\\t"),
            0...0x08, 0x0b, 0x0c, 0x0e...0x1f => {
                var buf: [6]u8 = undefined;
                const s2 = std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c}) catch unreachable;
                try out.appendSlice(alloc, s2);
            },
            else => try out.append(alloc, c),
        }
    }
    try out.append(alloc, '"');
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.4 — Async fetch protocol
//
// The host drives the install loop; WASM manages a pending-fetch queue.
// Protocol:
//   1. Host calls bun_npm_install_begin(deps_json) → returns request_id for first fetch
//   2. Host fetches the URL, calls bun_npm_feed_response(req_id, data_ptr, data_len)
//   3. Host calls bun_npm_need_fetch() to check for more pending fetches
//      Returns packed (ptr<<32|len) → JSON {id,url,type:"metadata"|"tarball",name,range}
//      Returns 0 when no more fetches are pending.
//   4. Repeat until bun_npm_need_fetch() returns 0.
//   5. Call bun_npm_install_result() → JSON {resolved:[...],missing:[...],lockfile:"..."}
//
// Error codes: packError(1)=OOM, packError(2)=bad JSON, packError(3)=bad req_id.
// ──────────────────────────────────────────────────────────────────────────────

const FetchType = enum { metadata, tarball };

const PendingFetch = struct {
    id: u32,
    url: []u8,
    fetch_type: FetchType,
    name: []u8,
    range: []u8,
};

const FeedResponse = struct {
    id: u32,
    data: []u8,
};

var g_install_state: ?InstallState = null;

const InstallState = struct {
    resolved_json: std.ArrayListUnmanaged(u8),
    resolved_count: usize,
    missing_json: std.ArrayListUnmanaged(u8),
    missing_count: usize,
    fetch_queue: std.ArrayListUnmanaged(PendingFetch),
    seen: std.StringHashMap(void),
    next_id: u32,
    meta_responses: std.AutoHashMap(u32, FeedResponse),
    tarball_responses: std.AutoHashMap(u32, FeedResponse),

    fn deinit(self: *InstallState) void {
        self.resolved_json.deinit(allocator);
        self.missing_json.deinit(allocator);
        var sk = self.seen.keyIterator();
        while (sk.next()) |k| allocator.free(k.*);
        self.seen.deinit();
        for (self.fetch_queue.items) |pf| {
            allocator.free(pf.url);
            allocator.free(pf.name);
            allocator.free(pf.range);
        }
        self.fetch_queue.deinit(allocator);
        var mrit = self.meta_responses.valueIterator();
        while (mrit.next()) |v| allocator.free(v.data);
        self.meta_responses.deinit();
        var trit = self.tarball_responses.valueIterator();
        while (trit.next()) |v| allocator.free(v.data);
        self.tarball_responses.deinit();
    }
};

/// Begin an async install session.
/// Input JSON: {"deps":{"name":"range",...},"registry":"https://registry.npmjs.org"}
/// Returns the first fetch request JSON, or packError on failure.
export fn bun_npm_install_begin(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!initialized) return packError(2);
    // Clean up any previous session
    if (g_install_state) |*old| {
        old.deinit();
        g_install_state = null;
    }

    const input = input_ptr[0..input_len];
    return npmInstallBegin(input) catch |e| switch (e) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

fn npmInstallBegin(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const deps_obj: std.json.ObjectMap = switch (root.get("deps") orelse .null) {
        .object => |o| o,
        else => return error.SyntaxError,
    };
    const registry: []const u8 = switch (root.get("registry") orelse .null) {
        .string => |s| s,
        else => "https://registry.npmjs.org",
    };

    var state = InstallState{
        .resolved_json = .empty,
        .resolved_count = 0,
        .missing_json = .empty,
        .missing_count = 0,
        .seen = std.StringHashMap(void).init(allocator),
        .fetch_queue = .empty,
        .next_id = 1,
        .meta_responses = std.AutoHashMap(u32, FeedResponse).init(allocator),
        .tarball_responses = std.AutoHashMap(u32, FeedResponse).init(allocator),
    };
    errdefer state.deinit();

    // Seed fetch queue with metadata requests for all top-level deps
    {
        var it = deps_obj.iterator();
        while (it.next()) |entry| {
            const name_dup = try allocator.dupe(u8, entry.key_ptr.*);
            const rng_str: []const u8 = switch (entry.value_ptr.*) { .string => |s| s, else => "*" };
            const range_dup = try allocator.dupe(u8, rng_str);
            // URL: registry + "/" + name
            const url = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ registry, name_dup });
            try state.fetch_queue.append(allocator, .{
                .id = state.next_id,
                .url = url,
                .fetch_type = .metadata,
                .name = name_dup,
                .range = range_dup,
            });
            state.next_id += 1;
        }
    }

    g_install_state = state;
    // Return the first pending fetch (if any)
    return npmNeedFetchInternal() catch return packError(1);
}

/// Pop the next pending fetch request.
/// Returns packed JSON: {"id":N,"url":"...","type":"metadata","name":"...","range":"..."}
/// Returns 0 (packError sentinel) when queue is empty (install complete or waiting for feeds).
export fn bun_npm_need_fetch() u64 {
    return npmNeedFetchInternal() catch packError(1);
}

fn npmNeedFetchInternal() !u64 {
    const state = if (g_install_state) |*s| s else return @as(u64, 0);
    if (state.fetch_queue.items.len == 0) return @as(u64, 0);
    const pf = state.fetch_queue.items[0]; // Peek, don't pop (host may call multiple times)

    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"id\":");
    var id_buf: [16]u8 = undefined;
    try out.appendSlice(allocator, std.fmt.bufPrint(&id_buf, "{d}", .{pf.id}) catch unreachable);
    try out.appendSlice(allocator, ",\"url\":");
    try jsonEscapeTo(&out, pf.url);
    try out.appendSlice(allocator, ",\"type\":");
    try jsonEscapeTo(&out, if (pf.fetch_type == .metadata) "metadata" else "tarball");
    try out.appendSlice(allocator, ",\"name\":");
    try jsonEscapeTo(&out, pf.name);
    try out.appendSlice(allocator, ",\"range\":");
    try jsonEscapeTo(&out, pf.range);
    try out.append(allocator, '}');
    return handOff(try allocator.dupe(u8, out.items));
}

/// Feed a completed fetch response back to the install state machine.
/// `req_id` must match a previously returned fetch request id.
/// `data_ptr/data_len` is the raw response body (metadata JSON or tarball bytes).
/// Returns 0 on success (packed u64 with ptr=0, len=0).
/// On success, any newly queued fetches can be retrieved via bun_npm_need_fetch().
export fn bun_npm_feed_response(req_id: u32, data_ptr: [*]const u8, data_len: u32) u64 {
    const state = if (g_install_state) |*s| s else return packError(3);
    const data = data_ptr[0..data_len];

    // Find and remove the matching pending fetch
    var found: ?PendingFetch = null;
    for (state.fetch_queue.items, 0..) |pf, i| {
        if (pf.id == req_id) {
            found = pf;
            _ = state.fetch_queue.orderedRemove(i);
            break;
        }
    }
    const pf = found orelse return packError(3);
    defer {
        allocator.free(pf.url);
        // name and range are kept for use below, freed after processing
    }

    if (pf.fetch_type == .metadata) {
        // Parse metadata + resolve version
        const result = npmParseMetadata(data, pf.range) catch {
            allocator.free(pf.name);
            allocator.free(pf.range);
            return 0; // silently skip bad responses
        };
        const out_ptr = @as(u32, @truncate(result >> 32));
        const out_len = @as(u32, @truncate(result & 0xffffffff));

        if (out_ptr == 0) {
            // packError → no matching version → record as missing
            if (state.missing_count > 0) {
                state.missing_json.append(allocator, ',') catch {};
            }
            jsonEscapeTo2(&state.missing_json, allocator, pf.name) catch {};
            state.missing_count += 1;
            allocator.free(pf.name);
            allocator.free(pf.range);
            return 0;
        }

        const result_slice = @as([*]const u8, @ptrFromInt(out_ptr))[0..out_len];
        defer allocator.free(result_slice);

        // Add to resolved list
        if (state.resolved_count > 0) state.resolved_json.append(allocator, ',') catch {};
        state.resolved_json.appendSlice(allocator, "{\"name\":") catch {
            allocator.free(pf.name);
            allocator.free(pf.range);
            return packError(1);
        };
        jsonEscapeTo2(&state.resolved_json, allocator, pf.name) catch {};
        if (result_slice.len > 1) {
            state.resolved_json.append(allocator, ',') catch {};
            state.resolved_json.appendSlice(allocator, result_slice[1..]) catch {};
        } else {
            state.resolved_json.append(allocator, '}') catch {};
        }
        state.resolved_count += 1;

        // Queue tarball fetch
        const tarball_url_val = blk: {
            var sub = std.json.parseFromSlice(std.json.Value, allocator, result_slice, .{}) catch break :blk null;
            defer sub.deinit();
            if (sub.value == .object) {
                if (sub.value.object.get("tarball")) |tv| {
                    if (tv == .string) break :blk allocator.dupe(u8, tv.string) catch null;
                }
                // Also enqueue transitive deps' metadata
                if (sub.value.object.get("dependencies")) |dv| {
                    if (dv == .object) {
                        var dep_it = dv.object.iterator();
                        while (dep_it.next()) |dep_entry| {
                            const dname = dep_entry.key_ptr.*;
                            if (!state.seen.contains(dname)) {
                                const registry = "https://registry.npmjs.org";
                                const url2 = std.fmt.allocPrint(allocator, "{s}/{s}", .{ registry, dname }) catch continue;
                                const rng2: []const u8 = switch (dep_entry.value_ptr.*) { .string => |s| s, else => "*" };
                                const nm2 = allocator.dupe(u8, dname) catch continue;
                                const rng2_dup = allocator.dupe(u8, rng2) catch { allocator.free(nm2); continue; };
                                state.fetch_queue.append(allocator, .{
                                    .id = state.next_id,
                                    .url = url2,
                                    .fetch_type = .metadata,
                                    .name = nm2,
                                    .range = rng2_dup,
                                }) catch { allocator.free(url2); allocator.free(nm2); allocator.free(rng2_dup); };
                                state.next_id += 1;
                            }
                        }
                    }
                }
            }
            break :blk null;
        };
        if (tarball_url_val) |turl| {
            const name_dup2 = allocator.dupe(u8, pf.name) catch { allocator.free(turl); allocator.free(pf.name); allocator.free(pf.range); return 0; };
            const rng_dup2 = allocator.dupe(u8, "") catch { allocator.free(turl); allocator.free(name_dup2); allocator.free(pf.name); allocator.free(pf.range); return 0; };
            state.fetch_queue.append(allocator, .{
                .id = state.next_id,
                .url = turl,
                .fetch_type = .tarball,
                .name = name_dup2,
                .range = rng_dup2,
            }) catch { allocator.free(turl); allocator.free(name_dup2); allocator.free(rng_dup2); };
            state.next_id += 1;
        }
        allocator.free(pf.name);
        allocator.free(pf.range);
    } else {
        // Tarball: extract into VFS using bun_tgz_extract logic
        const prefix = std.fmt.allocPrint(allocator, "/node_modules/{s}", .{pf.name}) catch {
            allocator.free(pf.name);
            allocator.free(pf.range);
            return packError(1);
        };
        defer allocator.free(prefix);

        // Build packed input for tgzExtract inline logic
        const prefix_len: u32 = @intCast(prefix.len);
        var packed_input: std.ArrayList(u8) = .empty;
        defer packed_input.deinit(allocator);
        var plen_buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &plen_buf, prefix_len, .little);
        packed_input.appendSlice(allocator, &plen_buf) catch { allocator.free(pf.name); allocator.free(pf.range); return packError(1); };
        packed_input.appendSlice(allocator, prefix) catch { allocator.free(pf.name); allocator.free(pf.range); return packError(1); };
        packed_input.appendSlice(allocator, data) catch { allocator.free(pf.name); allocator.free(pf.range); return packError(1); };

        // Decompress + extract (reuse bun_tgz_extract logic)
        _ = bun_tgz_extract(packed_input.items.ptr, @intCast(packed_input.items.len));
        allocator.free(pf.name);
        allocator.free(pf.range);
    }

    return 0;
}

/// Mark a package name as seen (already installed from a previous session / cache).
/// Call before bun_npm_install_begin to skip re-fetching.
export fn bun_npm_install_mark_seen(name_ptr: [*]const u8, name_len: u32) void {
    const state = if (g_install_state) |*s| s else return;
    const name = allocator.dupe(u8, name_ptr[0..name_len]) catch return;
    state.seen.put(name, {}) catch { allocator.free(name); };
}

/// Get the current install result.
/// Call after all fetch responses have been fed (bun_npm_need_fetch returns 0).
/// Returns JSON: {"resolved":[...],"missing":[...]}
export fn bun_npm_install_result() u64 {
    const state = if (g_install_state) |*s| s else return packError(2);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    out.appendSlice(allocator, "{\"resolved\":[") catch return packError(1);
    out.appendSlice(allocator, state.resolved_json.items) catch return packError(1);
    out.appendSlice(allocator, "],\"missing\":[") catch return packError(1);
    out.appendSlice(allocator, state.missing_json.items) catch return packError(1);
    out.appendSlice(allocator, "]}") catch return packError(1);
    return handOff(allocator.dupe(u8, out.items) catch return packError(1));
}

/// Tear down the install session and free all associated memory.
export fn bun_npm_install_end() void {
    if (g_install_state) |*s| {
        s.deinit();
        g_install_state = null;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.7 T5.7.2 — bun_sourcemap_lookup
// Map (generated line, col) back to (source, original line, col).
//
// Input JSON:
//   {
//     "map": <sourcemap JSON string — standard v3 format>,
//     "line": <0-based generated line>,
//     "col": <0-based generated column>
//   }
//
// Returns packed (ptr << 32 | len) → JSON:
//   {"source":"<file>","line":<orig-line>,"col":<orig-col>,"name":"<sym>"}
//   or {"source":null} when no mapping found.
//
// Error codes: 1=OOM, 2=bad input.
// ──────────────────────────────────────────────────────────────────────────────

export fn bun_sourcemap_lookup(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!initialized) return packError(2);
    const input = input_ptr[0..input_len];
    return sourcemapLookup(input) catch |e| switch (e) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

/// VLQ decode: read one VLQ-encoded value from `data[off..]`, advance `off`, return value.
/// T5.10.5: Thin wrapper around the real src/sourcemap/VLQ.zig implementation.
/// Returns null when `off` is out-of-bounds or the character is not valid base64.
fn vlqDecode(data: []const u8, off: *usize) ?i32 {
    if (off.* >= data.len) return null;
    // Guard against separator characters that are not valid base64 VLQ.
    // The outer loop in sourcemapLookup already strips ';' and ',' before
    // calling us, but an extra check keeps behaviour identical to the old code.
    const first = data[off.*];
    const valid = switch (first) {
        'A'...'Z', 'a'...'z', '0'...'9', '+', '/' => true,
        else => false,
    };
    if (!valid) return null;
    const res = VLQ.decode(data, off.*);
    if (res.start == off.*) return null; // no bytes consumed → treat as error
    off.* = res.start;
    return res.value;
}

fn sourcemapLookup(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const target_line: i64 = if (root.get("line")) |lv| switch (lv) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => 0,
    } else 0;
    const target_col: i64 = if (root.get("col")) |cv| switch (cv) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => 0,
    } else 0;

    const map_val = root.get("map") orelse return error.SyntaxError;
    const map_json: []const u8 = switch (map_val) {
        .string => |s| s,
        else => return error.SyntaxError,
    };

    // Parse the sourcemap JSON
    const smap = try std.json.parseFromSlice(std.json.Value, allocator, map_json, .{});
    defer smap.deinit();
    const smap_root = switch (smap.value) { .object => |o| o, else => return error.SyntaxError };

    // Extract sources array
    const sources_arr: []std.json.Value = switch (smap_root.get("sources") orelse .null) {
        .array => |a| a.items,
        else => &.{},
    };
    const names_arr: []std.json.Value = switch (smap_root.get("names") orelse .null) {
        .array => |a| a.items,
        else => &.{},
    };
    const mappings_str: []const u8 = switch (smap_root.get("mappings") orelse .null) {
        .string => |s| s,
        else => return error.SyntaxError,
    };

    // Walk the VLQ mappings to find (target_line, target_col)
    var gen_line: i64 = 0;
    var src_idx: i32 = 0;
    var orig_line: i32 = 0;
    var orig_col: i32 = 0;
    var name_idx: i32 = 0;

    // Best match tracking
    var best_src_idx: i32 = -1;
    var best_orig_line: i32 = 0;
    var best_orig_col: i32 = 0;
    var best_name_idx: i32 = -1;
    var best_gen_col: i64 = -1;

    var off: usize = 0;
    var seg_col: i32 = 0; // resets per line

    while (off < mappings_str.len) {
        const c = mappings_str[off];
        if (c == ';') {
            // New generated line
            gen_line += 1;
            seg_col = 0;
            off += 1;
            continue;
        }
        if (c == ',') {
            off += 1;
            continue;
        }
        // Decode segment: 1, 4, or 5 VLQ fields
        const gen_col_delta = vlqDecode(mappings_str, &off) orelse { off += 1; continue; };
        seg_col += gen_col_delta;
        const cur_gen_col: i64 = seg_col;

        // Try to read 3 more fields (source, origLine, origCol)
        const saved_off = off;
        const si_delta = vlqDecode(mappings_str, &off);
        const ol_delta = if (si_delta != null) vlqDecode(mappings_str, &off) else null;
        const oc_delta = if (ol_delta != null) vlqDecode(mappings_str, &off) else null;
        const ni_delta = if (oc_delta != null) vlqDecode(mappings_str, &off) else null;

        if (si_delta != null and ol_delta != null and oc_delta != null) {
            src_idx += si_delta.?;
            orig_line += ol_delta.?;
            orig_col += oc_delta.?;
            if (ni_delta != null) name_idx += ni_delta.?;
        } else {
            off = saved_off;
        }

        // Check if this segment is our best match for (target_line, target_col)
        if (gen_line == target_line and cur_gen_col <= target_col and cur_gen_col > best_gen_col) {
            if (si_delta != null) {
                best_gen_col = cur_gen_col;
                best_src_idx = src_idx;
                best_orig_line = orig_line;
                best_orig_col = orig_col;
                best_name_idx = if (ni_delta != null) name_idx else -1;
            }
        }
    }

    // Build result JSON
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);

    if (best_src_idx < 0 or best_src_idx >= @as(i32, @intCast(sources_arr.len))) {
        try out.appendSlice(allocator, "{\"source\":null}");
    } else {
        const src_str: []const u8 = switch (sources_arr[@as(usize, @intCast(best_src_idx))]) {
            .string => |s| s,
            else => "",
        };
        try out.appendSlice(allocator, "{\"source\":");
        try jsonEscapeTo(&out, src_str);
        var line_buf: [16]u8 = undefined;
        var col_buf: [16]u8 = undefined;
        try out.appendSlice(allocator, ",\"line\":");
        try out.appendSlice(allocator, std.fmt.bufPrint(&line_buf, "{d}", .{best_orig_line}) catch unreachable);
        try out.appendSlice(allocator, ",\"col\":");
        try out.appendSlice(allocator, std.fmt.bufPrint(&col_buf, "{d}", .{best_orig_col}) catch unreachable);
        if (best_name_idx >= 0 and best_name_idx < @as(i32, @intCast(names_arr.len))) {
            const name_str: []const u8 = switch (names_arr[@as(usize, @intCast(best_name_idx))]) {
                .string => |s| s,
                else => "",
            };
            try out.appendSlice(allocator, ",\"name\":");
            try jsonEscapeTo(&out, name_str);
        }
        try out.append(allocator, '}');
    }

    return handOff(try allocator.dupe(u8, out.items));
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5.7 T5.7.3 — bun_html_rewrite
// Minimal HTML element text/attribute rewriter.
//
// Input JSON:
//   {
//     "html": "<the html string>",
//     "rules": [
//       { "selector": "script[src]", "attr": "src", "replace": "https://cdn.example.com/a.js" },
//       { "selector": "title", "text": "My App" },
//       { "selector": "meta[charset]", "remove": true }
//     ]
//   }
//
// Supported selectors (subset): "tag", "tag[attr]", "tag[attr=val]"
// Supported operations: set/replace `attr`, set inner `text`, `remove` element.
//
// Returns packed (ptr << 32 | len) → rewritten HTML string.
// Error codes: 1=OOM, 2=bad input.
// ──────────────────────────────────────────────────────────────────────────────

export fn bun_html_rewrite(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!initialized) return packError(2);
    const input = input_ptr[0..input_len];
    return htmlRewrite(input) catch |e| switch (e) {
        error.OutOfMemory => packError(1),
        else => packError(2),
    };
}

const HtmlRule = struct {
    tag: []const u8,
    attr_filter: ?[]const u8, // attr name in selector (e.g. "src" from "script[src]")
    attr_val_filter: ?[]const u8, // expected attr value in selector (null = any)
    /// Operation: set_attr | set_text | remove
    op: enum { set_attr, set_text, remove },
    attr_target: []const u8, // attr name to set (for set_attr)
    value: []const u8, // new value (for set_attr / set_text)
};

/// Parse a simple CSS selector: "tag", "tag[attr]", "tag[attr=val]"
fn parseSelector(sel: []const u8, rule: *HtmlRule) void {
    if (std.mem.indexOfScalar(u8, sel, '[')) |bracket| {
        rule.tag = sel[0..bracket];
        const inner = if (sel[sel.len - 1] == ']') sel[bracket + 1 .. sel.len - 1] else sel[bracket + 1 ..];
        if (std.mem.indexOfScalar(u8, inner, '=')) |eq| {
            rule.attr_filter = inner[0..eq];
            var val = inner[eq + 1 ..];
            // Strip quotes
            if (val.len >= 2 and (val[0] == '"' or val[0] == '\'') and val[val.len - 1] == val[0]) {
                val = val[1 .. val.len - 1];
            }
            rule.attr_val_filter = val;
        } else {
            rule.attr_filter = inner;
            rule.attr_val_filter = null;
        }
    } else {
        rule.tag = sel;
        rule.attr_filter = null;
        rule.attr_val_filter = null;
    }
}

fn htmlRewrite(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const html: []const u8 = switch (root.get("html") orelse .null) {
        .string => |s| s,
        else => return error.SyntaxError,
    };
    const rules_arr: []std.json.Value = switch (root.get("rules") orelse .null) {
        .array => |a| a.items,
        else => &.{},
    };

    // Parse rules
    var rules = try allocator.alloc(HtmlRule, rules_arr.len);
    defer allocator.free(rules);
    var rule_count: usize = 0;
    for (rules_arr) |rv| {
        if (rv != .object) continue;
        const ro = rv.object;
        const sel: []const u8 = switch (ro.get("selector") orelse .null) { .string => |s| s, else => continue };
        var rule: HtmlRule = .{
            .tag = "",
            .attr_filter = null,
            .attr_val_filter = null,
            .op = .remove,
            .attr_target = "",
            .value = "",
        };
        parseSelector(sel, &rule);
        if (ro.get("remove")) |rv2| {
            if (rv2 == .bool and rv2.bool) {
                rule.op = .remove;
                rules[rule_count] = rule;
                rule_count += 1;
                continue;
            }
        }
        if (ro.get("attr")) |av| {
            if (av == .string) {
                rule.op = .set_attr;
                rule.attr_target = av.string;
                rule.value = switch (ro.get("replace") orelse .null) { .string => |s| s, else => "" };
                rules[rule_count] = rule;
                rule_count += 1;
                continue;
            }
        }
        if (ro.get("text")) |tv| {
            if (tv == .string) {
                rule.op = .set_text;
                rule.value = tv.string;
                rules[rule_count] = rule;
                rule_count += 1;
            }
        }
    }
    rules = rules[0..rule_count];

    // Walk HTML string character by character; process tags.
    // This is a simple, non-validating HTML rewriter — good enough for common cases.
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);

    var i: usize = 0;
    while (i < html.len) {
        if (html[i] != '<') {
            try out.append(allocator, html[i]);
            i += 1;
            continue;
        }
        // Start of a tag. Find the end.
        const tag_start = i;
        i += 1; // skip '<'
        const is_close = i < html.len and html[i] == '/';
        if (is_close) i += 1;

        // Read tag name
        const tag_name_start = i;
        while (i < html.len and html[i] != ' ' and html[i] != '>' and html[i] != '/') i += 1;
        const tag_name = html[tag_name_start..i];

        // Find the end of the tag ('>')
        while (i < html.len and html[i] != '>') i += 1;
        const tag_end = if (i < html.len) i + 1 else html.len;
        const tag_str = html[tag_start..tag_end]; // full "<tag ...>" string
        if (i < html.len) i += 1;

        if (tag_name.len == 0 or is_close) {
            try out.appendSlice(allocator, tag_str);
            continue;
        }

        // Find a matching rule
        var matched_rule: ?*const HtmlRule = null;
        for (rules) |*rule| {
            if (!std.mem.eql(u8, rule.tag, tag_name)) continue;
            if (rule.attr_filter) |af| {
                // Check that this attribute exists in the tag
                if (std.mem.indexOf(u8, tag_str, af) == null) continue;
                if (rule.attr_val_filter) |avf| {
                    if (std.mem.indexOf(u8, tag_str, avf) == null) continue;
                }
            }
            matched_rule = rule;
            break;
        }

        const rule = matched_rule orelse {
            try out.appendSlice(allocator, tag_str);
            continue;
        };

        switch (rule.op) {
            .remove => {
                // Skip the element entirely: skip open tag, inner content, close tag.
                const close_prefix = try std.fmt.allocPrint(allocator, "</{s}>", .{tag_name});
                defer allocator.free(close_prefix);
                if (std.mem.indexOf(u8, html[i..], close_prefix)) |close_rel| {
                    i += close_rel + close_prefix.len;
                }
                // else: no close tag — element already ended (self-closing or missing)
            },
            .set_attr => {
                // Rewrite the tag: replace the target attribute value.
                const needle = try std.fmt.allocPrint(allocator, "{s}=\"", .{rule.attr_target});
                defer allocator.free(needle);
                if (std.mem.indexOf(u8, tag_str, needle)) |attr_pos| {
                    const val_start = attr_pos + needle.len;
                    const val_end = std.mem.indexOfScalarPos(u8, tag_str, val_start, '"') orelse tag_str.len;
                    try out.appendSlice(allocator, tag_str[0..val_start]);
                    try out.appendSlice(allocator, rule.value);
                    try out.appendSlice(allocator, tag_str[val_end..]);
                } else {
                    try out.appendSlice(allocator, tag_str);
                }
            },
            .set_text => {
                // Output the open tag, replace inner text, then write close tag.
                try out.appendSlice(allocator, tag_str);
                const close_prefix = try std.fmt.allocPrint(allocator, "</{s}>", .{tag_name});
                defer allocator.free(close_prefix);
                if (std.mem.indexOf(u8, html[i..], close_prefix)) |close_rel| {
                    // Skip original inner content
                    try out.appendSlice(allocator, rule.value);
                    try out.appendSlice(allocator, close_prefix);
                    i += close_rel + close_prefix.len;
                }
            },
        }
    }

    return handOff(try allocator.dupe(u8, out.items));
}

// ──────────────────────────────────────────────────────────────────────────────
// T5.10.3 — bun_brace_expand
// ASCII brace expansion: "{a,b,c}" → ["a","b","c"], "foo{a,b}bar" → ["fooabar","foobbar"]
//
// This is the pure-Zig ASCII path inspired by src/shell/braces.zig.
// The shell.zig dependency chain (JSC-coupled) is avoided by self-containing the
// minimal ASCII lexer/expander needed for Phase 5.13 shell preparation.
//
// ABI: (ptr, len) → packed u64 (ptr << 32 | len) → JSON array of strings
// Input: UTF-8 brace pattern string
// Error codes: 1=OOM
// ──────────────────────────────────────────────────────────────────────────────

export fn bun_brace_expand(ptr: [*]const u8, len: u32) u64 {
    const src = ptr[0..len];
    var items: std.ArrayListUnmanaged([]u8) = .{};
    defer {
        for (items.items) |s| allocator.free(s);
        items.deinit(allocator);
    }
    braceExpandStr(allocator, src, &items) catch return packError(1);

    var out: std.ArrayListUnmanaged(u8) = .{};
    defer out.deinit(allocator);
    out.append(allocator, '[') catch return packError(1);
    for (items.items, 0..) |s, i| {
        if (i > 0) out.append(allocator, ',') catch return packError(1);
        jsonEscapeTo(&out, s) catch return packError(1);
    }
    out.append(allocator, ']') catch return packError(1);
    return handOff(out.toOwnedSlice(allocator) catch return packError(1));
}

/// Expand a brace pattern into the `out` list (ASCII path only).
/// Handles nested braces and multiple brace groups via recursion.
fn braceExpandStr(alloc: std.mem.Allocator, src: []const u8, out: *std.ArrayListUnmanaged([]u8)) std.mem.Allocator.Error!void {
    // Find first top-level '{'
    const brace_open = findBraceOpen(src) orelse {
        try out.append(alloc, try alloc.dupe(u8, src));
        return;
    };
    const brace_close = findBraceClose(src, brace_open) orelse {
        // Unmatched '{' — treat as literal
        try out.append(alloc, try alloc.dupe(u8, src));
        return;
    };

    const prefix = src[0..brace_open];
    const inside = src[brace_open + 1 .. brace_close];
    const suffix = src[brace_close + 1 ..];

    // Split inside by top-level commas
    var alts: std.ArrayListUnmanaged([]const u8) = .{};
    defer alts.deinit(alloc);
    try splitByTopCommas(alloc, inside, &alts);

    if (alts.items.len < 2) {
        // Not a valid brace group (empty or no comma) — treat as literal
        try out.append(alloc, try alloc.dupe(u8, src));
        return;
    }

    // For each alternative, form prefix+alt+suffix and recursively expand
    for (alts.items) |alt| {
        const combined = try std.fmt.allocPrint(alloc, "{s}{s}{s}", .{ prefix, alt, suffix });
        defer alloc.free(combined);
        try braceExpandStr(alloc, combined, out);
    }
}

fn findBraceOpen(src: []const u8) ?usize {
    for (src, 0..) |c, i| {
        if (c == '{') return i;
    }
    return null;
}

fn findBraceClose(src: []const u8, open: usize) ?usize {
    var depth: usize = 0;
    var i: usize = open;
    while (i < src.len) : (i += 1) {
        switch (src[i]) {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if (depth == 0) return i;
            },
            '\\' => i += 1, // skip escaped char
            else => {},
        }
    }
    return null;
}

fn splitByTopCommas(alloc: std.mem.Allocator, src: []const u8, out: *std.ArrayListUnmanaged([]const u8)) !void {
    var depth: usize = 0;
    var start: usize = 0;
    var i: usize = 0;
    while (i < src.len) : (i += 1) {
        switch (src[i]) {
            '{' => depth += 1,
            '}' => if (depth > 0) {
                depth -= 1;
            },
            ',' => if (depth == 0) {
                try out.append(alloc, src[start..i]);
                start = i + 1;
            },
            '\\' => i += 1,
            else => {},
        }
    }
    try out.append(alloc, src[start..]);
}

// ──────────────────────────────────────────────────────────────────────────────
// T5.13.1 — bun_shell_parse
// Tokenise a POSIX-like shell command string and return a JSON AST.
//
// ABI: (ptr, len) → packed u64 (ptr<<32|len) → JSON AST string
//
// JSON structure (all nodes have a "t" tag field):
//   Top level is always { "t":"seq", "stmts":[...] }
//   Statements in stmts are either:
//     { "t":"pipe", "cmds":[cmd, ...] }    — two or more commands joined by |
//     { "t":"cmd",  "argv":[...], "redirs":[...], "bg":false }  — single command
//   Redirect: { "t":">"|">>"|"<", "fd":N, "target":"..." }
//
// Quoting: single-quotes suppress all expansion; double-quotes allow $/${}/$().
// $ expansions ($VAR, ${VAR}, $(cmd), `cmd`) are kept verbatim in argv for the
// TS runtime to expand at execution time.
// Background: '&' at end of a statement sets "bg":true on its last cmd.
// Comments: '#' to end of line.
//
// Error codes: 1=OOM, 2=parse error
// ──────────────────────────────────────────────────────────────────────────────

/// Shell token types
const ShTokTy = enum { word, pipe, semi, amp, redir_out, redir_append, redir_in, newline, eof };
const ShTok = struct { ty: ShTokTy, val: []const u8 = "" };

/// Tokenise `src` into `out`.  All word .val slices are allocated with `arena`.
fn shellLex(arena: std.mem.Allocator, src: []const u8, out: *std.ArrayListUnmanaged(ShTok)) !void {
    var i: usize = 0;
    while (i < src.len) {
        const c = src[i];
        switch (c) {
            ' ', '\t', '\r' => i += 1,
            '\n' => { try out.append(arena, .{ .ty = .newline }); i += 1; },
            '#' => { while (i < src.len and src[i] != '\n') i += 1; },
            '|' => { try out.append(arena, .{ .ty = .pipe }); i += 1; },
            ';' => { try out.append(arena, .{ .ty = .semi }); i += 1; },
            '&' => { try out.append(arena, .{ .ty = .amp }); i += 1; },
            '>' => {
                if (i + 1 < src.len and src[i + 1] == '>') {
                    try out.append(arena, .{ .ty = .redir_append }); i += 2;
                } else {
                    try out.append(arena, .{ .ty = .redir_out }); i += 1;
                }
            },
            '<' => { try out.append(arena, .{ .ty = .redir_in }); i += 1; },
            else => {
                var word: std.ArrayListUnmanaged(u8) = .{};
                // Collect word characters (stops at unquoted meta-chars)
                word_loop: while (i < src.len) {
                    const ch = src[i];
                    switch (ch) {
                        ' ', '\t', '\r', '\n' => break :word_loop,
                        '|', ';', '&', '>', '<', '#' => break :word_loop,
                        '\\' => {
                            i += 1;
                            if (i < src.len) { try word.append(arena, src[i]); i += 1; }
                        },
                        '\'' => {
                            i += 1;
                            while (i < src.len and src[i] != '\'') {
                                try word.append(arena, src[i]); i += 1;
                            }
                            if (i < src.len) i += 1; // skip closing '
                        },
                        '"' => {
                            i += 1;
                            while (i < src.len and src[i] != '"') {
                                if (src[i] == '\\' and i + 1 < src.len) {
                                    // Keep escape sequences verbatim inside double-quotes
                                    try word.append(arena, '\\');
                                    try word.append(arena, src[i + 1]);
                                    i += 2;
                                } else {
                                    try word.append(arena, src[i]); i += 1;
                                }
                            }
                            if (i < src.len) i += 1; // skip closing "
                        },
                        '$' => {
                            if (i + 1 < src.len and src[i + 1] == '(') {
                                // $(cmd) — find matching )
                                const start = i; i += 2;
                                var depth: usize = 1;
                                while (i < src.len and depth > 0) : (i += 1) {
                                    switch (src[i]) {
                                        '(' => depth += 1,
                                        ')' => depth -= 1,
                                        else => {},
                                    }
                                }
                                try word.appendSlice(arena, src[start..i]);
                            } else if (i + 1 < src.len and src[i + 1] == '{') {
                                // ${VAR}
                                const start = i; i += 2;
                                while (i < src.len and src[i] != '}') i += 1;
                                if (i < src.len) i += 1;
                                try word.appendSlice(arena, src[start..i]);
                            } else {
                                // $VAR or bare $
                                const start = i; i += 1;
                                while (i < src.len and (std.ascii.isAlphanumeric(src[i]) or src[i] == '_')) i += 1;
                                try word.appendSlice(arena, src[start..i]);
                            }
                        },
                        '`' => {
                            // Backtick subst — keep verbatim
                            const start = i; i += 1;
                            while (i < src.len and src[i] != '`') {
                                if (src[i] == '\\') i += 1;
                                if (i < src.len) i += 1;
                            }
                            if (i < src.len) i += 1;
                            try word.appendSlice(arena, src[start..i]);
                        },
                        else => { try word.append(arena, ch); i += 1; },
                    }
                }
                try out.append(arena, .{ .ty = .word, .val = try word.toOwnedSlice(arena) });
            },
        }
    }
    try out.append(arena, .{ .ty = .eof });
}

/// Write the JSON AST for a parsed shell command into `out`.
/// Tokens must be the result of shellLex().
fn shellSerialize(arena: std.mem.Allocator, tokens: []const ShTok, out: *std.ArrayListUnmanaged(u8)) !void {
    var pos: usize = 0;

    // Helpers
    const skipSemis = struct {
        fn run(tk: []const ShTok, p: *usize) void {
            while (p.* < tk.len and (tk[p.*].ty == .semi or tk[p.*].ty == .newline)) p.* += 1;
        }
    }.run;

    const peekTy = struct {
        fn run(tk: []const ShTok, p: usize) ShTokTy {
            if (p >= tk.len) return .eof;
            return tk[p].ty;
        }
    }.run;

    // Collect all statements as JSON byte slices
    var stmts: std.ArrayListUnmanaged([]const u8) = .{};
    defer {
        for (stmts.items) |s| arena.free(s);
        stmts.deinit(arena);
    }

    skipSemis(tokens, &pos);

    while (peekTy(tokens, pos) != .eof) {
        // Parse one statement (pipeline optionally followed by &)
        var stmt_buf: std.ArrayListUnmanaged(u8) = .{};
        var cmds: std.ArrayListUnmanaged([]const u8) = .{};
        defer {
            for (cmds.items) |c| arena.free(c);
            cmds.deinit(arena);
        }
        var bg = false;

        // Parse commands separated by |
        while (true) {
            var cmd_buf: std.ArrayListUnmanaged(u8) = .{};
            var argv: std.ArrayListUnmanaged([]const u8) = .{};
            defer {
                for (argv.items) |a| arena.free(a);
                argv.deinit(arena);
            }
            var redirs: std.ArrayListUnmanaged([]const u8) = .{};
            defer {
                for (redirs.items) |r| arena.free(r);
                redirs.deinit(arena);
            }

            // Collect words and redirects until |, ;, \n, &, eof
            while (peekTy(tokens, pos) == .word or
                peekTy(tokens, pos) == .redir_out or
                peekTy(tokens, pos) == .redir_append or
                peekTy(tokens, pos) == .redir_in)
            {
                const tok = tokens[pos]; pos += 1;
                switch (tok.ty) {
                    .word => try argv.append(arena, try arena.dupe(u8, tok.val)),
                    .redir_out, .redir_append, .redir_in => {
                        const op_str: []const u8 = switch (tok.ty) {
                            .redir_out => ">",
                            .redir_append => ">>",
                            .redir_in => "<",
                            else => unreachable,
                        };
                        // Check for fd prefix on this op (already consumed as part of prev word)
                        // and get the target word
                        if (peekTy(tokens, pos) != .word) break;
                        const target = tokens[pos].val; pos += 1;

                        // Generate {"t":">>","fd":1,"target":"..."}
                        var redir_buf: std.ArrayListUnmanaged(u8) = .{};
                        defer redir_buf.deinit(arena);
                        try redir_buf.appendSlice(arena, "{\"t\":");
                        try jsonEscapeTo2(&redir_buf, arena, op_str);
                        try redir_buf.appendSlice(arena, ",\"fd\":1,\"target\":");
                        try jsonEscapeTo2(&redir_buf, arena, target);
                        try redir_buf.append(arena, '}');
                        try redirs.append(arena, try redir_buf.toOwnedSlice(arena));
                    },
                    else => unreachable,
                }
            }

            // Serialize command: {"t":"cmd","argv":[...],"redirs":[...]}
            try cmd_buf.appendSlice(arena, "{\"t\":\"cmd\",\"argv\":[");
            for (argv.items, 0..) |a, idx| {
                if (idx > 0) try cmd_buf.append(arena, ',');
                try jsonEscapeTo2(&cmd_buf, arena, a);
            }
            try cmd_buf.appendSlice(arena, "],\"redirs\":[");
            for (redirs.items, 0..) |r, idx| {
                if (idx > 0) try cmd_buf.append(arena, ',');
                try cmd_buf.appendSlice(arena, r);
            }
            try cmd_buf.append(arena, ']');
            // bg is set after the pipeline, handle below
            try cmd_buf.append(arena, '}');
            try cmds.append(arena, try cmd_buf.toOwnedSlice(arena));

            if (peekTy(tokens, pos) != .pipe) break;
            pos += 1; // consume |
        }

        // Check for & (background)
        if (peekTy(tokens, pos) == .amp) {
            bg = true;
            pos += 1;
        }

        // Apply bg to last cmd by inserting ,"bg":true before }
        if (bg and cmds.items.len > 0) {
            const last_idx = cmds.items.len - 1;
            const old = cmds.items[last_idx];
            // old ends with '}', replace with ,"bg":true}
            const new_cmd = try std.fmt.allocPrint(arena, "{s},\"bg\":true}}", .{old[0 .. old.len - 1]});
            arena.free(old);
            cmds.items[last_idx] = new_cmd;
        }

        // Serialize: single command → use directly; pipeline → wrap
        if (cmds.items.len == 1) {
            try stmt_buf.appendSlice(arena, cmds.items[0]);
        } else {
            try stmt_buf.appendSlice(arena, "{\"t\":\"pipe\",\"cmds\":[");
            for (cmds.items, 0..) |cmd_json, idx| {
                if (idx > 0) try stmt_buf.append(arena, ',');
                try stmt_buf.appendSlice(arena, cmd_json);
            }
            try stmt_buf.appendSlice(arena, "]}");
        }

        try stmts.append(arena, try stmt_buf.toOwnedSlice(arena));

        skipSemis(tokens, &pos);
    }

    // Wrap in top-level { "t":"seq", "stmts":[...] }
    try out.appendSlice(arena, "{\"t\":\"seq\",\"stmts\":[");
    for (stmts.items, 0..) |s, idx| {
        if (idx > 0) try out.append(arena, ',');
        try out.appendSlice(arena, s);
    }
    try out.appendSlice(arena, "]}");
}

export fn bun_shell_parse(ptr: [*]const u8, len: u32) u64 {
    const src = ptr[0..len];

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var tokens: std.ArrayListUnmanaged(ShTok) = .{};
    shellLex(a, src, &tokens) catch return packError(1);

    var out: std.ArrayListUnmanaged(u8) = .{};
    shellSerialize(a, tokens.items, &out) catch return packError(1);

    // Copy out of arena into allocator (handOff requires non-arena memory)
    const result = allocator.dupe(u8, out.items) catch return packError(1);
    return handOff(result);
}
