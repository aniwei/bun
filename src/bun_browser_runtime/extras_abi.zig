//! extras_abi.zig — integrity, hash, base64, inflate, tgz, sourcemap, HTML, brace, shell, glob.

const std = @import("std");
const state = @import("state.zig");
const VLQ = @import("../sourcemap/VLQ.zig");
const Integrity = @import("../install/integrity.zig").Integrity;
const globMatch = @import("../glob/match.zig").match;
const allocator = state.allocator;

// ──────────────────────────────────────────────────────────
// bun_integrity_verify
// ──────────────────────────────────────────────────────────

pub fn integrityVerifyImpl(
    data_ptr: [*]const u8, data_len: u32,
    integrity_ptr: [*]const u8, integrity_len: u32,
) u32 {
    return integrityVerify(data_ptr[0..data_len], integrity_ptr[0..integrity_len]);
}

// ──────────────────────────────────────────────────────────
// bun_glob_match
// ──────────────────────────────────────────────────────────

/// Returns 1 if `path` matches `glob`, 0 otherwise.
pub fn globMatchImpl(
    glob_ptr: [*]const u8, glob_len: u32,
    path_ptr: [*]const u8, path_len: u32,
) u32 {
    const result = globMatch(glob_ptr[0..glob_len], path_ptr[0..path_len]);
    return @intFromBool(result.matches());
}

fn integrityVerify(data: []const u8, sri: []const u8) u32 {
    if (sri.len == 0) return 0;

    // npm metadata may provide legacy sha1 hex in `shasum` form.
    if (std.mem.indexOfScalar(u8, sri, '-') == null) {
        if (sri.len != 40) return 2;
        const expected = Integrity.parseSHASum(sri) catch return 2;
        return if (expected.verify(data)) 0 else 1;
    }

    const tag, const payload_offset = Integrity.Tag.parse(sri);
    if (tag == .unknown) {
        // Forward-compatible: unsupported algorithms are treated as pass.
        return 0;
    }

    // Keep existing wasm API semantics: malformed SRI for supported tags is `bad`.
    const payload = std.mem.trimRight(u8, sri[payload_offset..], "=");
    const decoded_size = std.base64.standard_no_pad.Decoder.calcSizeForSlice(payload) catch {
        return 2;
    };
    if (decoded_size != tag.digestLen()) return 2;

    const expected = Integrity.parse(sri);
    if (expected.tag == .unknown) return 2;

    return if (expected.verify(data)) 0 else 1;
}

// ──────────────────────────────────────────────────────────
// bun_hash
// ──────────────────────────────────────────────────────────

pub fn hashImpl(data_ptr: [*]const u8, data_len: u32, algo: u32) u64 {
    const data = data_ptr[0..data_len];
    const digest = doHash(algo, data) catch |err| return switch (err) {
        error.OutOfMemory => state.packError(1),
        error.UnknownAlgo => state.packError(2),
    };
    return state.handOff(digest);
}

fn doHash(algo: u32, data: []const u8) error{ OutOfMemory, UnknownAlgo }![]u8 {
    return switch (algo) {
        0 => blk: {
            var d: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
            std.crypto.hash.Sha1.hash(data, &d, .{});
            break :blk try allocator.dupe(u8, &d);
        },
        1 => blk: {
            var d: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(data, &d, .{});
            break :blk try allocator.dupe(u8, &d);
        },
        2 => blk: {
            var d: [std.crypto.hash.sha2.Sha512.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha512.hash(data, &d, .{});
            break :blk try allocator.dupe(u8, &d);
        },
        3 => blk: {
            var d: [std.crypto.hash.sha2.Sha384.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha384.hash(data, &d, .{});
            break :blk try allocator.dupe(u8, &d);
        },
        4 => blk: {
            var d: [std.crypto.hash.Md5.digest_length]u8 = undefined;
            std.crypto.hash.Md5.hash(data, &d, .{});
            break :blk try allocator.dupe(u8, &d);
        },
        else => error.UnknownAlgo,
    };
}

// ──────────────────────────────────────────────────────────
// bun_base64_encode / bun_base64_decode
// ──────────────────────────────────────────────────────────

pub fn base64EncodeImpl(data_ptr: [*]const u8, data_len: u32) u64 {
    const data = data_ptr[0..data_len];
    const enc_len = std.base64.standard.Encoder.calcSize(data.len);
    const buf = allocator.alloc(u8, enc_len) catch return state.packError(1);
    _ = std.base64.standard.Encoder.encode(buf, data);
    return state.handOff(buf);
}

pub fn base64DecodeImpl(data_ptr: [*]const u8, data_len: u32) u64 {
    const data = data_ptr[0..data_len];
    const decoded = base64DecodeSlice(data) catch |err| return switch (err) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
    return state.handOff(decoded);
}

fn base64DecodeSlice(data: []const u8) ![]u8 {
    const stripped = std.mem.trimRight(u8, data, "=");
    const Dec = std.base64.standard_no_pad.Decoder;
    const decoded_size = try Dec.calcSizeForSlice(stripped);
    const buf = try allocator.alloc(u8, decoded_size);
    errdefer allocator.free(buf);
    try Dec.decode(buf, stripped);
    return buf;
}

// ──────────────────────────────────────────────────────────
// bun_inflate
// ──────────────────────────────────────────────────────────

pub fn inflateImpl(src_ptr: [*]const u8, src_len: u32, format: u32) u64 {
    const src = src_ptr[0..src_len];
    const decompressed = state.inflateImpl(src, format) catch |err| return switch (err) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
    return state.handOff(decompressed);
}

// ──────────────────────────────────────────────────────────
// bun_tgz_extract
// ──────────────────────────────────────────────────────────

const TAR_BLOCK: usize = 512;

pub fn tgzExtractImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (input_len < 4) return state.packError(3);
    const buf = input_ptr[0..input_len];
    const prefix_len = std.mem.readInt(u32, buf[0..4], .little);
    if (4 + prefix_len > input_len) return state.packError(3);
    const prefix = buf[4 .. 4 + prefix_len];
    const tgz = buf[4 + prefix_len .. input_len];

    const tar = state.inflateImpl(tgz, 0) catch return state.packError(2);
    defer allocator.free(tar);

    var off: usize = 0;
    var extracted: u32 = 0;

    var gnu_name_buf: [4096]u8 = undefined;
    var gnu_name_len: usize = 0;
    var pax_name_buf: [4096]u8 = undefined;
    var pax_name_len: usize = 0;
    var ustar_path_buf: [4096]u8 = undefined;

    while (off + TAR_BLOCK <= tar.len) {
        const header = tar[off .. off + TAR_BLOCK];
        var all_zero = true;
        for (header) |c| { if (c != 0) { all_zero = false; break; } }
        if (all_zero) { off += TAR_BLOCK; continue; }

        const size: usize = @intCast(tarReadOctal(header[124..136]));
        const type_flag = header[156];
        const data_start = off + TAR_BLOCK;
        const padded = ((size + TAR_BLOCK - 1) / TAR_BLOCK) * TAR_BLOCK;
        const next_off = data_start + padded;

        if (data_start + size > tar.len) break;
        const data = tar[data_start .. data_start + size];
        off = next_off;

        switch (type_flag) {
            'L' => {
                const n = @min(size, gnu_name_buf.len);
                @memcpy(gnu_name_buf[0..n], data[0..n]);
                gnu_name_len = n;
                while (gnu_name_len > 0 and gnu_name_buf[gnu_name_len - 1] == 0) gnu_name_len -= 1;
                continue;
            },
            'x' => {
                if (tarParsePaxPath(data)) |pname| {
                    const n = @min(pname.len, pax_name_buf.len);
                    @memcpy(pax_name_buf[0..n], pname[0..n]);
                    pax_name_len = n;
                }
                continue;
            },
            'g' => { continue; },
            '5' => { gnu_name_len = 0; pax_name_len = 0; continue; },
            '0', '7', 0 => {},
            else => { gnu_name_len = 0; pax_name_len = 0; continue; },
        }

        const name_raw: []const u8 = name_blk: {
            if (pax_name_len > 0) {
                const n = pax_name_len; pax_name_len = 0; gnu_name_len = 0;
                break :name_blk pax_name_buf[0..n];
            }
            if (gnu_name_len > 0) {
                const n = gnu_name_len; gnu_name_len = 0;
                break :name_blk gnu_name_buf[0..n];
            }
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

        const stripped = tarStripFirstComponent(name_raw);
        if (stripped.len == 0) continue;

        const full_path = state.joinPath(allocator, prefix, stripped) catch return state.packError(1);
        defer allocator.free(full_path);

        if (std.mem.lastIndexOfScalar(u8, full_path, '/')) |last_slash| {
            if (last_slash > 0) {
                state.vfs_g.mkdirp(full_path[0..last_slash]) catch {};
            }
        }
        state.vfs_g.writeFile(full_path, data, 0o644) catch return state.packError(1);
        extracted += 1;
    }

    var result: std.ArrayListUnmanaged(u8) = .{};
    defer result.deinit(allocator);
    var buf2: [32]u8 = undefined;
    const n_str = std.fmt.bufPrint(&buf2, "{{\"extracted\":{d}}}", .{extracted}) catch return state.packError(1);
    result.appendSlice(allocator, n_str) catch return state.packError(1);
    const out = allocator.dupe(u8, result.items) catch return state.packError(1);
    return state.handOff(out);
}

fn tarReadOctal(buf: []const u8) u64 {
    var result: u64 = 0;
    for (buf) |c| {
        if (c == 0 or c == ' ') break;
        if (c >= '0' and c <= '7') result = result *% 8 +% @as(u64, c - '0');
    }
    return result;
}

fn tarReadStr(buf: []const u8) []const u8 {
    for (buf, 0..) |c, i| { if (c == 0) return buf[0..i]; }
    return buf;
}

fn tarStripFirstComponent(path: []const u8) []const u8 {
    const slash = std.mem.indexOfScalar(u8, path, '/') orelse return path;
    return if (slash + 1 < path.len) path[slash + 1 ..] else "";
}

fn tarParsePaxPath(data: []const u8) ?[]const u8 {
    var off: usize = 0;
    while (off < data.len) {
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

// ──────────────────────────────────────────────────────────
// bun_sourcemap_lookup
// ──────────────────────────────────────────────────────────

pub fn sourcemapLookupImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!state.initialized) return state.packError(2);
    const input = input_ptr[0..input_len];
    return sourcemapLookup(input) catch |e| switch (e) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
}

fn vlqDecode(data: []const u8, off: *usize) ?i32 {
    if (off.* >= data.len) return null;
    const first = data[off.*];
    const valid = switch (first) {
        'A'...'Z', 'a'...'z', '0'...'9', '+', '/' => true,
        else => false,
    };
    if (!valid) return null;
    const res = VLQ.decode(data, off.*);
    if (res.start == off.*) return null;
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
    const map_json: []const u8 = switch (map_val) { .string => |s| s, else => return error.SyntaxError };

    const smap = try std.json.parseFromSlice(std.json.Value, allocator, map_json, .{});
    defer smap.deinit();
    const smap_root = switch (smap.value) { .object => |o| o, else => return error.SyntaxError };

    const sources_arr: []std.json.Value = switch (smap_root.get("sources") orelse .null) {
        .array => |a| a.items, else => &.{},
    };
    const names_arr: []std.json.Value = switch (smap_root.get("names") orelse .null) {
        .array => |a| a.items, else => &.{},
    };
    const mappings_str: []const u8 = switch (smap_root.get("mappings") orelse .null) {
        .string => |s| s, else => return error.SyntaxError,
    };

    var gen_line: i64 = 0;
    var src_idx: i32 = 0;
    var orig_line: i32 = 0;
    var orig_col: i32 = 0;
    var name_idx: i32 = 0;
    var best_src_idx: i32 = -1;
    var best_orig_line: i32 = 0;
    var best_orig_col: i32 = 0;
    var best_name_idx: i32 = -1;
    var best_gen_col: i64 = -1;
    var off: usize = 0;
    var seg_col: i32 = 0;

    while (off < mappings_str.len) {
        const c = mappings_str[off];
        if (c == ';') { gen_line += 1; seg_col = 0; off += 1; continue; }
        if (c == ',') { off += 1; continue; }
        const gen_col_delta = vlqDecode(mappings_str, &off) orelse { off += 1; continue; };
        seg_col += gen_col_delta;
        const cur_gen_col: i64 = seg_col;
        const saved_off = off;
        const si_delta = vlqDecode(mappings_str, &off);
        const ol_delta = if (si_delta != null) vlqDecode(mappings_str, &off) else null;
        const oc_delta = if (ol_delta != null) vlqDecode(mappings_str, &off) else null;
        const ni_delta = if (oc_delta != null) vlqDecode(mappings_str, &off) else null;
        if (si_delta != null and ol_delta != null and oc_delta != null) {
            src_idx += si_delta.?; orig_line += ol_delta.?; orig_col += oc_delta.?;
            if (ni_delta != null) name_idx += ni_delta.?;
        } else { off = saved_off; }
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

    var out: std.ArrayListUnmanaged(u8) = .{};
    defer out.deinit(allocator);
    if (best_src_idx < 0 or best_src_idx >= @as(i32, @intCast(sources_arr.len))) {
        try out.appendSlice(allocator, "{\"source\":null}");
    } else {
        const src_str: []const u8 = switch (sources_arr[@as(usize, @intCast(best_src_idx))]) {
            .string => |s| s, else => "",
        };
        try out.appendSlice(allocator, "{\"source\":");
        try state.jsonEscapeTo(&out, src_str);
        var num_buf: [16]u8 = undefined;
        try out.appendSlice(allocator, ",\"line\":");
        try out.appendSlice(allocator, std.fmt.bufPrint(&num_buf, "{d}", .{best_orig_line}) catch unreachable);
        try out.appendSlice(allocator, ",\"col\":");
        try out.appendSlice(allocator, std.fmt.bufPrint(&num_buf, "{d}", .{best_orig_col}) catch unreachable);
        if (best_name_idx >= 0 and best_name_idx < @as(i32, @intCast(names_arr.len))) {
            const name_str: []const u8 = switch (names_arr[@as(usize, @intCast(best_name_idx))]) {
                .string => |s| s, else => "",
            };
            try out.appendSlice(allocator, ",\"name\":");
            try state.jsonEscapeTo(&out, name_str);
        }
        try out.append(allocator, '}');
    }
    return state.handOff(try allocator.dupe(u8, out.items));
}

// ──────────────────────────────────────────────────────────
// bun_html_rewrite
// ──────────────────────────────────────────────────────────

pub fn htmlRewriteImpl(input_ptr: [*]const u8, input_len: u32) u64 {
    if (!state.initialized) return state.packError(2);
    const input = input_ptr[0..input_len];
    return htmlRewrite(input) catch |e| switch (e) {
        error.OutOfMemory => state.packError(1),
        else => state.packError(2),
    };
}

const HtmlRule = struct {
    tag: []const u8,
    attr_filter: ?[]const u8,
    attr_val_filter: ?[]const u8,
    op: enum { set_attr, set_text, remove },
    attr_target: []const u8,
    value: []const u8,
};

fn parseSelector(sel: []const u8, rule: *HtmlRule) void {
    if (std.mem.indexOfScalar(u8, sel, '[')) |bracket| {
        rule.tag = sel[0..bracket];
        const inner = if (sel[sel.len - 1] == ']') sel[bracket + 1 .. sel.len - 1] else sel[bracket + 1 ..];
        if (std.mem.indexOfScalar(u8, inner, '=')) |eq| {
            rule.attr_filter = inner[0..eq];
            var val = inner[eq + 1 ..];
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
        .string => |s| s, else => return error.SyntaxError,
    };
    const rules_arr: []std.json.Value = switch (root.get("rules") orelse .null) {
        .array => |a| a.items, else => &.{},
    };

    var rules = try allocator.alloc(HtmlRule, rules_arr.len);
    defer allocator.free(rules);
    var rule_count: usize = 0;
    for (rules_arr) |rv| {
        if (rv != .object) continue;
        const ro = rv.object;
        const sel: []const u8 = switch (ro.get("selector") orelse .null) { .string => |s| s, else => continue };
        var rule: HtmlRule = .{ .tag = "", .attr_filter = null, .attr_val_filter = null, .op = .remove, .attr_target = "", .value = "" };
        parseSelector(sel, &rule);
        if (ro.get("remove")) |rv2| {
            if (rv2 == .bool and rv2.bool) { rules[rule_count] = rule; rule_count += 1; continue; }
        }
        if (ro.get("attr")) |av| {
            if (av == .string) {
                rule.op = .set_attr;
                rule.attr_target = av.string;
                rule.value = switch (ro.get("replace") orelse .null) { .string => |s| s, else => "" };
                rules[rule_count] = rule; rule_count += 1; continue;
            }
        }
        if (ro.get("text")) |tv| {
            if (tv == .string) {
                rule.op = .set_text;
                rule.value = tv.string;
                rules[rule_count] = rule; rule_count += 1;
            }
        }
    }
    rules = rules[0..rule_count];

    var out: std.ArrayListUnmanaged(u8) = .{};
    defer out.deinit(allocator);
    var i: usize = 0;
    while (i < html.len) {
        if (html[i] != '<') { try out.append(allocator, html[i]); i += 1; continue; }
        const tag_start = i; i += 1;
        const is_close = i < html.len and html[i] == '/';
        if (is_close) i += 1;
        const tag_name_start = i;
        while (i < html.len and html[i] != ' ' and html[i] != '>' and html[i] != '/') i += 1;
        const tag_name = html[tag_name_start..i];
        while (i < html.len and html[i] != '>') i += 1;
        const tag_end = if (i < html.len) i + 1 else html.len;
        const tag_str = html[tag_start..tag_end];
        if (i < html.len) i += 1;
        if (tag_name.len == 0 or is_close) { try out.appendSlice(allocator, tag_str); continue; }

        var matched_rule: ?*const HtmlRule = null;
        for (rules) |*rule| {
            if (!std.mem.eql(u8, rule.tag, tag_name)) continue;
            if (rule.attr_filter) |af| {
                if (std.mem.indexOf(u8, tag_str, af) == null) continue;
                if (rule.attr_val_filter) |avf| {
                    if (std.mem.indexOf(u8, tag_str, avf) == null) continue;
                }
            }
            matched_rule = rule;
            break;
        }
        const rule = matched_rule orelse { try out.appendSlice(allocator, tag_str); continue; };
        switch (rule.op) {
            .remove => {
                const close_prefix = try std.fmt.allocPrint(allocator, "</{s}>", .{tag_name});
                defer allocator.free(close_prefix);
                if (std.mem.indexOf(u8, html[i..], close_prefix)) |close_rel| {
                    i += close_rel + close_prefix.len;
                }
            },
            .set_attr => {
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
                try out.appendSlice(allocator, tag_str);
                const close_prefix = try std.fmt.allocPrint(allocator, "</{s}>", .{tag_name});
                defer allocator.free(close_prefix);
                if (std.mem.indexOf(u8, html[i..], close_prefix)) |close_rel| {
                    try out.appendSlice(allocator, rule.value);
                    try out.appendSlice(allocator, close_prefix);
                    i += close_rel + close_prefix.len;
                }
            },
        }
    }
    return state.handOff(try allocator.dupe(u8, out.items));
}

// ──────────────────────────────────────────────────────────
// bun_brace_expand
// ──────────────────────────────────────────────────────────

pub fn braceExpandImpl(ptr: [*]const u8, len: u32) u64 {
    const src = ptr[0..len];
    var items: std.ArrayListUnmanaged([]u8) = .{};
    defer { for (items.items) |s| allocator.free(s); items.deinit(allocator); }
    braceExpandStr(allocator, src, &items) catch return state.packError(1);
    var out: std.ArrayListUnmanaged(u8) = .{};
    defer out.deinit(allocator);
    out.append(allocator, '[') catch return state.packError(1);
    for (items.items, 0..) |s, j| {
        if (j > 0) out.append(allocator, ',') catch return state.packError(1);
        state.jsonEscapeTo(&out, s) catch return state.packError(1);
    }
    out.append(allocator, ']') catch return state.packError(1);
    return state.handOff(out.toOwnedSlice(allocator) catch return state.packError(1));
}

fn braceExpandStr(alloc: std.mem.Allocator, src: []const u8, out: *std.ArrayListUnmanaged([]u8)) std.mem.Allocator.Error!void {
    const brace_open = findBraceOpen(src) orelse {
        try out.append(alloc, try alloc.dupe(u8, src));
        return;
    };
    const brace_close = findBraceClose(src, brace_open) orelse {
        try out.append(alloc, try alloc.dupe(u8, src));
        return;
    };
    const prefix = src[0..brace_open];
    const inside = src[brace_open + 1 .. brace_close];
    const suffix = src[brace_close + 1 ..];
    var alts: std.ArrayListUnmanaged([]const u8) = .{};
    defer alts.deinit(alloc);
    try splitByTopCommas(alloc, inside, &alts);
    if (alts.items.len < 2) { try out.append(alloc, try alloc.dupe(u8, src)); return; }
    for (alts.items) |alt| {
        const combined = try std.fmt.allocPrint(alloc, "{s}{s}{s}", .{ prefix, alt, suffix });
        defer alloc.free(combined);
        try braceExpandStr(alloc, combined, out);
    }
}

fn findBraceOpen(src: []const u8) ?usize {
    for (src, 0..) |c, j| { if (c == '{') return j; }
    return null;
}

fn findBraceClose(src: []const u8, open: usize) ?usize {
    var depth: usize = 0;
    var j: usize = open;
    while (j < src.len) : (j += 1) {
        switch (src[j]) {
            '{' => depth += 1,
            '}' => { depth -= 1; if (depth == 0) return j; },
            '\\' => j += 1,
            else => {},
        }
    }
    return null;
}

fn splitByTopCommas(alloc: std.mem.Allocator, src: []const u8, out: *std.ArrayListUnmanaged([]const u8)) !void {
    var depth: usize = 0;
    var start: usize = 0;
    var j: usize = 0;
    while (j < src.len) : (j += 1) {
        switch (src[j]) {
            '{' => depth += 1,
            '}' => if (depth > 0) { depth -= 1; },
            ',' => if (depth == 0) { try out.append(alloc, src[start..j]); start = j + 1; },
            '\\' => j += 1,
            else => {},
        }
    }
    try out.append(alloc, src[start..]);
}

// ──────────────────────────────────────────────────────────
// bun_shell_parse
// ──────────────────────────────────────────────────────────

pub fn shellParseImpl(ptr: [*]const u8, len: u32) u64 {
    const src = ptr[0..len];
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tokens: std.ArrayListUnmanaged(ShTok) = .{};
    shellLex(a, src, &tokens) catch return state.packError(1);
    var out: std.ArrayListUnmanaged(u8) = .{};
    shellSerialize(a, tokens.items, &out) catch return state.packError(1);
    const result = allocator.dupe(u8, out.items) catch return state.packError(1);
    return state.handOff(result);
}

const ShTokTy = enum { word, pipe, semi, amp, redir_out, redir_append, redir_in, newline, eof };
const ShTok = struct { ty: ShTokTy, val: []const u8 = "" };

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
                } else { try out.append(arena, .{ .ty = .redir_out }); i += 1; }
            },
            '<' => { try out.append(arena, .{ .ty = .redir_in }); i += 1; },
            else => {
                var word: std.ArrayListUnmanaged(u8) = .{};
                word_loop: while (i < src.len) {
                    const ch = src[i];
                    switch (ch) {
                        ' ', '\t', '\r', '\n', '|', ';', '&', '>', '<', '#' => break :word_loop,
                        '\\' => { i += 1; if (i < src.len) { try word.append(arena, src[i]); i += 1; } },
                        '\'' => {
                            i += 1;
                            while (i < src.len and src[i] != '\'') { try word.append(arena, src[i]); i += 1; }
                            if (i < src.len) i += 1;
                        },
                        '"' => {
                            i += 1;
                            while (i < src.len and src[i] != '"') {
                                if (src[i] == '\\' and i + 1 < src.len) {
                                    try word.append(arena, '\\');
                                    try word.append(arena, src[i + 1]);
                                    i += 2;
                                } else { try word.append(arena, src[i]); i += 1; }
                            }
                            if (i < src.len) i += 1;
                        },
                        '$' => {
                            if (i + 1 < src.len and src[i + 1] == '(') {
                                const start = i; i += 2;
                                var depth: usize = 1;
                                while (i < src.len and depth > 0) : (i += 1) {
                                    switch (src[i]) { '(' => depth += 1, ')' => depth -= 1, else => {} }
                                }
                                try word.appendSlice(arena, src[start..i]);
                            } else if (i + 1 < src.len and src[i + 1] == '{') {
                                const start = i; i += 2;
                                while (i < src.len and src[i] != '}') i += 1;
                                if (i < src.len) i += 1;
                                try word.appendSlice(arena, src[start..i]);
                            } else {
                                const start = i; i += 1;
                                while (i < src.len and (std.ascii.isAlphanumeric(src[i]) or src[i] == '_')) i += 1;
                                try word.appendSlice(arena, src[start..i]);
                            }
                        },
                        '`' => {
                            const start = i; i += 1;
                            while (i < src.len and src[i] != '`') { if (src[i] == '\\') i += 1; if (i < src.len) i += 1; }
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

fn shellSerialize(arena: std.mem.Allocator, tokens: []const ShTok, out: *std.ArrayListUnmanaged(u8)) !void {
    var pos: usize = 0;
    const skipSemis = struct {
        fn run(tk: []const ShTok, p: *usize) void {
            while (p.* < tk.len and (tk[p.*].ty == .semi or tk[p.*].ty == .newline)) p.* += 1;
        }
    }.run;
    const peekTy = struct {
        fn run(tk: []const ShTok, p: usize) ShTokTy {
            return if (p >= tk.len) .eof else tk[p].ty;
        }
    }.run;

    var stmts: std.ArrayListUnmanaged([]const u8) = .{};
    defer { for (stmts.items) |s| arena.free(s); stmts.deinit(arena); }
    skipSemis(tokens, &pos);

    while (peekTy(tokens, pos) != .eof) {
        var stmt_buf: std.ArrayListUnmanaged(u8) = .{};
        var cmds: std.ArrayListUnmanaged([]const u8) = .{};
        defer { for (cmds.items) |cc| arena.free(cc); cmds.deinit(arena); }
        var bg = false;

        while (true) {
            var cmd_buf: std.ArrayListUnmanaged(u8) = .{};
            var argv: std.ArrayListUnmanaged([]const u8) = .{};
            defer { for (argv.items) |a| arena.free(a); argv.deinit(arena); }
            var redirs: std.ArrayListUnmanaged([]const u8) = .{};
            defer { for (redirs.items) |r| arena.free(r); redirs.deinit(arena); }

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
                            .redir_out => ">", .redir_append => ">>", .redir_in => "<", else => unreachable,
                        };
                        if (peekTy(tokens, pos) != .word) break;
                        const target = tokens[pos].val; pos += 1;
                        var redir_buf: std.ArrayListUnmanaged(u8) = .{};
                        defer redir_buf.deinit(arena);
                        try redir_buf.appendSlice(arena, "{\"t\":");
                        try state.jsonEscapeTo2(&redir_buf, arena, op_str);
                        try redir_buf.appendSlice(arena, ",\"fd\":1,\"target\":");
                        try state.jsonEscapeTo2(&redir_buf, arena, target);
                        try redir_buf.append(arena, '}');
                        try redirs.append(arena, try redir_buf.toOwnedSlice(arena));
                    },
                    else => unreachable,
                }
            }

            try cmd_buf.appendSlice(arena, "{\"t\":\"cmd\",\"argv\":[");
            for (argv.items, 0..) |a, idx| {
                if (idx > 0) try cmd_buf.append(arena, ',');
                try state.jsonEscapeTo2(&cmd_buf, arena, a);
            }
            try cmd_buf.appendSlice(arena, "],\"redirs\":[");
            for (redirs.items, 0..) |r, idx| {
                if (idx > 0) try cmd_buf.append(arena, ',');
                try cmd_buf.appendSlice(arena, r);
            }
            try cmd_buf.append(arena, ']');
            try cmd_buf.append(arena, '}');
            try cmds.append(arena, try cmd_buf.toOwnedSlice(arena));
            if (peekTy(tokens, pos) != .pipe) break;
            pos += 1;
        }

        if (peekTy(tokens, pos) == .amp) { bg = true; pos += 1; }

        if (bg and cmds.items.len > 0) {
            const last_idx = cmds.items.len - 1;
            const old = cmds.items[last_idx];
            const new_cmd = try std.fmt.allocPrint(arena, "{s},\"bg\":true}}", .{old[0 .. old.len - 1]});
            arena.free(old);
            cmds.items[last_idx] = new_cmd;
        }

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

    try out.appendSlice(arena, "{\"t\":\"seq\",\"stmts\":[");
    for (stmts.items, 0..) |s, idx| {
        if (idx > 0) try out.append(arena, ',');
        try out.appendSlice(arena, s);
    }
    try out.appendSlice(arena, "]}");
}
