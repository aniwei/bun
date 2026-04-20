//! sys_wasm 包入口。仅 wasm 构建启用。

pub const vfs = @import("vfs.zig");
pub const proc = @import("proc.zig");
pub const net = @import("net.zig");

pub const VFS = vfs.VFS;
pub const ProcessTable = proc.ProcessTable;

// Re-export 常用类型
pub const FileDescriptor = vfs.FileDescriptor;
pub const FileMode = vfs.FileMode;
pub const OpenFlags = vfs.OpenFlags;
pub const InodeKind = vfs.InodeKind;
pub const Stat = vfs.Stat;
pub const DirEntry = vfs.DirEntry;
pub const Whence = vfs.Whence;
