//! npm_lockfile_abi.zig — semver select, npm metadata parse, lockfile I/O,
//! npm resolve graph, and async install protocol.

const std = @import("std");
const state = @import("state.zig");
const extras = @import("extras_abi.zig");
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// bun_semver_select
// ──────────────────────────────────────────────────────────

pub fn semverSelectImpl(
    versions_ptr: [*]const u8, versions_len: u32,
    range_ptr: [*]const u8, range_len: u32,
) u64 {
    if (!state.initialized) return state.packError(1);
    const versions_json = versions_ptr[0..versions_len];
    const range_str = range_ptr[0..range_len];
    return semverSelect(versions_json, range_str) catch state.packError(1);
}

fn semverSelect(versions_json: []const u8, range_str: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, versions_json, .{});
    defer parsed.deinit();
    const arr = switch (parsed.value) { .array => |a| a, else => return state.packError(1) };
    var ver_list: std.ArrayList([]const u8) = .empty;
    defer ver_list.deinit(allocator);
    for (arr.items) |item| {
        const ver_str = switch (item) { .string => |s| s, else => continue };
        try ver_list.append(allocator, ver_str);
    }
    const chosen = state.semverSelectFromList(ver_list.items, range_str) catch return state.packError(1);
    const buf = try allocator.dupe(u8, chosen);
    return state.handOff(buf);
}

// ──────────────────────────────────────────────────────────
// bun_npm_parse_metadata
// ──────────────────────────────────────────────────────────

pub fn npmParseMetadataImpl(
    json_ptr: [*]const u8, json_len: u32,
    range_ptr: [*]const u8, range_len: u32,
) u64 {
    if (!state.initialized) return state.packError(2);
    const json_bytes = json_ptr[0..json_len];
    const range_str = range_ptr[0..range_len];
    return npmParseMetadata(json_bytes, range_str) catch |err| switch (err) {
        error.NoMatch => state.packError(3),
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
}

fn isVersionLike(s: []const u8) bool {
    if (s.len == 0) return false;
    const c = s[0];
    return (c >= '0' and c <= '9') or c == '^' or c == '~' or
        c == '>' or c == '<' or c == '=' or c == '*' or c == 'x' or c == 'X';
}

fn npmParseMetadata(json_bytes: []const u8, range_str: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json_bytes, .{
        .duplicate_field_behavior = .use_last,
    });
    defer parsed.deinit();

    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const versions_obj = switch (root.get("versions") orelse return error.SyntaxError) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    const dist_tags_opt: ?std.json.ObjectMap = if (root.get("dist-tags")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    var effective_range_buf: [256]u8 = undefined;
    var effective_range: []const u8 = std.mem.trim(u8, range_str, " \t");

    if (effective_range.len == 0 or
        std.mem.eql(u8, effective_range, "*") or
        std.mem.eql(u8, effective_range, "x") or
        std.mem.eql(u8, effective_range, "X"))
    {
        if (dist_tags_opt) |dt| {
            if (dt.get("latest")) |lv| {
                if (lv == .string and lv.string.len < effective_range_buf.len) {
                    @memcpy(effective_range_buf[0..lv.string.len], lv.string);
                    effective_range = effective_range_buf[0..lv.string.len];
                }
            }
        }
        if (effective_range.len == 0) effective_range = "*";
    } else if (!isVersionLike(effective_range)) {
        if (dist_tags_opt) |dt| {
            if (dt.get(effective_range)) |tv| {
                if (tv == .string and tv.string.len < effective_range_buf.len) {
                    @memcpy(effective_range_buf[0..tv.string.len], tv.string);
                    effective_range = effective_range_buf[0..tv.string.len];
                }
            }
        }
    }

    var ver_list: std.ArrayList([]const u8) = .empty;
    defer ver_list.deinit(allocator);
    {
        var it = versions_obj.iterator();
        while (it.next()) |entry| try ver_list.append(allocator, entry.key_ptr.*);
    }

    const chosen_ver: []const u8 = blk: {
        if (versions_obj.get(effective_range) != null) break :blk effective_range;
        break :blk state.semverSelectFromList(ver_list.items, effective_range) catch |e| switch (e) {
            error.NoMatch => return error.NoMatch,
            else => return e,
        };
    };

    const ver_meta = switch (versions_obj.get(chosen_ver) orelse return error.NoMatch) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    const dist_opt: ?std.json.ObjectMap = if (ver_meta.get("dist")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    const tarball: []const u8 = if (dist_opt) |d| switch (d.get("tarball") orelse .null) { .string => |s| s, else => "" } else "";
    const integrity: []const u8 = if (dist_opt) |d| switch (d.get("integrity") orelse .null) { .string => |s| s, else => "" } else "";
    const shasum: []const u8 = if (dist_opt) |d| switch (d.get("shasum") orelse .null) { .string => |s| s, else => "" } else "";

    const deps_opt: ?std.json.ObjectMap = if (ver_meta.get("dependencies")) |v| switch (v) {
        .object => |o| o,
        else => null,
    } else null;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{\"version\":");
    try state.jsonEscapeTo(&out, chosen_ver);
    try out.appendSlice(allocator, ",\"tarball\":");
    try state.jsonEscapeTo(&out, tarball);
    if (integrity.len > 0) {
        try out.appendSlice(allocator, ",\"integrity\":");
        try state.jsonEscapeTo(&out, integrity);
    }
    if (shasum.len > 0) {
        try out.appendSlice(allocator, ",\"shasum\":");
        try state.jsonEscapeTo(&out, shasum);
    }
    try out.appendSlice(allocator, ",\"dependencies\":{");
    if (deps_opt) |deps| {
        var dep_it = deps.iterator();
        var first = true;
        while (dep_it.next()) |dep_entry| {
            if (!first) try out.append(allocator, ',');
            first = false;
            try state.jsonEscapeTo(&out, dep_entry.key_ptr.*);
            try out.append(allocator, ':');
            const dep_range = switch (dep_entry.value_ptr.*) { .string => |s| s, else => "*" };
            try state.jsonEscapeTo(&out, dep_range);
        }
    }
    try out.appendSlice(allocator, "}}");
    return state.handOff(try out.toOwnedSlice(allocator));
}

// ──────────────────────────────────────────────────────────
// bun_lockfile_parse
// ──────────────────────────────────────────────────────────

pub fn lockfileParseImpl(src_ptr: [*]const u8, src_len: u32) u64 {
    if (!state.initialized) return state.packError(1);
    const raw = src_ptr[0..src_len];

    const preprocessed = state.stripTrailingCommas(allocator, raw) catch return state.packError(1);
    defer allocator.free(preprocessed);

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, preprocessed, .{
        .duplicate_field_behavior = .use_last,
    }) catch return state.packError(2);
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) return state.packError(2);

    const version_node = root.object.get("lockfileVersion") orelse return state.packError(3);
    const version_num: i64 = switch (version_node) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => return state.packError(3),
    };

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    state.appendFmt(&out, "{{\"lockfileVersion\":{d}", .{version_num}) catch return state.packError(1);

    var workspace_count: usize = 0;
    if (root.object.get("workspaces")) |ws| switch (ws) {
        .object => |obj| workspace_count = obj.count(),
        else => {},
    };
    state.appendFmt(&out, ",\"workspaceCount\":{d}", .{workspace_count}) catch return state.packError(1);

    var package_count: usize = 0;
    if (root.object.get("packages")) |pkgs| switch (pkgs) {
        .object => |obj| package_count = obj.count(),
        else => {},
    };
    state.appendFmt(&out, ",\"packageCount\":{d},\"packages\":[", .{package_count}) catch return state.packError(1);

    if (root.object.get("packages")) |pkgs| if (pkgs == .object) {
        var it = pkgs.object.iterator();
        var first = true;
        while (it.next()) |entry| {
            if (!first) out.append(allocator, ',') catch return state.packError(1);
            first = false;
            const key = entry.key_ptr.*;
            var pkg_name: []const u8 = key;
            var pkg_version: []const u8 = "";
            if (entry.value_ptr.* == .array and
                entry.value_ptr.array.items.len >= 1 and
                entry.value_ptr.array.items[0] == .string)
            {
                const spec = entry.value_ptr.array.items[0].string;
                if (std.mem.lastIndexOfScalar(u8, spec, '@')) |at| {
                    if (at > 0) { pkg_name = spec[0..at]; pkg_version = spec[at + 1 ..]; }
                }
            }
            out.appendSlice(allocator, "{\"key\":") catch return state.packError(1);
            state.jsonEscapeTo(&out, key) catch return state.packError(1);
            out.appendSlice(allocator, ",\"name\":") catch return state.packError(1);
            state.jsonEscapeTo(&out, pkg_name) catch return state.packError(1);
            out.appendSlice(allocator, ",\"version\":") catch return state.packError(1);
            state.jsonEscapeTo(&out, pkg_version) catch return state.packError(1);
            out.append(allocator, '}') catch return state.packError(1);
        }
    };

    out.appendSlice(allocator, "]}") catch return state.packError(1);
    return state.handOff(out.toOwnedSlice(allocator) catch return state.packError(1));
}

// ──────────────────────────────────────────────────────────
// bun_lockfile_write
// ──────────────────────────────────────────────────────────

pub fn lockfileWriteImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!state.initialized) return state.packError(2);
    const input = input_ptr[0..input_len];
    return lockfileWrite(input) catch |e| switch (e) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
}

fn lockfileWrite(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const pkgs_arr: std.json.Array = switch (root.get("packages") orelse .null) {
        .array => |a| a,
        else => return error.SyntaxError,
    };
    const workspace_count: i64 = if (root.get("workspaceCount")) |wc| switch (wc) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => 1,
    } else 1;
    _ = workspace_count;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator,
        "{\n  \"lockfileVersion\": 0,\n  \"workspaces\": {\n    \"\": {\n      \"name\": \"\"\n    }\n  },\n");
    try out.appendSlice(allocator, "  \"packages\": {\n");

    for (pkgs_arr.items, 0..) |item, idx| {
        if (item != .object) continue;
        const pkg = item.object;
        const key = switch (pkg.get("key") orelse .null) { .string => |s| s, else => continue };
        const name = switch (pkg.get("name") orelse .null) { .string => |s| s, else => continue };
        const ver = switch (pkg.get("version") orelse .null) { .string => |s| s, else => continue };
        if (idx > 0) try out.appendSlice(allocator, ",\n");
        try out.appendSlice(allocator, "    ");
        try state.jsonEscapeTo(&out, key);
        try out.appendSlice(allocator, ": [\"");
        try out.appendSlice(allocator, name);
        try out.append(allocator, '@');
        try out.appendSlice(allocator, ver);
        try out.appendSlice(allocator, "\", {}]");
    }
    try out.appendSlice(allocator, "\n  }\n}\n");
    return state.handOff(try out.toOwnedSlice(allocator));
}

// ──────────────────────────────────────────────────────────
// bun_npm_resolve_graph
// ──────────────────────────────────────────────────────────

/// T5.10.4: Dependency version tag — mirrors `src/install/dependency.zig`
/// `Dependency.Version.Tag` but without JSC serialization methods.
const DepVersionTag = enum {
    /// npm registry semver range: `^1.2.3`, `>=1.0.0`, `*`, etc.
    npm,
    /// dist-tag: `latest`, `next`, `beta`, etc.
    dist_tag,
    /// git protocol: `git://`, `git+https://`, `git+ssh://`
    git,
    /// GitHub shorthand: `github:owner/repo` or bare `owner/repo`
    github,
    /// Remote tarball URL ending in `.tar.gz`/`.tgz`
    tarball,
    /// Local folder: `file:../path`
    folder,
    /// Symlink: `link:../path`
    symlink,
    /// Workspace reference: `workspace:*`
    workspace,
};

fn classifyRange(range: []const u8) DepVersionTag {
    if (std.mem.startsWith(u8, range, "workspace:")) return .workspace;
    if (std.mem.startsWith(u8, range, "file:")) return .folder;
    if (std.mem.startsWith(u8, range, "link:")) return .symlink;
    if (std.mem.startsWith(u8, range, "github:")) return .github;
    if (std.mem.startsWith(u8, range, "git://") or
        std.mem.startsWith(u8, range, "git+")) return .git;
    if (std.mem.startsWith(u8, range, "http://") or
        std.mem.startsWith(u8, range, "https://"))
    {
        return if (std.mem.endsWith(u8, range, ".tar.gz") or
            std.mem.endsWith(u8, range, ".tgz")) .tarball else .git;
    }
    // Bare `owner/repo` shorthand: contains "/" but no "@"-prefix and no "://"
    if (range.len > 1 and range[0] != '@' and
        std.mem.indexOfScalar(u8, range, '/') != null and
        std.mem.indexOf(u8, range, "://") == null) return .github;
    // Semver indicators at start
    if (range.len > 0) {
        const c = range[0];
        if (std.ascii.isDigit(c) or c == '^' or c == '~' or
            c == '*' or c == '>' or c == '<' or c == '=' or c == 'v')
            return .npm;
    }
    return .dist_tag;
}

pub fn npmResolveGraphImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!state.initialized) return state.packError(2);
    const input = input_ptr[0..input_len];
    return npmResolveGraph(input) catch |e| switch (e) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
}

fn npmResolveGraph(input: []const u8) !u64 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{
        .duplicate_field_behavior = .use_last,
    });
    defer parsed.deinit();

    const root = switch (parsed.value) { .object => |o| o, else => return error.SyntaxError };

    const top_deps: std.json.ObjectMap = switch (root.get("deps") orelse .null) {
        .object => |o| o,
        else => return error.SyntaxError,
    };

    const meta_map: std.json.ObjectMap = switch (root.get("metadata") orelse std.json.Value.null) {
        .object => |o| o,
        else => std.json.ObjectMap.init(allocator),
    };

    const QueueItem = struct { name: []const u8, range: []const u8 };
    var queue: std.ArrayListUnmanaged(QueueItem) = .empty;
    defer queue.deinit(allocator);
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    var resolved: std.ArrayListUnmanaged(u8) = .empty;
    defer resolved.deinit(allocator);
    var missing: std.ArrayListUnmanaged(u8) = .empty;
    defer missing.deinit(allocator);

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

        // T5.10.4: Skip non-registry dependency types (git, folder, symlink, etc.).
        // These have no npm registry metadata — include as resolved with range as version.
        switch (classifyRange(item.range)) {
            .workspace, .folder, .symlink, .git, .github, .tarball => {
                if (resolved_count > 0) try resolved.append(allocator, ',');
                try resolved.appendSlice(allocator, "{\"name\":");
                try state.jsonEscapeTo2(&resolved, allocator, item.name);
                try resolved.appendSlice(allocator, ",\"version\":");
                try state.jsonEscapeTo2(&resolved, allocator, item.range);
                try resolved.appendSlice(allocator, ",\"tarball\":\"\",\"dependencies\":{}}");
                resolved_count += 1;
                continue;
            },
            .npm, .dist_tag => {},
        }

        const meta_val = meta_map.get(item.name) orelse {
            if (missing_count > 0) try missing.append(allocator, ',');
            try state.jsonEscapeTo2(&missing, allocator, item.name);
            missing_count += 1;
            continue;
        };
        const meta_json: []const u8 = switch (meta_val) { .string => |s| s, else => continue };

        const result_packed = npmParseMetadata(meta_json, item.range) catch continue;
        const out_ptr = @as(u32, @truncate(result_packed >> 32));
        const out_len = @as(u32, @truncate(result_packed & 0xffffffff));
        if (out_ptr == 0) continue;

        const result_slice = @as([*]const u8, @ptrFromInt(out_ptr))[0..out_len];
        if (resolved_count > 0) try resolved.append(allocator, ',');
        try resolved.appendSlice(allocator, "{\"name\":");
        try state.jsonEscapeTo2(&resolved, allocator, item.name);
        try resolved.append(allocator, ',');
        if (result_slice.len > 1) {
            try resolved.appendSlice(allocator, result_slice[1..]);
        } else {
            try resolved.append(allocator, '}');
        }
        resolved_count += 1;

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
        allocator.free(result_slice);
    }

    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"resolved\":[");
    try out.appendSlice(allocator, resolved.items);
    try out.appendSlice(allocator, "],\"missing\":[");
    try out.appendSlice(allocator, missing.items);
    try out.appendSlice(allocator, "]}");
    return state.handOff(try allocator.dupe(u8, out.items));
}

// ──────────────────────────────────────────────────────────
// Async install protocol
// ──────────────────────────────────────────────────────────

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

pub var g_install_state: ?InstallState = null;

pub const InstallState = struct {
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

pub fn npmInstallBeginImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!state.initialized) return state.packError(2);
    if (g_install_state) |*old| { old.deinit(); g_install_state = null; }
    const input = input_ptr[0..input_len];
    return npmInstallBegin(input) catch |e| switch (e) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
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

    var ist = InstallState{
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
    errdefer ist.deinit();

    {
        var it = deps_obj.iterator();
        while (it.next()) |entry| {
            const name_dup = try allocator.dupe(u8, entry.key_ptr.*);
            const rng_str: []const u8 = switch (entry.value_ptr.*) { .string => |s| s, else => "*" };
            const range_dup = try allocator.dupe(u8, rng_str);
            const url = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ registry, name_dup });
            try ist.fetch_queue.append(allocator, .{
                .id = ist.next_id,
                .url = url,
                .fetch_type = .metadata,
                .name = name_dup,
                .range = range_dup,
            });
            ist.next_id += 1;
        }
    }

    g_install_state = ist;
    return npmNeedFetchInternal() catch return state.packError(1);
}

pub fn npmNeedFetchImpl() u64 {
    return npmNeedFetchInternal() catch state.packError(1);
}

fn npmNeedFetchInternal() !u64 {
    const ist = if (g_install_state) |*s| s else return @as(u64, 0);
    if (ist.fetch_queue.items.len == 0) return @as(u64, 0);
    const pf = ist.fetch_queue.items[0];

    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    try out.appendSlice(allocator, "{\"id\":");
    var id_buf: [16]u8 = undefined;
    try out.appendSlice(allocator, std.fmt.bufPrint(&id_buf, "{d}", .{pf.id}) catch unreachable);
    try out.appendSlice(allocator, ",\"url\":");
    try state.jsonEscapeTo(&out, pf.url);
    try out.appendSlice(allocator, ",\"type\":");
    try state.jsonEscapeTo(&out, if (pf.fetch_type == .metadata) "metadata" else "tarball");
    try out.appendSlice(allocator, ",\"name\":");
    try state.jsonEscapeTo(&out, pf.name);
    try out.appendSlice(allocator, ",\"range\":");
    try state.jsonEscapeTo(&out, pf.range);
    try out.append(allocator, '}');
    return state.handOff(try allocator.dupe(u8, out.items));
}

pub fn npmFeedResponseImpl(req_id: u32, data_ptr: [*]const u8, data_len: u32) u64 {
    const ist = if (g_install_state) |*s| s else return state.packError(3);
    const data = data_ptr[0..data_len];

    var found: ?PendingFetch = null;
    for (ist.fetch_queue.items, 0..) |pf, i| {
        if (pf.id == req_id) { found = pf; _ = ist.fetch_queue.orderedRemove(i); break; }
    }
    const pf = found orelse return state.packError(3);
    defer allocator.free(pf.url);

    if (pf.fetch_type == .metadata) {
        const result = npmParseMetadata(data, pf.range) catch {
            allocator.free(pf.name);
            allocator.free(pf.range);
            return 0;
        };
        const out_ptr = @as(u32, @truncate(result >> 32));
        const out_len = @as(u32, @truncate(result & 0xffffffff));

        if (out_ptr == 0) {
            if (ist.missing_count > 0) ist.missing_json.append(allocator, ',') catch {};
            state.jsonEscapeTo2(&ist.missing_json, allocator, pf.name) catch {};
            ist.missing_count += 1;
            allocator.free(pf.name);
            allocator.free(pf.range);
            return 0;
        }

        const result_slice = @as([*]const u8, @ptrFromInt(out_ptr))[0..out_len];
        defer allocator.free(result_slice);

        if (ist.resolved_count > 0) ist.resolved_json.append(allocator, ',') catch {};
        ist.resolved_json.appendSlice(allocator, "{\"name\":") catch {
            allocator.free(pf.name); allocator.free(pf.range); return state.packError(1);
        };
        state.jsonEscapeTo2(&ist.resolved_json, allocator, pf.name) catch {};
        if (result_slice.len > 1) {
            ist.resolved_json.append(allocator, ',') catch {};
            ist.resolved_json.appendSlice(allocator, result_slice[1..]) catch {};
        } else {
            ist.resolved_json.append(allocator, '}') catch {};
        }
        ist.resolved_count += 1;

        const tarball_url_val: ?[]u8 = blk: {
            var sub = std.json.parseFromSlice(std.json.Value, allocator, result_slice, .{}) catch break :blk null;
            defer sub.deinit();
            if (sub.value == .object) {
                if (sub.value.object.get("tarball")) |tv| {
                    if (tv == .string) break :blk allocator.dupe(u8, tv.string) catch null;
                }
                if (sub.value.object.get("dependencies")) |dv| {
                    if (dv == .object) {
                        var dep_it = dv.object.iterator();
                        while (dep_it.next()) |dep_entry| {
                            const dname = dep_entry.key_ptr.*;
                            if (!ist.seen.contains(dname)) {
                                const url2 = std.fmt.allocPrint(allocator, "https://registry.npmjs.org/{s}", .{dname}) catch continue;
                                const rng2: []const u8 = switch (dep_entry.value_ptr.*) { .string => |s| s, else => "*" };
                                const nm2 = allocator.dupe(u8, dname) catch { allocator.free(url2); continue; };
                                const rng2_dup = allocator.dupe(u8, rng2) catch { allocator.free(url2); allocator.free(nm2); continue; };
                                ist.fetch_queue.append(allocator, .{
                                    .id = ist.next_id,
                                    .url = url2,
                                    .fetch_type = .metadata,
                                    .name = nm2,
                                    .range = rng2_dup,
                                }) catch { allocator.free(url2); allocator.free(nm2); allocator.free(rng2_dup); };
                                ist.next_id += 1;
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
            ist.fetch_queue.append(allocator, .{
                .id = ist.next_id,
                .url = turl,
                .fetch_type = .tarball,
                .name = name_dup2,
                .range = rng_dup2,
            }) catch { allocator.free(turl); allocator.free(name_dup2); allocator.free(rng_dup2); };
            ist.next_id += 1;
        }
        allocator.free(pf.name);
        allocator.free(pf.range);
    } else {
        // Tarball: extract into VFS
        const prefix = std.fmt.allocPrint(allocator, "/node_modules/{s}", .{pf.name}) catch {
            allocator.free(pf.name); allocator.free(pf.range); return state.packError(1);
        };
        defer allocator.free(prefix);

        const prefix_len: u32 = @intCast(prefix.len);
        var packed_input: std.ArrayList(u8) = .empty;
        defer packed_input.deinit(allocator);
        var plen_buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &plen_buf, prefix_len, .little);
        packed_input.appendSlice(allocator, &plen_buf) catch { allocator.free(pf.name); allocator.free(pf.range); return state.packError(1); };
        packed_input.appendSlice(allocator, prefix) catch { allocator.free(pf.name); allocator.free(pf.range); return state.packError(1); };
        packed_input.appendSlice(allocator, data) catch { allocator.free(pf.name); allocator.free(pf.range); return state.packError(1); };

        _ = extras.tgzExtractImpl(packed_input.items.ptr, @intCast(packed_input.items.len));
        allocator.free(pf.name);
        allocator.free(pf.range);
    }

    return 0;
}

pub fn npmInstallMarkSeenImpl(name_ptr: [*]const u8, name_len: u32) void {
    const ist = if (g_install_state) |*s| s else return;
    const name = allocator.dupe(u8, name_ptr[0..name_len]) catch return;
    ist.seen.put(name, {}) catch { allocator.free(name); };
}

pub fn npmInstallResultImpl() u64 {
    const ist = if (g_install_state) |*s| s else return state.packError(2);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    defer out.deinit(allocator);
    out.appendSlice(allocator, "{\"resolved\":[") catch return state.packError(1);
    out.appendSlice(allocator, ist.resolved_json.items) catch return state.packError(1);
    out.appendSlice(allocator, "],\"missing\":[") catch return state.packError(1);
    out.appendSlice(allocator, ist.missing_json.items) catch return state.packError(1);
    out.appendSlice(allocator, "]}") catch return state.packError(1);
    return state.handOff(allocator.dupe(u8, out.items) catch return state.packError(1));
}

pub fn npmInstallEndImpl() void {
    if (g_install_state) |*s| { s.deinit(); g_install_state = null; }
}
