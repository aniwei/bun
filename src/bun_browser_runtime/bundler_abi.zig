//! Bundler, module resolution, path/transform/URL ABI exports.

const std = @import("std");
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");
const bun_wasm_transform = @import("../bun_wasm_transform.zig");
const state = @import("state.zig");
const rfs = @import("require_and_fs.zig");
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// Resolve result
// ──────────────────────────────────────────────────────────

pub const ResolveResult = struct { path: []u8, loader: []const u8 };

fn classifyLoader(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".tsx")) return "tsx";
    if (std.mem.endsWith(u8, path, ".ts"))  return "ts";
    if (std.mem.endsWith(u8, path, ".mts")) return "ts";
    if (std.mem.endsWith(u8, path, ".cts")) return "ts";
    if (std.mem.endsWith(u8, path, ".jsx")) return "jsx";
    if (std.mem.endsWith(u8, path, ".mjs")) return "mjs";
    if (std.mem.endsWith(u8, path, ".cjs")) return "cjs";
    if (std.mem.endsWith(u8, path, ".json")) return "json";
    if (std.mem.endsWith(u8, path, ".css")) return "css";
    return "js";
}

pub fn isFile(path: []const u8) bool {
    const st = state.vfs_g.stat(path) catch return false;
    return st.kind == .file;
}

pub fn isDir(path: []const u8) bool {
    const st = state.vfs_g.stat(path) catch return false;
    return st.kind == .directory;
}

// ──────────────────────────────────────────────────────────
// Relative / bare resolution
// ──────────────────────────────────────────────────────────

pub fn resolveRelative(alloc: std.mem.Allocator, base_dir: []const u8, spec: []const u8) !ResolveResult {
    const abs = try state.joinPath(alloc, base_dir, spec);
    if (isFile(abs)) return .{ .path = abs, .loader = classifyLoader(abs) };

    const exts = [_][]const u8{ ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json", ".css" };
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}{s}", .{ abs, ext });
        if (isFile(p)) { alloc.free(abs); return .{ .path = p, .loader = classifyLoader(p) }; }
        alloc.free(p);
    }
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}/index{s}", .{ abs, ext });
        if (isFile(p)) { alloc.free(abs); return .{ .path = p, .loader = classifyLoader(p) }; }
        alloc.free(p);
    }
    alloc.free(abs);
    return error.ModuleNotFound;
}

pub fn resolveBareInVfs(alloc: std.mem.Allocator, base_dir: []const u8, name: []const u8) !ResolveResult {
    var pkg_name: []const u8 = name;
    var subpath: []const u8 = ".";
    var sub_buf: ?[]u8 = null;
    defer if (sub_buf) |b| alloc.free(b);

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

    var cur: []const u8 = base_dir;
    while (true) {
        const nm_root = try std.fmt.allocPrint(alloc, "{s}/node_modules/{s}", .{ cur, pkg_name });
        defer alloc.free(nm_root);
        if (isDir(nm_root)) {
            return resolvePackageEntry(alloc, nm_root, subpath) catch |err| switch (err) {
                error.ModuleNotFound => return resolveRelative(alloc, nm_root, subpath),
                else => return err,
            };
        }
        if (std.mem.eql(u8, cur, "/")) break;
        cur = state.pathDirname(cur);
    }
    return error.ModuleNotFound;
}

fn resolvePackageEntry(alloc: std.mem.Allocator, pkg_dir: []const u8, subpath: []const u8) !ResolveResult {
    if (!std.mem.eql(u8, subpath, ".")) {
        if (readPackageJson(alloc, pkg_dir)) |parsed_val| {
            defer parsed_val.deinit();
            if (parsed_val.value == .object) {
                if (parsed_val.value.object.get("exports")) |exports_node| {
                    if (exports_node == .object) {
                        if (exports_node.object.get(subpath)) |v| {
                            if (pickExportsString(v)) |s| return resolveRelative(alloc, pkg_dir, s);
                        }
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
            if (obj.get("main"))   |m| if (m == .string) return resolveRelative(alloc, pkg_dir, m.string);
        }
    } else |_| {}
    return resolveRelative(alloc, pkg_dir, ".");
}

fn resolveExportsWildcard(alloc: std.mem.Allocator, obj: std.json.ObjectMap, subpath: []const u8) ?[]u8 {
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
            target[0..t_star], matched, target[t_star + 1 ..],
        }) catch null;
    }
    return null;
}

fn readPackageJson(alloc: std.mem.Allocator, pkg_dir: []const u8) !std.json.Parsed(std.json.Value) {
    const pj_path = try std.fmt.allocPrint(alloc, "{s}/package.json", .{pkg_dir});
    defer alloc.free(pj_path);
    const raw = state.vfs_g.readFile(pj_path) catch return error.ModuleNotFound;
    defer alloc.free(raw);
    return std.json.parseFromSlice(std.json.Value, alloc, raw, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.ModuleNotFound;
}

fn pickExportsString(v: std.json.Value) ?[]const u8 {
    return switch (v) {
        .string => |s| s,
        .object => |o| blk: {
            if (o.get("browser")) |x| if (x == .string) break :blk x.string;
            if (o.get("import"))  |x| if (x == .string) break :blk x.string;
            if (o.get("default")) |x| if (x == .string) break :blk x.string;
            if (o.get("require")) |x| if (x == .string) break :blk x.string;
            break :blk null;
        },
        else => null,
    };
}

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

// ──────────────────────────────────────────────────────────
// tsconfig.json path resolution
// ──────────────────────────────────────────────────────────

pub fn resolveViaTsconfigPaths(alloc: std.mem.Allocator, base_dir: []const u8, spec: []const u8) !ResolveResult {
    var cur: []const u8 = base_dir;
    while (true) {
        const tsc_path = try std.fmt.allocPrint(alloc, "{s}/tsconfig.json", .{cur});
        defer alloc.free(tsc_path);
        if (isFile(tsc_path)) {
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
        cur = state.pathDirname(cur);
    }
    return error.ModuleNotFound;
}

const MergedTsconfig = struct {
    root: std.json.Parsed(std.json.Value),
    extras: std.array_list.Managed(std.json.Parsed(std.json.Value)),
    base_url: ?[]u8,
    paths: ?std.json.ObjectMap,

    fn deinit(self: *MergedTsconfig, alloc: std.mem.Allocator) void {
        self.root.deinit();
        for (self.extras.items) |*p| p.deinit();
        self.extras.deinit();
        if (self.base_url) |b| alloc.free(b);
    }
};

fn loadTsconfigMerged(alloc: std.mem.Allocator, path: []const u8, depth: u32) !MergedTsconfig {
    if (depth > 8) return error.TooDeep;
    const raw = state.vfs_g.readFile(path) catch return error.ModuleNotFound;
    defer alloc.free(raw);
    const stripped = state.stripTrailingCommas(alloc, raw) catch return error.OutOfMemory;
    defer alloc.free(stripped);
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, stripped, .{
        .duplicate_field_behavior = .use_last,
    }) catch return error.ModuleNotFound;
    errdefer parsed.deinit();

    const parent_dir = state.pathDirname(path);
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
                if (co.object.get("baseUrl")) |bu| if (bu == .string) { base_url_raw = bu.string; };
                if (co.object.get("paths")) |p| if (p == .object) { merged.paths = p.object; };
            }
        }
    }

    const needs_extend = (merged.paths == null or base_url_raw == null) and
        (parsed.value == .object and parsed.value.object.get("extends") != null);
    if (needs_extend) {
        const ext_node = parsed.value.object.get("extends").?;
        if (ext_node == .string) {
            const ext_spec = ext_node.string;
            const ext_path_opt: ?[]u8 = if (ext_spec.len > 0 and (ext_spec[0] == '.' or ext_spec[0] == '/'))
                blk: {
                    var joined = try state.joinPath(alloc, parent_dir, ext_spec);
                    if (!std.mem.endsWith(u8, joined, ".json")) {
                        const extended = try std.fmt.allocPrint(alloc, "{s}.json", .{joined});
                        alloc.free(joined);
                        joined = extended;
                    }
                    break :blk joined;
                }
            else
                null;
            if (ext_path_opt) |ext_path| {
                defer alloc.free(ext_path);
                if (loadTsconfigMerged(alloc, ext_path, depth + 1)) |child| {
                    var c = child;
                    if (merged.paths == null and c.paths != null) {
                        merged.paths = c.paths;
                        try merged.extras.append(c.root);
                        try merged.extras.appendSlice(c.extras.items);
                        c.extras.items.len = 0;
                        c.extras.deinit();
                        if (c.base_url) |cbase| {
                            if (merged.base_url == null) merged.base_url = cbase else alloc.free(cbase);
                        }
                        base_url_raw = null;
                    } else {
                        c.deinit(alloc);
                    }
                } else |_| {}
            }
        }
    }

    if (merged.base_url == null) {
        const br = base_url_raw orelse ".";
        merged.base_url = try state.joinPath(alloc, parent_dir, br);
    }
    return merged;
}

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
    if (std.mem.eql(u8, pattern, spec)) return alloc.dupe(u8, "") catch null;
    return null;
}

fn renderTsconfigTarget(alloc: std.mem.Allocator, target: []const u8, matched: []const u8) ![]u8 {
    if (std.mem.indexOfScalar(u8, target, '*')) |star| {
        return std.fmt.allocPrint(alloc, "{s}{s}{s}", .{
            target[0..star], matched, target[star + 1 ..],
        });
    }
    return alloc.dupe(u8, target);
}

// ──────────────────────────────────────────────────────────
// Resolve JSON emitter
// ──────────────────────────────────────────────────────────

fn emitResolveResult(path: []const u8, loader: []const u8) u64 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.appendSlice(allocator, "{\"path\":") catch return state.packError(1);
    state.jsonEscapeTo(&out, path) catch return state.packError(1);
    out.appendSlice(allocator, ",\"loader\":") catch return state.packError(1);
    state.jsonEscapeTo(&out, loader) catch return state.packError(1);
    out.append(allocator, '}') catch return state.packError(1);
    const owned = out.toOwnedSlice(allocator) catch return state.packError(1);
    return state.handOff(owned);
}

// ──────────────────────────────────────────────────────────
// Bundler
// ──────────────────────────────────────────────────────────

pub const Bundler = struct {
    alloc: std.mem.Allocator,
    by_path: std.StringHashMap(u32),
    entries: std.ArrayListUnmanaged(BundleEntry),
    entry_id: u32 = 0,
    externals: std.ArrayListUnmanaged([]u8) = .{},
    defines: std.ArrayListUnmanaged(DefineEntry) = .{},

    pub const DefineEntry = struct { key: []u8, value: []u8 };

    pub const BundleEntry = struct {
        path: []u8,
        js_source: []u8,
        deps: std.ArrayListUnmanaged(DepEdge) = .{},
    };
    pub const DepEdge = struct { specifier: []u8, target_id: u32 };

    pub const BundlerError = error{ OutOfMemory, ModuleNotFound, TooDeep, TranspileFailed };

    pub fn init(alloc: std.mem.Allocator) BundlerError!Bundler {
        return .{
            .alloc = alloc,
            .by_path = std.StringHashMap(u32).init(alloc),
            .entries = .{},
        };
    }

    pub fn deinit(self: *Bundler) void {
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

    pub fn addEntry(self: *Bundler, entry_path: []const u8) BundlerError!void {
        self.entry_id = try self.addFile(entry_path, "/", 0);
    }

    fn addExternalModule(self: *Bundler, specifier: []const u8) BundlerError!u32 {
        const synthetic_path = std.fmt.allocPrint(self.alloc, "<external:{s}>", .{specifier}) catch return error.OutOfMemory;
        if (self.by_path.get(synthetic_path)) |existing_id| {
            self.alloc.free(synthetic_path);
            return existing_id;
        }
        var js_buf: std.ArrayList(u8) = .empty;
        defer js_buf.deinit(self.alloc);
        js_buf.appendSlice(self.alloc, "module.exports=(typeof globalThis!==\"undefined\"&&typeof globalThis.require===\"function\")?globalThis.require(") catch return error.OutOfMemory;
        var tmp_unmanaged: std.ArrayListUnmanaged(u8) = .{};
        defer tmp_unmanaged.deinit(self.alloc);
        tmp_unmanaged.appendSlice(self.alloc, js_buf.items) catch return error.OutOfMemory;
        state.jsonEscapeTo(&tmp_unmanaged, specifier) catch return error.OutOfMemory;
        tmp_unmanaged.appendSlice(self.alloc, "):{};") catch return error.OutOfMemory;
        const js = tmp_unmanaged.toOwnedSlice(self.alloc) catch return error.OutOfMemory;

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
        self.entries.append(self.alloc, .{ .path = synthetic_path, .js_source = js, .deps = .{} }) catch return error.OutOfMemory;
        return id;
    }

    fn resolveModule(self: *Bundler, specifier: []const u8, base_dir: []const u8) !ResolveResult {
        if (specifier.len == 0) return error.ModuleNotFound;
        if (state.isNodeBuiltin(specifier)) {
            const vpath = state.builtinVirtualPath(self.alloc, specifier) catch return error.OutOfMemory;
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

        for (self.externals.items) |ext| {
            if (std.mem.eql(u8, specifier, ext)) return self.addExternalModule(specifier);
        }

        const resolved = self.resolveModule(specifier, base_dir) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.ModuleNotFound => return error.ModuleNotFound,
        };

        if (self.by_path.get(resolved.path)) |id| {
            self.alloc.free(resolved.path);
            return id;
        }

        if (state.canonicalFromVirtualPath(resolved.path)) |canonical| {
            const polyfill = rfs.builtinPolyfillSource(canonical);
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
            try self.entries.append(self.alloc, .{ .path = resolved.path, .js_source = js, .deps = .{} });
            var deps = scanDependencies(self.alloc, js) catch return error.OutOfMemory;
            errdefer { for (deps.items) |*d| self.alloc.free(d.specifier); deps.deinit(self.alloc); }
            var di: usize = 0;
            while (di < deps.items.len) : (di += 1) {
                const child_id = self.addFile(deps.items[di].specifier, "/", depth + 1) catch |err| switch (err) {
                    error.ModuleNotFound => { deps.items[di].target_id = std.math.maxInt(u32); continue; },
                    else => return err,
                };
                deps.items[di].target_id = child_id;
            }
            self.entries.items[id].deps = deps;
            return id;
        }

        const raw = state.vfs_g.readFile(resolved.path) catch {
            self.alloc.free(resolved.path);
            return error.ModuleNotFound;
        };
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
            error.OutOfMemory => { self.alloc.free(resolved.path); return error.OutOfMemory; },
            error.TranspileFailed => { self.alloc.free(resolved.path); return error.TranspileFailed; },
        };

        const id: u32 = @intCast(self.entries.items.len);
        try self.by_path.put(try self.alloc.dupe(u8, resolved.path), id);
        try self.entries.append(self.alloc, .{ .path = resolved.path, .js_source = js, .deps = .{} });

        var deps = scanDependencies(self.alloc, js) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
        };
        errdefer { for (deps.items) |*d| self.alloc.free(d.specifier); deps.deinit(self.alloc); }

        const this_dir = state.pathDirname(self.entries.items[id].path);
        var i: usize = 0;
        while (i < deps.items.len) : (i += 1) {
            const child_id = self.addFile(deps.items[i].specifier, this_dir, depth + 1) catch |err| switch (err) {
                error.ModuleNotFound => { deps.items[i].target_id = std.math.maxInt(u32); continue; },
                else => return err,
            };
            deps.items[i].target_id = child_id;
        }
        self.entries.items[id].deps = deps;
        return id;
    }

    pub fn emit(self: *Bundler) std.mem.Allocator.Error![]u8 {
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
        for (self.entries.items, 0..) |entry, i| {
            try state.appendFmt(&out, "// {s}\n", .{entry.path});
            try state.appendFmt(&out, "__modules__[{d}]=function(module,exports,require){{\n", .{i});
            try out.appendSlice(self.alloc, "var __filename=");
            var tmp: std.ArrayListUnmanaged(u8) = .{};
            defer tmp.deinit(self.alloc);
            try state.jsonEscapeTo(&tmp, entry.path);
            try out.appendSlice(self.alloc, tmp.items);
            try out.appendSlice(self.alloc, ",__dirname=");
            tmp.clearRetainingCapacity();
            try state.jsonEscapeTo(&tmp, state.pathDirname(entry.path));
            try out.appendSlice(self.alloc, tmp.items);
            try out.appendSlice(self.alloc, ";\n");
            try out.appendSlice(self.alloc, entry.js_source);
            try out.appendSlice(self.alloc, "\n};\n");
            try state.appendFmt(&out, "__modules__[{d}].__deps__={{", .{i});
            for (entry.deps.items, 0..) |dep, di| {
                if (di != 0) try out.append(self.alloc, ',');
                tmp.clearRetainingCapacity();
                try state.jsonEscapeTo(&tmp, dep.specifier);
                try out.appendSlice(self.alloc, tmp.items);
                if (dep.target_id == std.math.maxInt(u32)) {
                    try state.appendFmt(&out, ":-1", .{});
                } else {
                    try state.appendFmt(&out, ":{d}", .{dep.target_id});
                }
            }
            try out.appendSlice(self.alloc, "};\n");
        }
        try state.appendFmt(&out, "return __require({d});\n}})();\n", .{self.entry_id});
        return out.toOwnedSlice(self.alloc);
    }
};

// ──────────────────────────────────────────────────────────
// Bundler helpers
// ──────────────────────────────────────────────────────────

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
            if (i > 0) {
                const p = src[i - 1];
                if ((p >= 'a' and p <= 'z') or (p >= 'A' and p <= 'Z') or
                    (p >= '0' and p <= '9') or p == '_' or p == '$') continue;
            }
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
        return std.fmt.allocPrint(alloc, "module.exports={s};", .{src}) catch error.OutOfMemory;
    }
    if (std.mem.endsWith(u8, path, ".css")) {
        var css_buf: std.ArrayList(u8) = .empty;
        defer css_buf.deinit(alloc);
        try css_buf.appendSlice(alloc, "(function(){if(typeof document!==\"undefined\"){var s=document.createElement(\"style\");s.textContent=");
        var tmp: std.ArrayListUnmanaged(u8) = .{};
        defer tmp.deinit(alloc);
        try state.jsonEscapeTo(&tmp, src);
        try css_buf.appendSlice(alloc, tmp.items);
        try css_buf.appendSlice(alloc, ";document.head.appendChild(s);}})();module.exports={};");
        return css_buf.toOwnedSlice(alloc) catch error.OutOfMemory;
    }
    if (!is_ts) return alloc.dupe(u8, src) catch error.OutOfMemory;

    const h = jsi.imports.jsi_transpile(
        @intFromPtr(src.ptr), src.len,
        @intFromPtr(path.ptr), path.len,
    );
    if (h != jsi.Value.exception_sentinel) {
        defer jsi.imports.jsi_release(h);
        const js_len = jsi.imports.jsi_string_length(h);
        const js_buf = alloc.alloc(u8, js_len) catch return error.OutOfMemory;
        jsi.imports.jsi_string_read(h, @intFromPtr(js_buf.ptr), js_len);
        if (!std.mem.eql(u8, js_buf, src)) return js_buf;
        alloc.free(js_buf);
    }

    const opts = bun_wasm_transform.TransformOptions{
        .source = src,
        .filename = path,
        .esm_to_cjs = true,
        .jsx = if (std.mem.endsWith(u8, path, ".tsx") or std.mem.endsWith(u8, path, ".jsx")) .react else .none,
    };
    var result = bun_wasm_transform.transform(alloc, opts) catch return error.OutOfMemory;
    defer result.deinit();
    if (result.code) |code| return alloc.dupe(u8, code) catch error.OutOfMemory;
    return error.TranspileFailed;
}

fn scanDependencies(alloc: std.mem.Allocator, src: []const u8) error{OutOfMemory}!std.ArrayListUnmanaged(Bundler.DepEdge) {
    var out: std.ArrayListUnmanaged(Bundler.DepEdge) = .{};
    errdefer { for (out.items) |*d| alloc.free(d.specifier); out.deinit(alloc); }

    const sanitized = stripCommentsAndStrings(alloc, src) catch return error.OutOfMemory;
    defer alloc.free(sanitized);

    var i: usize = 0;
    while (i < sanitized.len) {
        const next = findNextImportSite(sanitized, i) orelse break;
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

const ImportSite = struct { quote_search_from: usize, advance_past: usize };

fn findNextImportSite(san: []const u8, from: usize) ?ImportSite {
    var i: usize = from;
    while (i < san.len) : (i += 1) {
        if (san[i] == 'r' and san.len - i >= 8 and std.mem.startsWith(u8, san[i..], "require(")) {
            if (isIdentBoundary(san, i)) return .{ .quote_search_from = i + 8, .advance_past = i + 8 };
        }
        if ((san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import ")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import(")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import\"")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import'")) or
            (san[i] == 'e' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "export ")))
        {
            if (!isIdentBoundary(san, i)) continue;
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
        if (c == ';') return null;
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from ") and isIdentBoundary(san, i))
            return findQuote(san, i + 5);
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from\t") and isIdentBoundary(san, i))
            return findQuote(san, i + 5);
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
        if (src[j] == '\\') { j += 1; continue; }
        if (src[j] == q) break;
    }
    if (j >= src.len) return null;
    return .{ .value = src[start..j], .end_in_src = j + 1 };
}

fn stripCommentsAndStrings(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
    const out = try alloc.alloc(u8, src.len);
    @memcpy(out, src);
    var i: usize = 0;
    while (i < out.len) {
        const c = out[i];
        if (c == '/' and i + 1 < out.len and out[i + 1] == '/') {
            while (i < out.len and out[i] != '\n') : (i += 1) out[i] = ' ';
            continue;
        }
        if (c == '/' and i + 1 < out.len and out[i + 1] == '*') {
            out[i] = ' '; out[i + 1] = ' '; i += 2;
            while (i + 1 < out.len and !(out[i] == '*' and out[i + 1] == '/')) : (i += 1) {
                if (out[i] != '\n') out[i] = ' ';
            }
            if (i + 1 < out.len) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
            continue;
        }
        if (c == '"' or c == '\'' or c == '`') {
            const quote = c;
            out[i] = ' '; i += 1;
            while (i < out.len) {
                if (out[i] == '\\' and i + 1 < out.len) {
                    out[i] = ' ';
                    if (out[i + 1] != '\n') out[i + 1] = ' ';
                    i += 2; continue;
                }
                if (out[i] == quote) { out[i] = ' '; i += 1; break; }
                if (out[i] != '\n') out[i] = ' ';
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    return out;
}

// ──────────────────────────────────────────────────────────
// bun_resolve / bun_bundle / bun_bundle2 ABI
// ──────────────────────────────────────────────────────────

pub fn resolve(spec_ptr: [*]const u8, spec_len: u32, from_ptr: [*]const u8, from_len: u32) u64 {
    if (!state.initialized) return state.packError(1);
    const spec = spec_ptr[0..spec_len];
    const from = from_ptr[0..from_len];
    if (spec.len == 0) return state.packError(3);
    const base_dir: []const u8 = if (from.len > 0 and from[0] == '/') state.pathDirname(from) else "/";
    if (state.isNodeBuiltin(spec)) {
        const vpath = state.builtinVirtualPath(allocator, spec) catch return state.packError(1);
        defer allocator.free(vpath);
        return emitResolveResult(vpath, "js");
    }
    const is_bare = !(spec[0] == '/' or spec[0] == '.');
    if (is_bare) {
        if (resolveViaTsconfigPaths(allocator, base_dir, spec)) |r| {
            defer allocator.free(r.path);
            return emitResolveResult(r.path, r.loader);
        } else |err| switch (err) {
            error.OutOfMemory => return state.packError(1),
            error.ModuleNotFound => {},
        }
        const resolved = resolveBareInVfs(allocator, base_dir, spec) catch |err| switch (err) {
            error.OutOfMemory => return state.packError(1),
            error.ModuleNotFound => return state.packError(4),
        };
        defer allocator.free(resolved.path);
        return emitResolveResult(resolved.path, resolved.loader);
    }
    const resolved = resolveRelative(allocator, base_dir, spec) catch |err| switch (err) {
        error.OutOfMemory => return state.packError(1),
        error.ModuleNotFound => return state.packError(2),
    };
    defer allocator.free(resolved.path);
    return emitResolveResult(resolved.path, resolved.loader);
}

pub fn bundle(entry_ptr: [*]const u8, entry_len: u32) u64 {
    if (!state.initialized) return state.packError(1);
    const entry = entry_ptr[0..entry_len];
    var b = Bundler.init(allocator) catch return state.packError(1);
    defer b.deinit();
    b.addEntry(entry) catch |err| switch (err) {
        error.OutOfMemory => return state.packError(1),
        error.ModuleNotFound => return state.packError(2),
        error.TooDeep => return state.packError(3),
        error.TranspileFailed => return state.packError(4),
    };
    const emitted = b.emit() catch return state.packError(1);
    return state.handOff(emitted);
}

pub fn bundle2(cfg_ptr: [*]const u8, cfg_len: u32) u64 {
    if (!state.initialized) return state.packError(1);
    const cfg_json = cfg_ptr[0..cfg_len];
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, cfg_json, .{
        .ignore_unknown_fields = true,
    }) catch return state.packError(1);
    defer parsed.deinit();
    const obj = switch (parsed.value) { .object => |o| o, else => return state.packError(1) };
    const entry_val = obj.get("entrypoint") orelse return state.packError(5);
    const entry = switch (entry_val) { .string => |s| s, else => return state.packError(5) };

    var b = Bundler.init(allocator) catch return state.packError(1);
    defer b.deinit();

    if (obj.get("external")) |ext_val| {
        if (ext_val == .array) {
            for (ext_val.array.items) |item| {
                if (item != .string) continue;
                const copy = allocator.dupe(u8, item.string) catch return state.packError(1);
                b.externals.append(allocator, copy) catch { allocator.free(copy); return state.packError(1); };
            }
        }
    }
    if (obj.get("define")) |def_val| {
        if (def_val == .object) {
            var it = def_val.object.iterator();
            while (it.next()) |kv| {
                if (kv.value_ptr.* != .string) continue;
                const key = allocator.dupe(u8, kv.key_ptr.*) catch return state.packError(1);
                const val = allocator.dupe(u8, kv.value_ptr.*.string) catch { allocator.free(key); return state.packError(1); };
                b.defines.append(allocator, .{ .key = key, .value = val }) catch {
                    allocator.free(key); allocator.free(val); return state.packError(1);
                };
            }
        }
    }

    b.addEntry(entry) catch |err| switch (err) {
        error.OutOfMemory => return state.packError(1),
        error.ModuleNotFound => return state.packError(2),
        error.TooDeep => return state.packError(3),
        error.TranspileFailed => return state.packError(4),
    };
    const emitted = b.emit() catch return state.packError(1);
    return state.handOff(emitted);
}

// ──────────────────────────────────────────────────────────
// bun_path_* ABI
// ──────────────────────────────────────────────────────────

pub fn pathNormalize(ptr: [*]const u8, len: u32) u64 {
    const path = ptr[0..len];
    const result = std.fs.path.resolvePosix(allocator, &.{path}) catch return state.packError(1);
    return state.handOff(result);
}

pub fn pathDirname(ptr: [*]const u8, len: u32) u64 {
    const path = ptr[0..len];
    const dir = std.fs.path.dirnamePosix(path) orelse "/";
    const result = allocator.dupe(u8, dir) catch return state.packError(1);
    return state.handOff(result);
}

pub fn pathJoin(paths_ptr: [*]const u8, paths_len: u32) u64 {
    if (paths_len < 4) return state.packError(2);
    const buf = paths_ptr[0..paths_len];
    const base_len = std.mem.readInt(u32, buf[0..4], .little);
    if (4 + base_len > paths_len) return state.packError(2);
    const base = buf[4 .. 4 + base_len];
    const rel = buf[4 + base_len .. paths_len];
    const result = state.joinPath(allocator, base, rel) catch return state.packError(1);
    return state.handOff(result);
}

// ──────────────────────────────────────────────────────────
// bun_transform ABI
// ──────────────────────────────────────────────────────────

pub fn transform(opts_ptr: [*]const u8, opts_len: u32) u64 {
    if (!state.initialized) return state.packError(1);
    const opts_json = opts_ptr[0..opts_len];
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, opts_json, .{}) catch return state.packError(2);
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return state.packError(2);
    const code_val = root.object.get("code") orelse return state.packError(2);
    const filename_val = root.object.get("filename") orelse return state.packError(2);
    const jsx_val = root.object.get("jsx");
    const code = switch (code_val) { .string => |s| s, else => return state.packError(2) };
    const filename = switch (filename_val) { .string => |s| s, else => return state.packError(2) };
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
        .esm_to_cjs = if (root.object.get("esm_to_cjs")) |v| switch (v) { .bool => |b| b, else => false } else false,
        .source_map = if (root.object.get("source_map")) |v| switch (v) { .bool => |b| b, else => false } else false,
    };
    var result = bun_wasm_transform.transform(allocator, opts) catch {
        const err_json = "{\"code\":null,\"errors\":[\"transform failed\"]}";
        const buf = allocator.dupe(u8, err_json) catch return state.packError(1);
        return state.handOff(buf);
    };
    defer result.deinit();
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    if (result.code) |js| {
        out.appendSlice(allocator, "{\"code\":") catch return state.packError(1);
        var tmp: std.ArrayListUnmanaged(u8) = .{};
        defer tmp.deinit(allocator);
        state.jsonEscapeTo(&tmp, js) catch return state.packError(1);
        out.appendSlice(allocator, tmp.items) catch return state.packError(1);
        if (result.map) |m| {
            out.appendSlice(allocator, ",\"map\":") catch return state.packError(1);
            tmp.clearRetainingCapacity();
            state.jsonEscapeTo(&tmp, m) catch return state.packError(1);
            out.appendSlice(allocator, tmp.items) catch return state.packError(1);
        }
        out.appendSlice(allocator, ",\"errors\":[]}") catch return state.packError(1);
    } else {
        out.appendSlice(allocator, "{\"code\":null,\"errors\":[") catch return state.packError(1);
        var tmp: std.ArrayListUnmanaged(u8) = .{};
        defer tmp.deinit(allocator);
        for (result.errors, 0..) |e, idx| {
            if (idx != 0) out.append(allocator, ',') catch return state.packError(1);
            tmp.clearRetainingCapacity();
            state.jsonEscapeTo(&tmp, e) catch return state.packError(1);
            out.appendSlice(allocator, tmp.items) catch return state.packError(1);
        }
        out.appendSlice(allocator, "]}") catch return state.packError(1);
    }
    const owned = out.toOwnedSlice(allocator) catch return state.packError(1);
    return state.handOff(owned);
}

// ──────────────────────────────────────────────────────────
// bun_url_parse ABI
// ──────────────────────────────────────────────────────────

fn jsonWriteStringField(w: anytype, key: []const u8, value: []const u8) !void {
    try w.writeByte('"');
    try w.writeAll(key);
    try w.writeAll("\":");
    try jsonWriteString(w, value);
}

fn jsonWriteString(w: anytype, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"'  => try w.writeAll("\\\""),
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

pub fn urlParse(ptr: [*]const u8, len: u32) u64 {
    const url_str = ptr[0..len];
    const uri = std.Uri.parse(url_str) catch return state.packError(2);

    const scheme = uri.scheme;
    const hostname_raw: []const u8 = if (uri.host) |h| switch (h) {
        .raw => |s| s, .percent_encoded => |s| s,
    } else "";
    const path_raw: []const u8 = switch (uri.path) {
        .raw => |s| s, .percent_encoded => |s| s,
    };
    const query_raw: ?[]const u8 = if (uri.query) |q| switch (q) {
        .raw => |s| s, .percent_encoded => |s| s,
    } else null;
    const fragment_raw: ?[]const u8 = if (uri.fragment) |f| switch (f) {
        .raw => |s| s, .percent_encoded => |s| s,
    } else null;

    const protocol = allocator.alloc(u8, scheme.len + 1) catch return state.packError(1);
    defer allocator.free(protocol);
    @memcpy(protocol[0..scheme.len], scheme);
    protocol[scheme.len] = ':';

    var port_buf: [8]u8 = undefined;
    const port_str: []const u8 = if (uri.port) |p|
        std.fmt.bufPrint(&port_buf, "{d}", .{p}) catch return state.packError(1)
    else "";

    var host_buf: [256]u8 = undefined;
    const host_str: []const u8 = if (uri.port != null)
        std.fmt.bufPrint(&host_buf, "{s}:{s}", .{ hostname_raw, port_str }) catch return state.packError(1)
    else hostname_raw;

    const search_str: []const u8 = if (query_raw) |q| blk: {
        const s = allocator.alloc(u8, 1 + q.len) catch return state.packError(1);
        s[0] = '?'; @memcpy(s[1..], q);
        break :blk s;
    } else "";
    defer if (query_raw != null) allocator.free(search_str);

    const hash_str: []const u8 = if (fragment_raw) |f| blk: {
        const h = allocator.alloc(u8, 1 + f.len) catch return state.packError(1);
        h[0] = '#'; @memcpy(h[1..], f);
        break :blk h;
    } else "";
    defer if (fragment_raw != null) allocator.free(hash_str);

    var json_buf: std.ArrayListUnmanaged(u8) = .{};
    defer json_buf.deinit(allocator);
    const w = json_buf.writer(allocator);
    w.writeAll("{") catch return state.packError(1);
    jsonWriteStringField(w, "href", url_str) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "scheme", scheme) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "protocol", protocol) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "host", host_str) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "hostname", hostname_raw) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "port", port_str) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "pathname", if (path_raw.len > 0) path_raw else "/") catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "search", search_str) catch return state.packError(1);
    w.writeAll(",") catch return state.packError(1);
    jsonWriteStringField(w, "hash", hash_str) catch return state.packError(1);
    w.writeAll(",\"auth\":null}") catch return state.packError(1);
    const json_bytes = allocator.dupe(u8, json_buf.items) catch return state.packError(1);
    return state.handOff(json_bytes);
}
