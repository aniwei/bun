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

var vfs: ?sys_wasm.vfs.VFS = null;
var runtime: ?jsi.Runtime = null;
var host_arg_scratch: std.array_list.Managed(u32) = undefined;
var initialized: bool = false;

/// Host 导入：`env.jsi_now_ms` —— 毫秒时钟。VFS 与 Loop 均用它。
extern "env" fn jsi_now_ms() u64;

fn clockMs() u64 {
    return jsi_now_ms();
}

// ──────────────────────────────────────────────────────────
// 导出 ABI
// ──────────────────────────────────────────────────────────

/// 初始化。必须在任何其它 bun_browser_* / jsi_host_* 调用前调用一次。
/// 由 Worker 在 WebAssembly instantiate 成功后立刻触发。
export fn bun_browser_init() void {
    if (initialized) return;
    initialized = true;

    vfs = sys_wasm.vfs.VFS.init(default_allocator, &clockMs) catch @panic("VFS init OOM");
    runtime = jsi.Runtime.init(default_allocator);
    host_arg_scratch = std.array_list.Managed(u32).init(default_allocator);
}

/// 加载 VFS snapshot 二进制。成功返回加载的文件数；失败返回 0。
/// 与 `VFS.loadSnapshot` 格式一致。
export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 {
    const v = &(vfs orelse return 0);
    const count = v.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

/// 在 VFS 中运行入口文件。Phase 1：仅做 transpile + JSI eval（后续 Phase 接 ESM loader）。
/// 返回值：退出码（0=成功）。
export fn bun_browser_run(path_ptr: [*]const u8, path_len: u32) i32 {
    const v = &(vfs orelse return 1);
    const rt = &(runtime orelse return 1);

    const path = path_ptr[0..path_len];
    const source = v.readFile(path) catch return 2;
    defer default_allocator.free(source);

    // Phase 1 占位：直接把 source 作为 script 交给 host。
    // 后续 Phase 会接入 transpiler → 输出 → jsi.evalModule。
    const result = rt.evalScript(source, path) catch return 3;
    defer result.release();
    return 0;
}

/// JSI host function dispatch.
///
/// Host 侧约定：`argv[0] = thisHandle`，`argv[1..argc+1] = argHandles`，
/// 然后调用 `jsi_host_invoke(fn_id, thisHandle, argv_ptr_at_offset_for_this, argc_including_this)`。
/// 见 `src/jsi/host_function.zig` `dispatchHostFn` 实现。
export fn jsi_host_invoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 {
    const rt = &(runtime orelse return jsi.Value.exception_sentinel);

    // 拼装 [this, args...] 到 scratch buffer，以对齐 dispatchHostFn 的 layout。
    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.append(this_handle) catch return jsi.Value.exception_sentinel;
    const src = argv_ptr[0..argc];
    host_arg_scratch.appendSlice(src) catch return jsi.Value.exception_sentinel;

    return jsi.host_function.dispatchHostFn(
        &rt.host_fns,
        @as(*anyopaque, @ptrCast(rt)),
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
    _ = jsi_host_invoke;
    _ = jsi_host_arg_scratch;
}
