//! Bun Browser Runtime — thin entry point.
//! All implementation lives in src/bun_browser_runtime/*.zig sub-modules.
//! This file only contains the `export fn` wrappers that forward to them.

const std = @import("std");
const state   = @import("bun_browser_runtime/state.zig");
const rf      = @import("bun_browser_runtime/require_and_fs.zig");
const host    = @import("bun_browser_runtime/host_setup.zig");
const core    = @import("bun_browser_runtime/core_abi.zig");
const bundler = @import("bun_browser_runtime/bundler_abi.zig");
const npm     = @import("bun_browser_runtime/npm_lockfile_abi.zig");
const extras  = @import("bun_browser_runtime/extras_abi.zig");

// Force reference to side-effect-bearing modules so they're compiled in.
comptime { _ = rf; _ = host; }

// ── Core lifecycle ─────────────────────────────────────────────────────────
export fn bun_browser_init() void { core.init(); }
export fn bun_tick() u32 { return core.tick(); }
export fn bun_wakeup() void {}
/// T5.12.1: Returns the byte address of the tick_notify slot in WASM linear memory.
/// JS host uses: `const idx = bun_tick_notify_ptr() >>> 2;` then `Atomics.notify(i32view, idx, 1)`.
export fn bun_tick_notify_ptr() u32 { return core.tickNotifyPtr(); }

// ── VFS ───────────────────────────────────────────────────────────────────
export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 { return core.vfsLoadSnapshot(ptr, len); }
export fn bun_vfs_dump_snapshot() u64 { return core.vfsDumpSnapshot(); }
export fn bun_vfs_read_file(pp: [*]const u8, pl: u32) u64 { return core.vfsReadFile(pp, pl); }

// ── Eval / run ────────────────────────────────────────────────────────────
export fn bun_browser_run(pp: [*]const u8, pl: u32) i32 { return core.browserRun(pp, pl); }
export fn bun_browser_eval(sp: [*]const u8, sl: u32, fp: [*]const u8, fl: u32) i32 { return core.browserEval(sp, sl, fp, fl); }

// ── Process / spawn ───────────────────────────────────────────────────────
export fn bun_spawn(pp: [*]const u8, pl: u32) i32 { return core.spawn(pp, pl); }
export fn bun_kill(a: u32, b: u32) void { core.kill(a, b); }
export fn bun_feed_stdin(a: u32, p: [*]const u8, l: u32) void { core.feedStdin(a, p, l); }
export fn bun_close_stdin(a: u32) void { core.closeStdin(a); }
/// T5.12.4: Thread entry point called by the host Worker after jsi_thread_spawn(arg).
/// See core_abi.zig threadEntry() for dispatch semantics.
export fn bun_thread_entry(arg: u32) void { core.threadEntry(arg); }

// ── JSI host dispatch ────────────────────────────────────────────────────
export fn jsi_host_invoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 { return core.jsiHostInvoke(fn_id, this_handle, argv_ptr, argc); }
export fn jsi_host_arg_scratch(argc: u32) [*]u32 { return core.jsiHostArgScratch(argc); }

// ── Memory ───────────────────────────────────────────────────────────────
export fn bun_malloc(n: u32) u32 { return core.wasmMalloc(n); }
export fn bun_free(ptr: u32) void { core.wasmFree(ptr); }

// ── Semver / npm metadata / lockfile ─────────────────────────────────────
export fn bun_semver_select(vp: [*]const u8, vl: u32, rp: [*]const u8, rl: u32) u64 { return npm.semverSelectImpl(vp, vl, rp, rl); }
export fn bun_npm_parse_metadata(jp: [*]const u8, jl: u32, rp: [*]const u8, rl: u32) u64 { return npm.npmParseMetadataImpl(jp, jl, rp, rl); }
export fn bun_lockfile_parse(pp: [*]const u8, pl: u32) u64 { return npm.lockfileParseImpl(pp, pl); }
export fn bun_lockfile_write(pp: [*]const u8, pl: u32) u64 { return npm.lockfileWriteImpl(pp, pl); }

// ── Bundler / resolve / path ──────────────────────────────────────────────
export fn bun_resolve(sp: [*]const u8, sl: u32, fp: [*]const u8, fl: u32) u64 { return bundler.resolve(sp, sl, fp, fl); }
export fn bun_bundle(pp: [*]const u8, pl: u32) u64 { return bundler.bundle(pp, pl); }
export fn bun_bundle2(pp: [*]const u8, pl: u32) u64 { return bundler.bundle2(pp, pl); }
export fn bun_path_normalize(pp: [*]const u8, pl: u32) u64 { return bundler.pathNormalize(pp, pl); }
export fn bun_path_dirname(pp: [*]const u8, pl: u32) u64 { return bundler.pathDirname(pp, pl); }
export fn bun_path_join(pp: [*]const u8, pl: u32) u64 { return bundler.pathJoin(pp, pl); }
export fn bun_transform(pp: [*]const u8, pl: u32) u64 { return bundler.transform(pp, pl); }
export fn bun_url_parse(pp: [*]const u8, pl: u32) u64 { return bundler.urlParse(pp, pl); }

// ── Integrity / hash / base64 / inflate / tgz ────────────────────────────
export fn bun_integrity_verify(dp: [*]const u8, dl: u32, ip: [*]const u8, il: u32) u32 { return extras.integrityVerifyImpl(dp, dl, ip, il); }
export fn bun_hash(dp: [*]const u8, dl: u32, algo: u32) u64 { return extras.hashImpl(dp, dl, algo); }
export fn bun_base64_encode(dp: [*]const u8, dl: u32) u64 { return extras.base64EncodeImpl(dp, dl); }
export fn bun_base64_decode(dp: [*]const u8, dl: u32) u64 { return extras.base64DecodeImpl(dp, dl); }
export fn bun_inflate(pp: [*]const u8, pl: u32, fmt: u32) u64 { return extras.inflateImpl(pp, pl, fmt); }
export fn bun_tgz_extract(pp: [*]const u8, pl: u32) u64 { return extras.tgzExtractImpl(pp, pl); }

// ── Sourcemap / HTML / brace / shell / glob ────────────────────────────────────────
export fn bun_sourcemap_lookup(pp: [*]const u8, pl: u32) u64 { return extras.sourcemapLookupImpl(pp, pl); }
export fn bun_html_rewrite(pp: [*]const u8, pl: u32) u64 { return extras.htmlRewriteImpl(pp, pl); }
export fn bun_brace_expand(pp: [*]const u8, pl: u32) u64 { return extras.braceExpandImpl(pp, pl); }
export fn bun_shell_parse(pp: [*]const u8, pl: u32) u64 { return extras.shellParseImpl(pp, pl); }
export fn bun_glob_match(gp: [*]const u8, gl: u32, pp: [*]const u8, pl: u32) u32 { return extras.globMatchImpl(gp, gl, pp, pl); }

// ── npm async install protocol ────────────────────────────────────────────
export fn bun_npm_resolve_graph(pp: [*]const u8, pl: u32) u64 { return npm.npmResolveGraphImpl(pp, pl); }
export fn bun_npm_install_begin(pp: [*]const u8, pl: u32) u64 { return npm.npmInstallBeginImpl(pp, pl); }
export fn bun_npm_need_fetch() u64 { return npm.npmNeedFetchImpl(); }
export fn bun_npm_feed_response(id: u32, pp: [*]const u8, pl: u32) u64 { return npm.npmFeedResponseImpl(id, pp, pl); }
export fn bun_npm_install_mark_seen(pp: [*]const u8, pl: u32) void { npm.npmInstallMarkSeenImpl(pp, pl); }
export fn bun_npm_install_result() u64 { return npm.npmInstallResultImpl(); }
export fn bun_npm_install_end() void { npm.npmInstallEndImpl(); }
