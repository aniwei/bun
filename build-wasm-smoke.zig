//! Phase 0 smoke-test build script (Zig 0.15).
//!
//! Purpose: type-check the new WASM browser-runtime modules (`src/jsi/**`,
//! `src/sys_wasm/**`, `src/async/wasm_event_loop.zig`) **in isolation**
//! from the massive main build graph. Runs VFS + wasm_event_loop unit
//! tests on the host, and additionally sem-checks the jsi package
//! against `wasm32-freestanding` so `extern "jsi" fn ...` declarations
//! are exercised.
//!
//! Usage from repo root:
//!   zig build --build-file build-wasm-smoke.zig test         # run host tests
//!   zig build --build-file build-wasm-smoke.zig check-wasm   # wasm32 sema only
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

    // ── wasm32-freestanding sema check for jsi package ──
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    const jsi_mod = b.createModule(.{
        .root_source_file = b.path("src/jsi/jsi.zig"),
        .target = wasm_target,
        .optimize = .Debug,
    });
    const jsi_lib = b.addLibrary(.{
        .name = "jsi-smoke",
        .root_module = jsi_mod,
        .linkage = .static,
    });

    const check_wasm = b.step("check-wasm", "Sema-check jsi package against wasm32-freestanding");
    check_wasm.dependOn(&jsi_lib.step);

    b.default_step.dependOn(test_step);
    b.default_step.dependOn(check_wasm);
}
