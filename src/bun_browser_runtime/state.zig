//! Shared runtime state for the Bun Browser WASM module.
//! All mutable globals, the allocator, path utilities, ModuleLoader,
//! JSON helpers, and Node-builtin recognition live here so that every
//! sub-module can import this single file without circular dependencies.

const std = @import("std");
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
const Timer = @import("../timer.zig").Timer;
const bun = @import("bun");

// ──────────────────────────────────────────────────────────
// Allocator
// ──────────────────────────────────────────────────────────

pub const allocator = std.heap.wasm_allocator;

// ──────────────────────────────────────────────────────────
// Runtime globals
// ──────────────────────────────────────────────────────────

pub var vfs_g: sys_wasm.VFS = undefined;
pub var runtime_g: jsi.Runtime = undefined;
pub var loader_g: ModuleLoader = undefined;
pub var timer_g: Timer = undefined;
pub var host_arg_scratch: std.ArrayListUnmanaged(u32) = .{};
pub var initialized: bool = false;
pub var g_exit_code: i32 = 0;
pub var g_explicit_exit: bool = false;
pub var host_allocs: std.AutoHashMapUnmanaged(u32, usize) = .{};

// ──────────────────────────────────────────────────────────
// Host clock
// ──────────────────────────────────────────────────────────

pub extern "env" fn jsi_now_ms() u64;

pub fn clockMs() u64 {
    return jsi_now_ms();
}

// ──────────────────────────────────────────────────────────
// Path utilities
// ──────────────────────────────────────────────────────────

pub fn normPath(alloc: std.mem.Allocator, path: []const u8) std.mem.Allocator.Error![]u8 {
    return std.fs.path.resolvePosix(alloc, &.{path});
}

pub fn joinPath(alloc: std.mem.Allocator, base_dir: []const u8, rel: []const u8) ![]u8 {
    if (rel.len > 0 and rel[0] == '/') return normPath(alloc, rel);
    const combined = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ base_dir, rel });
    defer alloc.free(combined);
    return normPath(alloc, combined);
}

pub fn pathDirname(path: []const u8) []const u8 {
    return std.fs.path.dirnamePosix(path) orelse "/";
}

// ──────────────────────────────────────────────────────────
// Packed result helpers (ptr << 32 | len)
// ──────────────────────────────────────────────────────────
// JSON helpers
// ──────────────────────────────────────────────────────────

/// Extract the value of a simple top-level JSON string field, e.g.
///   extractJsonStringField(alloc, json, "main")  →  "index.js"
/// Only handles `"field": "value"` patterns; does not parse nested objects.
pub fn extractJsonStringField(alloc: std.mem.Allocator, json: []const u8, field: []const u8) ![]u8 {
    // Build key pattern: `"<field>"`
    const key = try std.fmt.allocPrint(alloc, "\"{s}\"", .{field});
    defer alloc.free(key);

    var i: usize = 0;
    while (i + key.len <= json.len) {
        const pos = std.mem.indexOf(u8, json[i..], key) orelse break;
        var j = i + pos + key.len;

        // Skip optional whitespace
        while (j < json.len and (json[j] == ' ' or json[j] == '\t' or json[j] == '\n' or json[j] == '\r')) j += 1;
        // Expect ':'
        if (j >= json.len or json[j] != ':') { i += pos + 1; continue; }
        j += 1;
        // Skip whitespace after ':'
        while (j < json.len and (json[j] == ' ' or json[j] == '\t' or json[j] == '\n' or json[j] == '\r')) j += 1;
        // Expect opening '"'
        if (j >= json.len or json[j] != '"') { i += pos + 1; continue; }
        j += 1;
        const start = j;
        // Scan to closing '"', respecting backslash escapes.
        while (j < json.len) {
            if (json[j] == '\\') { j += 2; continue; }
            if (json[j] == '"') break;
            j += 1;
        }
        if (j >= json.len) break;
        return try alloc.dupe(u8, json[start..j]);
    }
    return error.FieldNotFound;
}

// ──────────────────────────────────────────────────────────

pub fn packResult(ptr: u32, len: u32) u64 {
    return (@as(u64, ptr) << 32) | @as(u64, len);
}

pub fn packError(code: u32) u64 {
    return @as(u64, code);
}

/// Transfer buf ownership to host_allocs and return packed (ptr, len).
pub fn handOff(buf: []u8) u64 {
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));
    host_allocs.put(allocator, ptr, buf.len) catch {
        allocator.free(buf);
        return packError(1);
    };
    return packResult(ptr, @intCast(buf.len));
}

// ──────────────────────────────────────────────────────────
// CJS Module Loader
// ──────────────────────────────────────────────────────────

pub const ModuleLoader = struct {
    alloc: std.mem.Allocator,
    vfs: *sys_wasm.VFS,
    rt: *jsi.Runtime,
    cache: std.StringHashMap(u32),
    current_dir: []const u8,

    pub fn init(alloc_: std.mem.Allocator, v: *sys_wasm.VFS, rt: *jsi.Runtime) ModuleLoader {
        return .{
            .alloc = alloc_,
            .vfs = v,
            .rt = rt,
            .cache = std.StringHashMap(u32).init(alloc_),
            .current_dir = "/",
        };
    }

    pub fn resolve(self: *ModuleLoader, specifier: []const u8) ![]u8 {
        // Relative ("./" "../") or absolute ("/") path — existing behaviour.
        if (std.mem.startsWith(u8, specifier, ".") or std.mem.startsWith(u8, specifier, "/")) {
            const abs = try joinPath(self.alloc, self.current_dir, specifier);
            errdefer self.alloc.free(abs);

            if (self.vfs.stat(abs)) |st| {
                if (st.kind == .directory) {
                    // Try /index.js inside the directory
                    const idx = try std.fmt.allocPrint(self.alloc, "{s}/index.js", .{abs});
                    if (self.vfs.stat(idx)) |_| { self.alloc.free(abs); return idx; } else |_| self.alloc.free(idx);
                } else {
                    return abs;
                }
            } else |_| {}

            for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".css" }) |ext| {
                const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ abs, ext });
                if (self.vfs.stat(with_ext)) |_| {
                    self.alloc.free(abs);
                    return with_ext;
                } else |_| self.alloc.free(with_ext);
            }
            self.alloc.free(abs);
            return error.ModuleNotFound;
        }

        // Bare specifier (e.g. "express", "@scope/pkg", "lodash/fp") —
        // walk up the directory tree looking for node_modules/<specifier>.
        var dir: []const u8 = self.current_dir;
        while (true) {
            const nm_pkg = try std.fmt.allocPrint(self.alloc, "{s}/node_modules/{s}", .{ dir, specifier });
            defer self.alloc.free(nm_pkg);

            if (self.vfs.stat(nm_pkg)) |st| {
                if (st.kind == .directory) {
                    // Try package.json → main field first.
                    if (self.resolveNodePackageMain(nm_pkg)) |main| return main else |_| {}
                    // Fallback: index.js.
                    const idx = try std.fmt.allocPrint(self.alloc, "{s}/index.js", .{nm_pkg});
                    if (self.vfs.stat(idx)) |_| return idx else |_| self.alloc.free(idx);
                } else {
                    return try self.alloc.dupe(u8, nm_pkg);
                }
            } else |_| {}

            // Also try bare file with extensions (single-file packages).
            for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".json" }) |ext| {
                const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ nm_pkg, ext });
                if (self.vfs.stat(with_ext)) |_| return with_ext else |_| self.alloc.free(with_ext);
            }

            if (std.mem.eql(u8, dir, "/")) break;
            dir = std.fs.path.dirname(dir) orelse "/";
        }

        return error.ModuleNotFound;
    }

    /// Read `<pkg_dir>/package.json`, extract the `"main"` field, and return the
    /// resolved absolute path.  Returns an error if no usable `main` is found.
    fn resolveNodePackageMain(self: *ModuleLoader, pkg_dir: []const u8) ![]u8 {
        const pkg_json_path = try std.fmt.allocPrint(self.alloc, "{s}/package.json", .{pkg_dir});
        defer self.alloc.free(pkg_json_path);

        const content = self.vfs.readFile(pkg_json_path) catch return error.PackageJsonMissing;
        defer self.alloc.free(content);

        const main_rel = extractJsonStringField(self.alloc, content, "main") catch return error.NoMainField;
        defer self.alloc.free(main_rel);

        // Resolve relative to pkg_dir (main may be "index.js", "./lib/foo", etc.)
        const base = if (std.mem.startsWith(u8, main_rel, "."))
            main_rel
        else
            try std.fmt.allocPrint(self.alloc, "./{s}", .{main_rel});
        defer if (!std.mem.startsWith(u8, main_rel, ".")) self.alloc.free(base);

        const main_abs = try joinPath(self.alloc, pkg_dir, base);
        errdefer self.alloc.free(main_abs);

        if (self.vfs.stat(main_abs)) |_| return main_abs else |_| {}

        // Try appending extensions in case the main field omits ".js".
        for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".json" }) |ext| {
            const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ main_abs, ext });
            if (self.vfs.stat(with_ext)) |_| { self.alloc.free(main_abs); return with_ext; } else |_| self.alloc.free(with_ext);
        }
        self.alloc.free(main_abs);
        return error.MainNotFound;
    }

    pub fn load(self: *ModuleLoader, specifier: []const u8) !u32 {
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
// Compression helpers (shared by bunGunzipSyncFn and extras ABI)
// ──────────────────────────────────────────────────────────

pub fn inflateImpl(src: []const u8, format: u32) ![]u8 {
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

// ──────────────────────────────────────────────────────────
// JSON / text utilities
// ──────────────────────────────────────────────────────────

pub fn appendFmt(out: *std.ArrayList(u8), comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error!void {
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

/// JSON-escape `s` into `out` using the module-level `allocator`.
pub fn jsonEscapeTo(out: *std.ArrayListUnmanaged(u8), s: []const u8) std.mem.Allocator.Error!void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"'  => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0...0x08, 0x0b, 0x0c, 0x0e...0x1f => {
                var tmp: [6]u8 = undefined;
                const s2 = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch unreachable;
                try out.appendSlice(allocator, s2);
            },
            else => try out.append(allocator, c),
        }
    }
    try out.append(allocator, '"');
}

/// JSON-escape `s` with an explicitly provided allocator (e.g. arena).
pub fn jsonEscapeTo2(out: *std.ArrayListUnmanaged(u8), alloc: std.mem.Allocator, s: []const u8) !void {
    try out.append(alloc, '"');
    for (s) |c| {
        switch (c) {
            '"'  => try out.appendSlice(alloc, "\\\""),
            '\\' => try out.appendSlice(alloc, "\\\\"),
            '\n' => try out.appendSlice(alloc, "\\n"),
            '\r' => try out.appendSlice(alloc, "\\r"),
            '\t' => try out.appendSlice(alloc, "\\t"),
            0...0x08, 0x0b, 0x0c, 0x0e...0x1f => {
                var tmp: [6]u8 = undefined;
                const s2 = std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}) catch unreachable;
                try out.appendSlice(alloc, s2);
            },
            else => try out.append(alloc, c),
        }
    }
    try out.append(alloc, '"');
}

/// Strip trailing commas before `}` or `]` from JSON5-flavored text.
pub fn stripTrailingCommas(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
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
            var j = i + 1;
            while (j < src.len) : (j += 1) {
                const cj = src[j];
                if (cj == ' ' or cj == '\t' or cj == '\n' or cj == '\r') continue;
                break;
            }
            if (j < src.len and (src[j] == '}' or src[j] == ']')) {
                continue; // discard trailing comma
            }
        }
        try out.append(alloc, c);
    }
    return out.toOwnedSlice(alloc);
}

// ──────────────────────────────────────────────────────────
// Node built-in module recognition
// ──────────────────────────────────────────────────────────

pub const NODE_BUILTIN_BARE_NAMES = [_][]const u8{
    "fs",              "path",           "url",           "util",          "crypto",
    "buffer",          "os",             "net",           "http",          "https",
    "events",          "stream",         "assert",        "vm",            "module",
    "child_process",   "string_decoder", "querystring",   "tls",           "readline",
    "zlib",            "dns",            "dgram",         "cluster",       "tty",
    "constants",       "timers",         "async_hooks",   "perf_hooks",    "worker_threads",
    "punycode",        "process",
};

pub fn isNodeBuiltin(spec: []const u8) bool {
    if (std.mem.startsWith(u8, spec, "node:")) return true;
    for (NODE_BUILTIN_BARE_NAMES) |name| {
        if (std.mem.eql(u8, spec, name)) return true;
    }
    return false;
}

pub fn builtinVirtualPath(alloc: std.mem.Allocator, spec: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, spec, "node:")) {
        return std.fmt.allocPrint(alloc, "<builtin:{s}>", .{spec});
    }
    return std.fmt.allocPrint(alloc, "<builtin:node:{s}>", .{spec});
}

pub fn canonicalFromVirtualPath(path: []const u8) ?[]const u8 {
    const prefix = "<builtin:";
    const suffix = ">";
    if (!std.mem.startsWith(u8, path, prefix)) return null;
    if (!std.mem.endsWith(u8, path, suffix)) return null;
    return path[prefix.len .. path.len - suffix.len];
}

// ──────────────────────────────────────────────────────────
// Semver helper (shared by npm modules)
// ──────────────────────────────────────────────────────────

/// Pick the best matching version from a flat list of version strings.
/// Skips pre-release versions unless the range explicitly targets them.
pub fn semverSelectFromList(ver_list: []const []const u8, range_str: []const u8) ![]const u8 {
    const Semver = bun.Semver;
    const Version = Semver.Version;
    const Query = Semver.Query;
    const SlicedString = Semver.SlicedString;

    // For npm-like semantics, pre-release versions are only considered when
    // the requested range itself contains a pre-release marker (e.g. "-beta").
    const allow_prerelease = std.mem.indexOfScalar(u8, range_str, '-') != null;

    const range_sliced = SlicedString{ .buf = range_str, .slice = range_str };
    var group = try Query.parse(allocator, range_str, range_sliced);
    defer group.deinit();

    var best: ?struct { ver: Version, str: []const u8 } = null;

    for (ver_list) |ver_str| {
        const parse_result = Version.parseUTF8(ver_str);
        if (!parse_result.valid) continue;
        const ver = parse_result.version.min();
        if (ver.tag.hasPre() and !allow_prerelease) continue;
        if (!group.satisfies(ver, range_str, ver_str)) continue;
        if (best) |b| {
            if (ver.order(b.ver, ver_str, b.str) != .gt) continue;
        }
        best = .{ .ver = ver, .str = ver_str };
    }

    return (best orelse return error.NoMatch).str;
}
