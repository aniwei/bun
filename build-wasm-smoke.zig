//! Smoke-test + browser-runtime WASM build script (Zig 0.15).
//!
//! Steps:
//!   test         — run host-native VFS / wasm_event_loop unit tests
//!   check-wasm   — sema-check `src/jsi/jsi.zig` against wasm32-freestanding
//!   build-wasm   — compile `src/bun_browser_standalone.zig` → bun-core.wasm
//!                  Output: packages/bun-browser/bun-core.wasm
//!
//! Usage from repo root:
//!   zig build --build-file build-wasm-smoke.zig test
//!   zig build --build-file build-wasm-smoke.zig check-wasm
//!   zig build --build-file build-wasm-smoke.zig build-wasm
//!   zig build --build-file build-wasm-smoke.zig build-wasm -Doptimize=ReleaseFast
//!
//! Disjoint from `build.zig`; no generated code, no vendor deps.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});
    const host_target = b.standardTargetOptions(.{});

    // ── Host-native unit tests (VFS / wasm_event_loop) ──
    const vfs_mod = b.createModule(.{
        .root_source_file = b.path("src/sys_wasm/vfs.zig"),
        .target = host_target,
        .optimize = optimize,
    });
    const event_mod = b.createModule(.{
        .root_source_file = b.path("src/async/wasm_event_loop.zig"),
        .target = host_target,
        .optimize = optimize,
    });

    const vfs_tests = b.addTest(.{ .name = "vfs-tests", .root_module = vfs_mod });
    const event_tests = b.addTest(.{ .name = "wasm-event-loop-tests", .root_module = event_mod });

    const run_vfs = b.addRunArtifact(vfs_tests);
    const run_event = b.addRunArtifact(event_tests);

    const test_step = b.step("test", "Run host-native unit tests for new WASM modules");
    test_step.dependOn(&run_vfs.step);
    test_step.dependOn(&run_event.step);

    // ── wasm32-freestanding target ──
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    // ── Shared bun Environment shim (used by jsi/* under wasm) ──
    const bun_env_shim = b.createModule(.{
        .root_source_file = b.path("src/jsi/bun_env_shim.zig"),
        .target = wasm_target,
        .optimize = .Debug,
    });
    // bun shim wraps Environment fields; the "bun" module the jsi code sees
    // is a struct that has a field `Environment` pointing at bun_env_shim.
    // We create a tiny anonymous wrapper to satisfy `const bun = @import("bun"); bun.Environment`.
    const bun_shim = b.createModule(.{
        .root_source_file = b.path("src/jsi/bun_env_shim.zig"),
        .target = wasm_target,
        .optimize = .Debug,
    });
    _ = bun_env_shim; // used via bun_shim directly

    // ── jsi module with bun shim injected ──
    const jsi_mod = b.createModule(.{
        .root_source_file = b.path("src/jsi/jsi.zig"),
        .target = wasm_target,
        .optimize = .Debug,
    });
    jsi_mod.addImport("bun", bun_shim);

    // ── sys_wasm module ──
    const sys_wasm_mod = b.createModule(.{
        .root_source_file = b.path("src/sys_wasm/sys_wasm.zig"),
        .target = wasm_target,
        .optimize = .Debug,
    });

    // ── check-wasm: sema only ──
    const jsi_lib = b.addLibrary(.{
        .name = "jsi-smoke",
        .root_module = jsi_mod,
        .linkage = .static,
    });

    const check_wasm = b.step("check-wasm", "Sema-check jsi package against wasm32-freestanding");
    check_wasm.dependOn(&jsi_lib.step);

    // ── build-wasm: produce packages/bun-browser/bun-core.wasm ──
    const wasm_out_dir = "packages/bun-browser";

    const wasm_exe = b.addExecutable(.{
        .name = "bun-core",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/bun_browser_standalone.zig"),
            .target = wasm_target,
            .optimize = optimize,
            .single_threaded = true,
        }),
        // wasm32-freestanding executables are the standard way to get a .wasm file in Zig
    });
    wasm_exe.entry = .disabled; // no _start — we export named functions
    wasm_exe.rdynamic = true;   // keep all export fn symbols

    // Inject module dependencies
    wasm_exe.root_module.addImport("jsi", jsi_mod);
    wasm_exe.root_module.addImport("sys_wasm", sys_wasm_mod);

    const install_wasm = b.addInstallArtifact(wasm_exe, .{
        .dest_dir = .{ .override = .{ .custom = wasm_out_dir } },
    });

    const build_wasm_step = b.step("build-wasm", "Compile bun_browser_standalone.zig → " ++ wasm_out_dir ++ "/bun-core.wasm");
    build_wasm_step.dependOn(&install_wasm.step);

    b.default_step.dependOn(test_step);
    b.default_step.dependOn(check_wasm);
}

