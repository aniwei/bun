//! Full `bun` pseudo-module for wasm32-freestanding builds.
//!
//! This file is injected as the `bun` named module by build-wasm-smoke.zig:
//!
//!   bun_shim.addImport("bun", bun_shim);  // self-referential
//!
//! Any file within the bun_shim module that does `@import("bun")` gets this
//! file back — exactly like the real build where src/bun.zig IS the `bun`
//! package.  This allows src/semver/*.zig to be compiled unmodified under
//! the WASM target.
//!
//! Lives at src/ level so it can reach src/identity_context.zig,
//! src/semver/*, etc. via relative imports.

const std = @import("std");
const builtin = @import("builtin");

// ── Environment ──────────────────────────────────────────────────────────────

pub const Environment = struct {
    pub const isWasm: bool = true;
    pub const wasm_browser_runtime: bool = true;
    pub const isBrowser: bool = true;
    pub const isWasi: bool = false;
    pub const isPosix: bool = false;
    pub const isWindows: bool = false;
    pub const isLinux: bool = false;
    pub const isMac: bool = false;
    pub const isFreeBSD: bool = false;
    pub const isNative: bool = false;
    pub const isX64: bool = false;
    pub const isAarch64: bool = false;
    pub const isDebug: bool = builtin.mode == .Debug;
    pub const isRelease: bool = builtin.mode != .Debug;
    pub const allow_assert: bool = builtin.mode == .Debug;
    pub const onlyU32Versions: bool = false;
};

// ── Core primitives ──────────────────────────────────────────────────────────

pub const OOM = std.mem.Allocator.Error;

pub const JSError = error{
    /// Active exception on the global object.
    JSError,
    OutOfMemory,
    /// Termination exception.
    JSTerminated,
};

pub const JSTerminated = error{JSTerminated};

pub const JSOOM = OOM || JSError;

pub const callconv_inline: std.builtin.CallingConvention = if (builtin.mode == .Debug) .auto else .@"inline";

pub const default_allocator: std.mem.Allocator = std.heap.wasm_allocator;

pub fn assert(ok: bool) void {
    if (Environment.allow_assert) {
        if (!ok) unreachable;
    }
}

pub fn unsafeAssert(ok: bool) void {
    _ = ok;
}

// ── IdentityContext (pure Zig, no deps) ─────────────────────────────────────

pub const IdentityContext = @import("./identity_context.zig").IdentityContext;

// ── strings (WASM-safe subset of src/string/immutable.zig) ──────────────────

pub const strings = @import("./jsi/strings_wasm.zig");

// ── Output stub (no terminal in WASM; format methods never invoked) ──────────

pub const Output = struct {
    pub const enable_ansi_colors_stdout: bool = false;
    pub const enable_ansi_colors_stderr: bool = false;
    pub const enable_ansi_colors: bool = false;

    /// Strip <color> markers. Only called from Version.format — never from the
    /// semver comparison path, so this stub is never actually instantiated.
    pub fn prettyFmt(comptime fmt: []const u8, comptime _: bool) [:0]const u8 {
        @setEvalBranchQuota(fmt.len * 4 + 9999);
        comptime var buf: [fmt.len + 1]u8 = [_]u8{0} ** (fmt.len + 1);
        comptime var ni: usize = 0;
        comptime var i: usize = 0;
        comptime while (i < fmt.len) {
            if (fmt[i] == '<') {
                i += 1;
                while (i < fmt.len and fmt[i] != '>') : (i += 1) {}
                if (i < fmt.len) i += 1;
            } else {
                buf[ni] = fmt[i];
                ni += 1;
                i += 1;
            }
        };
        return buf[0..ni :0];
    }

    pub fn prettyErrorln(comptime _: []const u8, _: anytype) void {}
    pub fn printErrorln(comptime _: []const u8, _: anytype) void {}
    pub fn pretty(comptime _: []const u8, _: anytype) void {}
    pub fn prettyError(comptime _: []const u8, _: anytype) void {}
    pub fn panic(comptime _: []const u8, _: anytype) noreturn {
        unreachable;
    }
};

// ── JSC stub (type signatures only; method bodies never compiled) ─────────────

pub const jsc = struct {
  pub const JSGlobalObject = opaque {};
  pub const JSValue = opaque {};
  pub const CallFrame = opaque {};
  pub const ZigString = struct {
    pub fn static(_: []const u8) @This() {
      return .{};
    }
  };
  pub const JSFunction = struct {
    pub fn create(_: anytype, _: anytype, _: anytype, _: anytype, _: anytype) @This() {
      return .{};
    }
  };
};

// ── Lockfile stub (opaque; body of Buf.init / hashContext never compiled) ────

pub const install = struct {
  pub const Lockfile = opaque {};
};

// ── Semver (re-export of pure types; SemverObject excluded) ─────────────────

pub const Semver = @import("./bun_wasm_semver.zig");
// ── bit_set (re-export std.bit_set; used by SemverQuery) ───────────────────

pub const bit_set = std.bit_set;

// ── hash (Wyhash; used by SemverString.HashContext) ─────────────────────

pub fn hash(content: []const u8) u64 {
  return std.hash.Wyhash.hash(0, content);
}

pub const Wyhash11 = @import("./wyhash.zig").Wyhash11;

// ── isSliceInBuffer (assertion helper; only called in allow_assert=true builds) ──

pub fn isSliceInBuffer(buf: []const u8, outer: []const u8) bool {
  return @intFromPtr(outer.ptr) <= @intFromPtr(buf.ptr) and
    @intFromPtr(buf.ptr) + buf.len <= @intFromPtr(outer.ptr) + outer.len;
}

// ── sha (pure Zig re-implementation; mirrors the Hashers API of src/sha.zig) ─

/// Mirrors `src/sha.zig`.Hashers using std.crypto — no BoringSSL required.
pub const sha = struct {
  fn NewHasher(
    comptime digest_size: comptime_int,
    comptime StdHasher: type,
  ) type {
    return struct {
      inner: StdHasher,

      pub const Digest = [digest_size]u8;
      pub const digest: comptime_int = digest_size;

      pub fn init() @This() {
        return .{ .inner = StdHasher.init(.{}) };
      }

      pub fn update(self: *@This(), data: []const u8) void {
        self.inner.update(data);
      }

      pub fn final(self: *@This(), out: *Digest) void {
        self.inner.final(out);
      }

      pub fn hash(bytes: []const u8, out: *Digest) void {
        StdHasher.hash(bytes, out, .{});
      }
    };
  }

  pub const Hashers = struct {
    pub const SHA1 = NewHasher(
      std.crypto.hash.Sha1.digest_length,
      std.crypto.hash.Sha1,
    );
    pub const SHA512 = NewHasher(
      std.crypto.hash.sha2.Sha512.digest_length,
      std.crypto.hash.sha2.Sha512,
    );
    pub const SHA384 = NewHasher(
      std.crypto.hash.sha2.Sha384.digest_length,
      std.crypto.hash.sha2.Sha384,
    );
    pub const SHA256 = NewHasher(
      std.crypto.hash.sha2.Sha256.digest_length,
      std.crypto.hash.sha2.Sha256,
    );
  };
};