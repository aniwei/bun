//! Bun Browser Runtime WASM exports.
//!
//! 仅在 `-Dwasm_profile=browser_runtime` 的 WASM 构建中启用。
//! 为浏览器侧 JSI Host（见 `packages/bun-browser/src/jsi-host.ts`）
//! 与 Worker 入口（`kernel-worker.ts`）暴露最小运行时 ABI：
//!
//!   - bun_browser_init()             —— 初始化 allocator / VFS / EventLoop
//!   - bun_browser_run(ptr, len) i32  —— 在 VFS 中以 utf-8 路径运行入口文件（Phase 1 中为 transpile 并 eval）
//!   - bun_vfs_load_snapshot(ptr,len) —— 加载 VFS snapshot（与 sys_wasm/vfs.zig exportSnapshot 对齐）
//!   - jsi_host_invoke(id,this,argv,argc) —— JSI host function dispatch 入口
//!   - jsi_host_arg_scratch(argc)    —— 为 host function 调用分配 argv scratch buffer
//!
//! 注意：所有字符串/buffer 指针均为 WASM 线性内存中的 u32 offset；
//! 与 `src/main_wasm.zig` 的 `bun_malloc` / `bun_free` 搭配。

const std = @import("std");
const bun = @import("bun");
const Environment = bun.Environment;

comptime {
    if (!Environment.wasm_browser_runtime) {
        @compileError("bun_browser.zig is only for -Dwasm_profile=browser_runtime builds");
    }
}

const jsi = bun.jsi;
const sys_wasm = bun.sys_wasm;

const default_allocator = bun.default_allocator;

// ──────────────────────────────────────────────────────────
// 全局运行时状态
// ──────────────────────────────────────────────────────────

var vfs_g: sys_wasm.vfs.VFS = undefined;
var runtime_g: jsi.Runtime = undefined;
var loader_g: ModuleLoader = undefined;
var host_arg_scratch: std.array_list.Managed(u32) = undefined;
var initialized: bool = false;
/// 最近一次 process.exit() 的退出码；由 processExitFn 写入，由导出函数读取。
var g_exit_code: i32 = 0;
/// 指示执行被 process.exit() 主动中止。
var g_explicit_exit: bool = false;

/// Host 导入：`env.jsi_now_ms` —— 毫秒时钟。VFS 与 Loop 均用它。
extern "env" fn jsi_now_ms() u64;

fn clockMs() u64 {
    return jsi_now_ms();
}

// ──────────────────────────────────────────────────────────
// 路径工具
// ──────────────────────────────────────────────────────────

/// 规范化 POSIX 路径，消除 `.` 和 `..` 片段。
/// 调用方负责 free 返回的切片。
fn normPath(alloc: std.mem.Allocator, path: []const u8) std.mem.Allocator.Error![]u8 {
    var parts = std.ArrayList([]const u8).init(alloc);
    defer parts.deinit();

    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |seg| {
        if (seg.len == 0 or std.mem.eql(u8, seg, ".")) continue;
        if (std.mem.eql(u8, seg, "..")) {
            if (parts.items.len > 0) parts.shrinkRetainingCapacity(parts.items.len - 1);
        } else {
            try parts.append(seg);
        }
    }

    var buf = std.ArrayList(u8).init(alloc);
    for (parts.items) |seg| {
        try buf.append('/');
        try buf.appendSlice(seg);
    }
    if (buf.items.len == 0) try buf.append('/');
    return buf.toOwnedSlice();
}

/// 将相对路径 `rel` 与目录 `base_dir` 合并，返回 owned 规范路径。
fn joinPath(alloc: std.mem.Allocator, base_dir: []const u8, rel: []const u8) ![]u8 {
    if (rel.len > 0 and rel[0] == '/') return alloc.dupe(u8, rel);
    const combined = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ base_dir, rel });
    defer alloc.free(combined);
    return normPath(alloc, combined);
}

/// 提取路径的目录部分（最后一个 `/` 之前的切片，无 alloc）。
fn pathDirname(path: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, path, '/')) |idx| {
        return if (idx == 0) "/" else path[0..idx];
    }
    return "/";
}

// ──────────────────────────────────────────────────────────
// CJS 模块加载器
// ──────────────────────────────────────────────────────────

/// CommonJS 模块加载器，基于 VFS，按需 eval。
const ModuleLoader = struct {
    alloc: std.mem.Allocator,
    vfs: *sys_wasm.vfs.VFS,
    rt: *jsi.Runtime,
    /// 已解析模块缓存：绝对路径 → module.exports handle（已 retain）。
    cache: std.StringHashMap(u32),
    /// 当前正在加载的模块所在目录（用于相对路径 require 解析）。
    current_dir: []const u8,

    fn init(alloc: std.mem.Allocator, v: *sys_wasm.vfs.VFS, rt: *jsi.Runtime) ModuleLoader {
        return .{
            .alloc = alloc,
            .vfs = v,
            .rt = rt,
            .cache = std.StringHashMap(u32).init(alloc),
            .current_dir = "/",
        };
    }

    fn deinit(self: *ModuleLoader) void {
        var it = self.cache.iterator();
        while (it.next()) |e| {
            self.alloc.free(e.key_ptr.*);
            jsi.imports.jsi_release(e.value_ptr.*);
        }
        self.cache.deinit();
    }

    /// 解析模块说明符为绝对路径（含扩展名探测）。
    fn resolve(self: *ModuleLoader, specifier: []const u8) ![]u8 {
        // 计算基础绝对路径
        const abs = try joinPath(self.alloc, self.current_dir, specifier);
        errdefer self.alloc.free(abs);

        // 优先精确匹配
        if (self.vfs.stat(abs)) |_| return abs else |_| {}

        // 尝试追加常见扩展名（优先 JS，然后 TS）
        for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json" }) |ext| {
            const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ abs, ext });
            if (self.vfs.stat(with_ext)) |_| {
                self.alloc.free(abs);
                return with_ext;
            } else |_| self.alloc.free(with_ext);
        }

        return error.ModuleNotFound;
    }

    /// 加载并缓存一个模块，返回其 module.exports 的 JSI handle。
    fn load(self: *ModuleLoader, specifier: []const u8) !u32 {
        const abs_path = try self.resolve(specifier);
        defer self.alloc.free(abs_path);

        // 命中缓存直接返回（handle 已 retain）
        if (self.cache.get(abs_path)) |h| return h;

        // 读取源代码
        const source = try self.vfs.readFile(abs_path);
        defer self.alloc.free(source);

        // JSON 文件：直接 eval 成表达式，不包 CJS 壳。
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

        // TypeScript 文件：调 jsi_transpile 获取 JS 源，再走 CJS 流程。
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

        // 构建 CommonJS 包装器
        const wrapper = try std.fmt.allocPrint(
            self.alloc,
            "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.__bun_require);return __m.exports;",
            .{js_source},
        );
        defer self.alloc.free(wrapper);

        // 嵌套 require 时临时切换当前目录
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

        // 写入缓存（key 需要 owned copy）
        _ = jsi.imports.jsi_retain(result_handle);
        const key = try self.alloc.dupe(u8, abs_path);
        try self.cache.put(key, result_handle);
        return result_handle;
    }
};

// ──────────────────────────────────────────────────────────
// Host 函数实现
// ──────────────────────────────────────────────────────────

/// JSI HostFn: `require(specifier) → module.exports`
fn requireFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (!initialized) return jsi.Value.undefined_;
    if (args.len == 0) return jsi.Value.undefined_;

    const l = &loader_g;
    const len = jsi.imports.jsi_string_length(args[0].handle);
    const buf = try l.alloc.alloc(u8, len);
    defer l.alloc.free(buf);
    jsi.imports.jsi_string_read(args[0].handle, @intFromPtr(buf.ptr), len);

    const handle = try l.load(buf);
    // handle 已经在缓存中被 retain；这里再 retain 一次供调用方使用后 release。
    _ = jsi.imports.jsi_retain(handle);
    return .{ .handle = handle };
}

/// JSI HostFn: `process.exit(code)` — 设置退出码并中止执行。
fn processExitFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    const code: f64 = if (args.len > 0) jsi.imports.jsi_to_number(args[0].handle) else 0;
    g_exit_code = @intFromFloat(@trunc(code));
    g_explicit_exit = true;
    return error.ProcessExit; // 让 JS 側抛出异常，中止当前调用栈
}

/// 在 globalThis 上安装运行时 polyfill（require、process）。
fn setupGlobals(rt: *jsi.Runtime) !void {
    const require_val = try rt.createHostFunction(requireFn, "__bun_require", 1);
    rt.setProperty(rt.global, "__bun_require", require_val);
    const exit_fn = try rt.createHostFunction(processExitFn, "exit", 1);
    rt.setProperty(rt.global, "__bun_process_exit", exit_fn);
    _ = try rt.evalScript(
        \\globalThis.require = globalThis.__bun_require;
        \\globalThis.process = {
        \\  version: 'v0.1.0-bun-browser',
        \\  platform: 'browser',
        \\  env: {},
        \\  argv: ['bun'],
        \\  exit: globalThis.__bun_process_exit,
        \\};
        \\delete globalThis.__bun_process_exit;
    ,
        "<bun-browser:polyfill>",
    );
}

// ──────────────────────────────────────────────────────────
// 导出 ABI
// ──────────────────────────────────────────────────────────

/// 初始化。必须在任何其它 bun_browser_* / jsi_host_* 调用前调用一次。
/// 由 Worker 在 WebAssembly instantiate 成功后立刻触发。
export fn bun_browser_init() void {
    if (initialized) return;
    initialized = true;

    vfs_g = sys_wasm.vfs.VFS.init(default_allocator, &clockMs) catch @panic("VFS init OOM");
    runtime_g = jsi.Runtime.init(default_allocator);
    loader_g = ModuleLoader.init(default_allocator, &vfs_g, &runtime_g);
    host_arg_scratch = std.array_list.Managed(u32).init(default_allocator);
    setupGlobals(&runtime_g) catch @panic("setupGlobals OOM");
}

/// 加载 VFS snapshot 二进制。成功返回加载的文件数；失败返回 0。
/// 与 `VFS.loadSnapshot` 格式一致。
export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 {
    if (!initialized) return 0;
    const count = vfs_g.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

/// 在 VFS 中运行入口文件（Phase 2：CommonJS/JSON/TS 模块加载 + process 安全退出）。
/// 返回値：退出码ﾈ0=成功）。
export fn bun_browser_run(path_ptr: [*]const u8, path_len: u32) i32 {
    if (!initialized) return 1;
    g_exit_code = 0;
    g_explicit_exit = false;
    const path = path_ptr[0..path_len];
    loader_g.current_dir = pathDirname(path);
    const handle = loader_g.load(path) catch |e| {
        _ = e;
        return if (g_explicit_exit) g_exit_code else 2;
    };
    jsi.imports.jsi_release(handle);
    return if (g_explicit_exit) g_exit_code else 0;
}

/// 直接 eval 一段 JS 源码（由 UI 线程发起；不经 VFS / ModuleLoader）。
/// 返回値：0=成功，1=未初始化，3=JS 异常。
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

/// JSI host function dispatch.
///
/// Host 侧约定：`argv[0..argc]` 为参数句柄；`this_handle` 为 `this`。
export fn jsi_host_invoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 {
    if (!initialized) return jsi.Value.exception_sentinel;

    // argv_ptr may alias host_arg_scratch memory (set by jsi_host_arg_scratch).
    // Copy args to a stack-local temp BEFORE mutating the scratch buffer.
    var args_tmp: [64]u32 = undefined;
    const safe_count = @min(argc, args_tmp.len);
    for (0..safe_count) |i| args_tmp[i] = argv_ptr[i];

    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.append(this_handle) catch return jsi.Value.exception_sentinel;
    host_arg_scratch.appendSlice(args_tmp[0..safe_count]) catch return jsi.Value.exception_sentinel;

    return jsi.host_function.dispatchHostFn(
        &runtime_g.host_fns,
        @as(*anyopaque, @ptrCast(&runtime_g)),
        fn_id,
        host_arg_scratch.items,
    );
}

/// 为 host function 调用准备 argv scratch buffer（u32 handle 数组）。
/// 返回缓冲区在 WASM 线性内存中的指针。
export fn jsi_host_arg_scratch(argc: u32) [*]u32 {
    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.resize(argc) catch @panic("host_arg_scratch OOM");
    return host_arg_scratch.items.ptr;
}

comptime {
    _ = bun_browser_init;
    _ = bun_vfs_load_snapshot;
    _ = bun_browser_run;
    _ = bun_browser_eval;
    _ = jsi_host_invoke;
    _ = jsi_host_arg_scratch;
}
