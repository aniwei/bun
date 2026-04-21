//! Minimal `bun.strings` shim for wasm32-freestanding builds.
//!
//! Contains only the subset of src/string/immutable.zig that semver/* needs,
//! implemented entirely with std — no native libs, no bun dependencies.

const std = @import("std");

pub const string = []const u8;

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

pub fn isAllASCII(slice: string) bool {
    for (slice) |c| if (c > 127) return false;
    return true;
}
