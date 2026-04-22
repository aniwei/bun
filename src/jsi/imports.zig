//! JSI WASM imports —— 所有由 Host(TS) 侧实现、WASM 调用的函数。
//!
//! 对应 RFC 第 4.2.2 节的 ABI 表。修改时必须同步更新：
//!   - packages/bun-browser/src/jsi-host.ts
//!   - packages/bun-node/src/jsi-host-node.ts
//!
//! 所有 `*_ptr` 参数是指向 WASM linear memory 的 u32 偏移量。
//! 字符串约定为 UTF-8，不以 NUL 结尾。

// ── 值生命周期 ──────────────────────────────────────────

pub extern "jsi" fn jsi_retain(handle: u32) u32;
pub extern "jsi" fn jsi_release(handle: u32) void;

// ── 值构造 ──────────────────────────────────────────────

pub extern "jsi" fn jsi_make_number(value: f64) u32;
pub extern "jsi" fn jsi_make_string(ptr: u32, len: usize) u32;
pub extern "jsi" fn jsi_make_object() u32;
pub extern "jsi" fn jsi_make_array(length: u32) u32;
pub extern "jsi" fn jsi_make_arraybuffer(ptr: u32, len: usize, copy: u32) u32;
pub extern "jsi" fn jsi_make_error(msg_ptr: u32, msg_len: usize) u32;

// ── 类型查询 / 转换 ─────────────────────────────────────

pub extern "jsi" fn jsi_typeof(handle: u32) u32;
pub extern "jsi" fn jsi_to_number(handle: u32) f64;
pub extern "jsi" fn jsi_to_boolean(handle: u32) u32;
/// String.prototype.toString() — coerces any value to its JS string representation.
/// Returns a newly retained string handle; caller must jsi_release when done.
pub extern "jsi" fn jsi_to_string(handle: u32) u32;
pub extern "jsi" fn jsi_string_length(handle: u32) usize;
pub extern "jsi" fn jsi_string_read(handle: u32, buf_ptr: u32, buf_len: usize) void;

// ── 属性访问 ────────────────────────────────────────────

pub extern "jsi" fn jsi_get_prop(obj: u32, name_ptr: u32, name_len: usize) u32;
pub extern "jsi" fn jsi_set_prop(obj: u32, name_ptr: u32, name_len: usize, val: u32) void;
pub extern "jsi" fn jsi_get_index(arr: u32, index: u32) u32;
pub extern "jsi" fn jsi_set_index(arr: u32, index: u32, val: u32) void;
pub extern "jsi" fn jsi_has_prop(obj: u32, name_ptr: u32, name_len: usize) u32;

// ── 调用 / 构造 ─────────────────────────────────────────

pub extern "jsi" fn jsi_call(func: u32, this_: u32, argv_ptr: u32, argc: u32) u32;
pub extern "jsi" fn jsi_new(ctor: u32, argv_ptr: u32, argc: u32) u32;

// ── HostFunction ────────────────────────────────────────

pub extern "jsi" fn jsi_make_host_function(
    tag: u32,
    name_ptr: u32,
    name_len: usize,
    argc: u32,
) u32;

// ── Promise ─────────────────────────────────────────────

/// 返回 promise handle；对应的 resolver 由 Zig 侧通过 `promise.zig` 中的表访问。
pub extern "jsi" fn jsi_make_promise(resolver_tag: u32) u32;
pub extern "jsi" fn jsi_resolve(promise: u32, value: u32) void;
pub extern "jsi" fn jsi_reject(promise: u32, value: u32) void;

// ── 脚本执行 ────────────────────────────────────────────

pub extern "jsi" fn jsi_eval(
    code_ptr: u32,
    code_len: usize,
    url_ptr: u32,
    url_len: usize,
) u32;

pub extern "jsi" fn jsi_eval_module(
    code_ptr: u32,
    code_len: usize,
    url_ptr: u32,
    url_len: usize,
) u32;

// ── 宿主辅助 ────────────────────────────────────────────

/// 请求宿主在下一个 microtask 回调 WASM 的 `bun_tick()`。用于 I/O 完成唤醒。
pub extern "jsi" fn jsi_schedule_microtask() void;

/// 向宿主 stdout (level=1) 或 stderr (level=2) 打印 UTF-8 字节（无换行）。
/// 对应 `packages/bun-browser/src/jsi-host.ts` 的 `jsi_print`。
pub extern "jsi" fn jsi_print(ptr: u32, len: usize, level: u32) void;

/// 请求 Host 对给定源码进行 TypeScript → JavaScript 转译。
/// 成功返回已 retain 的 string handle（转译后 JS）；
/// 若 Host 未注册 transpiler，返回原 src 的 string handle；
/// 失败返回 `Value.exception_sentinel`。
pub extern "jsi" fn jsi_transpile(src_ptr: u32, src_len: usize, filename_ptr: u32, filename_len: usize) u32;

/// Phase 5.7: Copy bytes from an ArrayBuffer / TypedArray handle into WASM linear memory.
/// Returns the number of bytes copied (≤ dest_len), or -1 if handle is not an array-buffer
/// or typed-array. Thread-safe with respect to WASM linear memory.
pub extern "jsi" fn jsi_read_arraybuffer(handle: u32, dest_ptr: u32, dest_len: u32) i32;

/// Phase 5.7: Return the byteLength of an ArrayBuffer / TypedArray handle.
/// Returns -1 if handle is not an array-buffer or typed-array.
pub extern "jsi" fn jsi_arraybuffer_byteLength(handle: u32) i32;
