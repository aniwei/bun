//! Built-in polyfill sources (embedFile constants), requireFn, fs HostFunctions.
//! No imports from other bun_browser_runtime sub-modules — only state.zig.

const std = @import("std");
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
const state = @import("state.zig");
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// Built-in module sources (embedFile)
// ──────────────────────────────────────────────────────────

pub const PATH_MODULE_SRC: []const u8           = @embedFile("../js/browser-polyfills/path.js");
pub const URL_MODULE_SRC: []const u8            = @embedFile("../js/browser-polyfills/url.js");
pub const UTIL_MODULE_SRC: []const u8           = @embedFile("../js/browser-polyfills/util.js");
pub const BUFFER_POLYFILL_SRC: []const u8       = @embedFile("../js/browser-polyfills/buffer-polyfill.js");
pub const EVENTS_MODULE_SRC: []const u8         = @embedFile("../js/browser-polyfills/events.js");
pub const BUFFER_MODULE_SRC: []const u8         = @embedFile("../js/browser-polyfills/buffer.js");
pub const ASSERT_MODULE_SRC: []const u8         = @embedFile("../js/browser-polyfills/assert.js");
pub const QUERYSTRING_MODULE_SRC: []const u8    = @embedFile("../js/browser-polyfills/querystring.js");
pub const STRING_DECODER_MODULE_SRC: []const u8 = @embedFile("../js/browser-polyfills/string_decoder.js");
pub const STREAM_MODULE_SRC: []const u8         = @embedFile("../js/browser-polyfills/stream.js");
pub const CRYPTO_MODULE_SRC: []const u8         = @embedFile("../js/browser-polyfills/crypto.js");
pub const OS_MODULE_SRC: []const u8             = @embedFile("../js/browser-polyfills/os.js");
pub const ZLIB_MODULE_SRC: []const u8           = @embedFile("../js/browser-polyfills/zlib.js");
pub const HTTP_MODULE_SRC: []const u8           = @embedFile("../js/browser-polyfills/http.js");
pub const CHILD_PROCESS_MODULE_SRC: []const u8  = @embedFile("../js/browser-polyfills/child_process.js");
pub const WORKER_THREADS_MODULE_SRC: []const u8 = @embedFile("../js/browser-polyfills/worker_threads.js");
pub const PROCESS_MODULE_SRC: []const u8        = @embedFile("../js/browser-polyfills/process.js");
pub const BUN_GLOBAL_SRC: []const u8            = @embedFile("../js/browser-polyfills/bun-global.js");

// ──────────────────────────────────────────────────────────
// Built-in polyfill source map
// ──────────────────────────────────────────────────────────

pub fn builtinPolyfillSource(canonical: []const u8) []const u8 {
    if (std.mem.eql(u8, canonical, "node:path") or std.mem.eql(u8, canonical, "path"))
        return PATH_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:url") or std.mem.eql(u8, canonical, "url"))
        return URL_MODULE_SRC;
    if (std.mem.eql(u8, canonical, "node:util") or std.mem.eql(u8, canonical, "util"))
        return UTIL_MODULE_SRC;
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
    if (std.mem.eql(u8, canonical, "node:fs") or std.mem.eql(u8, canonical, "fs"))
        return "module.exports=(typeof globalThis!==\"undefined\"&&typeof globalThis.require===\"function\")?globalThis.require(\"node:fs\"):{};";
    return "module.exports={};";
}

// ──────────────────────────────────────────────────────────
// Eval helper
// ──────────────────────────────────────────────────────────

pub fn evalBuiltinSrc(src: []const u8, url: []const u8) !jsi.Value {
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

// ──────────────────────────────────────────────────────────
// process.exit HostFn
// ──────────────────────────────────────────────────────────

pub fn processExitFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    const code: f64 = if (args.len > 0) jsi.imports.jsi_to_number(args[0].handle) else 0;
    state.g_exit_code = @intFromFloat(@trunc(code));
    state.g_explicit_exit = true;
    return error.ProcessExit;
}

// ──────────────────────────────────────────────────────────
// require("fs") HostFunctions
// ──────────────────────────────────────────────────────────

pub fn makeFsModule() !jsi.Value {
    const obj = state.runtime_g.makeObject();
    const fns = [_]struct { name: []const u8, func: jsi.host_function.HostFn }{
        .{ .name = "readFileSync",  .func = fsReadFileSyncFn  },
        .{ .name = "writeFileSync", .func = fsWriteFileSyncFn },
        .{ .name = "existsSync",    .func = fsExistsSyncFn    },
        .{ .name = "mkdirSync",     .func = fsMkdirSyncFn     },
        .{ .name = "readdirSync",   .func = fsReaddirSyncFn   },
        .{ .name = "statSync",      .func = fsStatSyncFn      },
    };
    inline for (fns) |f| {
        const v = try state.runtime_g.createHostFunction(f.func, f.name, 1);
        state.runtime_g.setProperty(obj, f.name, v);
    }
    return obj;
}

pub fn fsReadFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const data = state.vfs_g.readFile(path) catch return error.JSIException;
    defer allocator.free(data);
    if (args.len > 1 and jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        return state.runtime_g.makeString(data);
    }
    return state.runtime_g.makeArrayBuffer(data, true);
}

pub fn fsWriteFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return error.JSIException;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const dir = state.pathDirname(path);
    if (!std.mem.eql(u8, dir, "/")) {
        state.vfs_g.mkdir(dir, 0o755) catch {};
    }
    if (jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        const content = try state.runtime_g.dupeString(args[1]);
        defer allocator.free(content);
        state.vfs_g.writeFile(path, content, 0o644) catch return error.JSIException;
    }
    return jsi.Value.undefined_;
}

pub fn fsExistsSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return state.runtime_g.makeBool(false);
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const exists = if (state.vfs_g.stat(path)) |_| true else |_| false;
    return state.runtime_g.makeBool(exists);
}

pub fn fsMkdirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return jsi.Value.undefined_;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    state.vfs_g.mkdir(path, 0o755) catch {};
    return jsi.Value.undefined_;
}

pub fn fsReaddirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);

    var entries = std.array_list.Managed(sys_wasm.DirEntry).init(allocator);
    defer {
        for (entries.items) |e| allocator.free(e.name);
        entries.deinit();
    }
    state.vfs_g.readdir(path, &entries) catch return error.JSIException;

    const arr = state.runtime_g.makeArray(@intCast(entries.items.len));
    for (entries.items, 0..) |entry, idx| {
        const name_val = state.runtime_g.makeString(entry.name);
        defer jsi.imports.jsi_release(name_val.handle);
        state.runtime_g.setIndex(arr, @intCast(idx), name_val);
    }
    return arr;
}

pub fn fsStatSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try state.runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const st = state.vfs_g.stat(path) catch return error.JSIException;

    const obj = state.runtime_g.makeObject();
    state.runtime_g.setProperty(obj, "size", state.runtime_g.makeNumber(@floatFromInt(st.size)));
    state.runtime_g.setProperty(obj, "isFile", try state.runtime_g.createHostFunction(statIsFileFn, "isFile", 0));
    state.runtime_g.setProperty(obj, "isDirectory", try state.runtime_g.createHostFunction(statIsDirFn, "isDirectory", 0));
    state.runtime_g.setProperty(obj, "__kind", state.runtime_g.makeNumber(@floatFromInt(@intFromEnum(st.kind))));
    return obj;
}

pub fn statIsFileFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = state.runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return state.runtime_g.makeBool(k == .file);
}

pub fn statIsDirFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = state.runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return state.runtime_g.makeBool(k == .directory);
}

// ──────────────────────────────────────────────────────────
// require() — CJS module loader HostFn
// ──────────────────────────────────────────────────────────

pub fn requireFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (!state.initialized) return jsi.Value.undefined_;
    if (args.len == 0) return jsi.Value.undefined_;

    const len = jsi.imports.jsi_string_length(args[0].handle);
    const specifier = try allocator.alloc(u8, len);
    defer allocator.free(specifier);
    jsi.imports.jsi_string_read(args[0].handle, @intFromPtr(specifier.ptr), len);

    if (state.isNodeBuiltin(specifier)) {
        if (std.mem.eql(u8, specifier, "fs") or std.mem.eql(u8, specifier, "node:fs")) {
            return makeFsModule();
        }
        const vpath = try std.fmt.allocPrint(allocator, "<{s}>", .{specifier});
        defer allocator.free(vpath);
        return evalBuiltinSrc(builtinPolyfillSource(specifier), vpath);
    }

    const l = &state.loader_g;
    const handle = try l.load(specifier);
    _ = jsi.imports.jsi_retain(handle);
    return .{ .handle = handle };
}
