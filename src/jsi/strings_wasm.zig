//! Minimal `bun.strings` shim for wasm32-freestanding builds.
//!
//! Contains only the subset of src/string/immutable.zig that semver/* needs,
//! implemented entirely with std — no native libs, no bun dependencies.

const std = @import("std");

pub const string = []const u8;
pub const ExactSizeMatcher = @import("../string/immutable/exact_size_matcher.zig").ExactSizeMatcher;

// ── Character sets ────────────────────────────────────────────────────────────

pub const whitespace_chars = [_]u8{
    ' ', '\t', '\n', '\r', std.ascii.control_code.vt, std.ascii.control_code.ff,
};

// ── Scalar search ────────────────────────────────────────────────────────────

pub fn containsChar(self: string, char: u8) bool {
    return std.mem.indexOfScalar(u8, self, char) != null;
}

pub fn indexOf(self: string, str: string) ?usize {
    return std.mem.indexOf(u8, self, str);
}

pub fn indexOfChar(slice: []const u8, char: u8) ?u32 {
    return if (std.mem.indexOfScalar(u8, slice, char)) |idx| @intCast(idx) else null;
}

// ── Split ────────────────────────────────────────────────────────────────────

pub const SplitIterator = struct {
    buffer: []const u8,
    index: ?usize,
    delimiter: []const u8,

    const Self = @This();

    pub fn first(self: *Self) []const u8 {
        return self.next().?;
    }

    pub fn next(self: *Self) ?[]const u8 {
        const start = self.index orelse return null;
        const end = if (indexOf(self.buffer[start..], self.delimiter)) |delim_start| blk: {
            const del = delim_start + start;
            self.index = del + self.delimiter.len;
            break :blk delim_start + start;
        } else blk: {
            self.index = null;
            break :blk self.buffer.len;
        };
        return self.buffer[start..end];
    }
};

pub fn split(self: string, delimiter: string) SplitIterator {
    return SplitIterator{ .buffer = self, .index = 0, .delimiter = delimiter };
}

// ── Trim ─────────────────────────────────────────────────────────────────────

pub fn trim(slice: anytype, comptime values_to_strip: []const u8) @TypeOf(slice) {
    var begin: usize = 0;
    var end: usize = slice.len;
    while (begin < end and std.mem.indexOfScalar(u8, values_to_strip, slice[begin]) != null) : (begin += 1) {}
    while (end > begin and std.mem.indexOfScalar(u8, values_to_strip, slice[end - 1]) != null) : (end -= 1) {}
    return slice[begin..end];
}

pub fn lengthOfLeadingWhitespaceASCII(slice: string) usize {
    brk: for (slice) |*c| {
        inline for (whitespace_chars) |wc| if (c.* == wc) continue :brk;
        return @intFromPtr(c) - @intFromPtr(slice.ptr);
    }
    return slice.len;
}

// ── Comparison ───────────────────────────────────────────────────────────────

pub fn order(a: []const u8, b: []const u8) std.math.Order {
    return std.mem.order(u8, a, b);
}

pub fn eql(self: string, other: []const u8) bool {
    return std.mem.eql(u8, self, other);
}

pub fn eqlLong(a_str: string, b_str: string, comptime check_len: bool) bool {
    if (comptime check_len) {
        return a_str.len == b_str.len and std.mem.eql(u8, a_str, b_str);
    }

    if (b_str.len > a_str.len) return false;
    return std.mem.eql(u8, a_str[0..b_str.len], b_str);
}

pub fn isAllASCII(slice: string) bool {
    for (slice) |c| if (c > 127) return false;
    return true;
}

// ── WTF-8 support (needed by glob/match.zig) ─────────────────────────────────

/// u3_fast is u8 everywhere (same as src/string/immutable.zig).
pub const u3_fast = u8;

pub inline fn wtf8ByteSequenceLength(first_byte: u8) u8 {
    return switch (first_byte) {
        0...0x80 - 1 => 1,
        else => if ((first_byte & 0xE0) == 0xC0)
            2
        else if ((first_byte & 0xF0) == 0xE0)
            3
        else if ((first_byte & 0xF8) == 0xF0)
            4
        else
            1,
    };
}

pub inline fn decodeWTF8RuneTMultibyte(p: *const [4]u8, len: u3_fast, comptime T: type, comptime zero: T) T {
    const s1 = p[1];
    if ((s1 & 0xC0) != 0x80) return zero;
    if (len == 2) {
        const cp = @as(T, p[0] & 0x1F) << 6 | @as(T, s1 & 0x3F);
        if (cp < 0x80) return zero;
        return cp;
    }
    const s2 = p[2];
    if ((s2 & 0xC0) != 0x80) return zero;
    if (len == 3) {
        const cp = (@as(T, p[0] & 0x0F) << 12) | (@as(T, s1 & 0x3F) << 6) | (@as(T, s2 & 0x3F));
        if (cp < 0x800) return zero;
        return cp;
    }
    const s3 = p[3];
    if ((s3 & 0xC0) != 0x80) return zero;
    const cp = (@as(T, p[0] & 0x07) << 18) | (@as(T, s1 & 0x3F) << 12) | (@as(T, s2 & 0x3F) << 6) | (@as(T, s3 & 0x3F));
    if (cp < 0x10000 or cp > 0x10FFFF) return zero;
    return cp;
}

pub fn decodeWTF8RuneT(p: *const [4]u8, len: u3_fast, comptime T: type, comptime zero: T) T {
    if (len == 0) return zero;
    if (len == 1) return p[0];
    return decodeWTF8RuneTMultibyte(p, len, T, zero);
}
