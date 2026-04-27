//! 极简 bun shim —— 供 jsi 包在独立 WASM 构建（build-wasm-smoke.zig）时使用。
//! 正式构建中由 build.zig 注入真正的 bun 模块；这里只满足 `bun.Environment.*` 字段。

/// bun.Environment — 在 standalone wasm 构建中全部 hardcode 为 wasm/browser 值。
pub const Environment = struct {
    pub const isWasm: bool = true;
    pub const wasm_browser_runtime: bool = true;
    pub const isBrowser: bool = true;
    pub const isWasi: bool = false;
    pub const isPosix: bool = false;
    pub const isWindows: bool = false;
    pub const isLinux: bool = false;
    pub const isMac: bool = false;
    pub const isDebug: bool = true;
    pub const isRelease: bool = false;
};
