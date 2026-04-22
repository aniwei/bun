//! WASM 侧虚拟文件系统（In-Memory + Overlay）。
//!
//! 设计：
//!   - 单根 inode 表 + 父子指针组成目录树
//!   - Overlay：L0 readonly snapshot, L1 user mount, L2 tmp write（Phase 1+ 分层）
//!   - 当前骨架仅实现 L2（内存写），后续扩展
//!
//! 对接：`src/sys.zig` 在 wasm 分支下选择这里的函数作为后端（Phase 0.5 完成）。

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const FileDescriptor = i32;
pub const FileMode = u16;

pub const Whence = enum(u8) { set, cur, end };

pub const Error = error{
    NotFound,
    NotADirectory,
    IsADirectory,
    AlreadyExists,
    PermissionDenied,
    BadFileDescriptor,
    NoSpace,
    InvalidPath,
    OutOfMemory,
    InvalidOffset,
    NotEmpty,
    NameTooLong,
    Loop,
};

pub const OpenFlags = packed struct(u32) {
    read: bool = false,
    write: bool = false,
    create: bool = false,
    exclusive: bool = false,
    truncate: bool = false,
    append: bool = false,
    _padding: u26 = 0,
};

pub const InodeKind = enum(u8) { file, directory, symlink };

pub const Stat = struct {
    size: u64,
    kind: InodeKind,
    mode: FileMode,
    mtime_ms: u64,
    ino: u64,
    nlink: u32 = 1,
};

pub const DirEntry = struct {
    name: []const u8,
    kind: InodeKind,
    ino: u64,
};

const Inode = struct {
    id: u64,
    kind: InodeKind,
    mode: FileMode,
    mtime_ms: u64,
    data: union(InodeKind) {
        file: std.array_list.Managed(u8),
        directory: std.StringHashMap(u64), // name -> child ino
        symlink: []u8,
    },
};

const OpenFile = struct {
    ino: u64,
    offset: u64,
    flags: OpenFlags,
};

/// VFS snapshot 二进制格式（T1.2）。
/// 格式：[u32 file_count] [Entry...]
/// Entry：[u32 path_len] [u8[] path] [u32 data_len] [u8[] data] [u16 mode]
pub const SnapshotHeader = struct {
    file_count: u32,
};

/// 具名内部条目，用于 `collectFiles` / `exportSnapshot` 之间共享类型。
const FileEntry = struct {
    path: []u8,
    ino: *Inode,
};

pub const VFS = struct {
    allocator: Allocator,
    inodes: std.AutoHashMap(u64, *Inode),
    next_ino: u64,
    root_ino: u64,
    open_files: std.AutoHashMap(FileDescriptor, OpenFile),
    next_fd: FileDescriptor,
    clock_ms: *const fn () u64, // 由宿主注入（通过 JSI 或导入 Date.now）

    const max_symlink_depth = 40;

    pub fn init(allocator: Allocator, clock_ms: *const fn () u64) !VFS {
        var self = VFS{
            .allocator = allocator,
            .inodes = std.AutoHashMap(u64, *Inode).init(allocator),
            .next_ino = 1,
            .root_ino = 0,
            .open_files = std.AutoHashMap(FileDescriptor, OpenFile).init(allocator),
            .next_fd = 3, // 0/1/2 保留给 stdio
            .clock_ms = clock_ms,
        };
        // 创建根目录
        self.root_ino = try self.allocInode(.directory, 0o755);
        return self;
    }

    pub fn deinit(self: *VFS) void {
        var it = self.inodes.iterator();
        while (it.next()) |entry| {
            const ino = entry.value_ptr.*;
            switch (ino.data) {
                .file => |*f| f.deinit(),
                .directory => |*d| {
                    var ki = d.keyIterator();
                    while (ki.next()) |k| self.allocator.free(k.*);
                    d.deinit();
                },
                .symlink => |s| self.allocator.free(s),
            }
            self.allocator.destroy(ino);
        }
        self.inodes.deinit();
        self.open_files.deinit();
    }

    fn allocInode(self: *VFS, kind: InodeKind, mode: FileMode) !u64 {
        const id = self.next_ino;
        self.next_ino += 1;
        const ino = try self.allocator.create(Inode);
        ino.* = .{
            .id = id,
            .kind = kind,
            .mode = mode,
            .mtime_ms = self.clock_ms(),
            .data = switch (kind) {
                .file => .{ .file = std.array_list.Managed(u8).init(self.allocator) },
                .directory => .{ .directory = std.StringHashMap(u64).init(self.allocator) },
                .symlink => .{ .symlink = &.{} },
            },
        };
        try self.inodes.put(id, ino);
        return id;
    }

    fn getInode(self: *VFS, id: u64) ?*Inode {
        return self.inodes.get(id);
    }

    fn statInode(_: *VFS, ino: *const Inode) Stat {
        return .{
            .size = switch (ino.data) {
                .file => |f| f.items.len,
                .directory => |d| d.count(),
                .symlink => |s| s.len,
            },
            .kind = ino.kind,
            .mode = ino.mode,
            .mtime_ms = ino.mtime_ms,
            .ino = ino.id,
        };
    }

    /// 按绝对路径走到 inode，支持 symlink 跟随。
    fn resolve(self: *VFS, path: []const u8) Error!u64 {
        return self.resolveDepth(path, 0);
    }

    fn resolveDepth(self: *VFS, path: []const u8, depth: u32) Error!u64 {
        if (depth >= max_symlink_depth) return error.Loop;
        if (path.len == 0 or path[0] != '/') return error.InvalidPath;
        var current = self.root_ino;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |segment| {
            const node = self.inodes.get(current) orelse return error.NotFound;
            switch (node.data) {
                .directory => |*d| {
                    const child_id = d.get(segment) orelse return error.NotFound;
                    const child = self.inodes.get(child_id) orelse return error.NotFound;
                    if (child.kind == .symlink) {
                        const target = child.data.symlink;
                        const resolved = try self.resolveDepth(target, depth + 1);
                        current = resolved;
                    } else {
                        current = child_id;
                    }
                },
                else => return error.NotADirectory,
            }
        }
        return current;
    }

    fn resolveParent(self: *VFS, path: []const u8) Error!struct { parent_ino: u64, name: []const u8 } {
        if (path.len == 0 or path[0] != '/') return error.InvalidPath;
        const last_slash = std.mem.lastIndexOfScalar(u8, path, '/').?;
        const parent_path = if (last_slash == 0) "/" else path[0..last_slash];
        const name = path[last_slash + 1 ..];
        if (name.len == 0) return error.InvalidPath;
        const parent = try self.resolve(parent_path);
        return .{ .parent_ino = parent, .name = name };
    }

    /// 递归释放一棵 inode 子树（含自身）。
    fn freeInodeRecursive(self: *VFS, ino_id: u64) void {
        const ino = self.inodes.get(ino_id) orelse return;
        switch (ino.data) {
            .file => |*f| f.deinit(),
            .directory => |*d| {
                // 先递归释放所有子 inode
                var vi = d.valueIterator();
                while (vi.next()) |child_id| {
                    self.freeInodeRecursive(child_id.*);
                }
                var ki = d.keyIterator();
                while (ki.next()) |k| self.allocator.free(k.*);
                d.deinit();
            },
            .symlink => |s| self.allocator.free(s),
        }
        _ = self.inodes.remove(ino_id);
        self.allocator.destroy(ino);
    }

    /// 确保路径的父目录均存在，类似 `mkdir -p` 的内部版本。
    pub fn mkdirp(self: *VFS, path: []const u8) Error!void {
        if (path.len == 0 or path[0] != '/') return error.InvalidPath;
        var current = self.root_ino;
        var it = std.mem.tokenizeScalar(u8, path, '/');
        while (it.next()) |segment| {
            const node = self.inodes.get(current) orelse return error.NotFound;
            switch (node.data) {
                .directory => |*d| {
                    if (d.get(segment)) |child_id| {
                        current = child_id;
                    } else {
                        const new_ino = try self.allocInode(.directory, 0o755);
                        const name_copy = try self.allocator.dupe(u8, segment);
                        try d.put(name_copy, new_ino);
                        current = new_ino;
                    }
                },
                else => return error.NotADirectory,
            }
        }
    }

    // ── 公开 API ────────────────────────────────────────

    pub fn mkdir(self: *VFS, path: []const u8, mode: FileMode) Error!void {
        const loc = try self.resolveParent(path);
        const parent = self.inodes.get(loc.parent_ino).?;
        switch (parent.data) {
            .directory => |*d| {
                if (d.contains(loc.name)) return error.AlreadyExists;
                const new_ino = try self.allocInode(.directory, mode);
                const name_copy = try self.allocator.dupe(u8, loc.name);
                try d.put(name_copy, new_ino);
            },
            else => return error.NotADirectory,
        }
    }

    pub fn open(self: *VFS, path: []const u8, flags: OpenFlags, mode: FileMode) Error!FileDescriptor {
        const ino_id = blk: {
            if (self.resolve(path)) |id| {
                // 文件已存在，O_CREAT + O_EXCL 应返回 AlreadyExists
                if (flags.exclusive and flags.create) return error.AlreadyExists;
                break :blk id;
            } else |err| switch (err) {
                error.NotFound => {
                    if (!flags.create) return error.NotFound;
                    const loc = try self.resolveParent(path);
                    const parent = self.inodes.get(loc.parent_ino).?;
                    switch (parent.data) {
                        .directory => |*d| {
                            const new_ino = try self.allocInode(.file, mode);
                            const name_copy = try self.allocator.dupe(u8, loc.name);
                            try d.put(name_copy, new_ino);
                            break :blk new_ino;
                        },
                        else => return error.NotADirectory,
                    }
                },
                else => return err,
            }
        };

        const ino = self.inodes.get(ino_id).?;
        if (ino.kind == .directory) return error.IsADirectory;

        if (flags.truncate and ino.kind == .file) {
            ino.data.file.clearRetainingCapacity();
        }

        const fd = self.next_fd;
        self.next_fd += 1;
        const offset: u64 = if (flags.append and ino.kind == .file)
            @intCast(ino.data.file.items.len)
        else
            0;
        try self.open_files.put(fd, .{ .ino = ino_id, .offset = offset, .flags = flags });
        return fd;
    }

    pub fn close(self: *VFS, fd: FileDescriptor) Error!void {
        if (!self.open_files.remove(fd)) return error.BadFileDescriptor;
    }

    pub fn read(self: *VFS, fd: FileDescriptor, buf: []u8) Error!usize {
        const of = self.open_files.getPtr(fd) orelse return error.BadFileDescriptor;
        if (!of.flags.read) return error.PermissionDenied;
        const ino = self.inodes.get(of.ino).?;
        if (ino.kind != .file) return error.IsADirectory;
        const data = ino.data.file.items;
        if (of.offset >= data.len) return 0;
        const avail = data.len - of.offset;
        const n = @min(avail, buf.len);
        @memcpy(buf[0..n], data[of.offset .. of.offset + n]);
        of.offset += n;
        return n;
    }

    pub fn write(self: *VFS, fd: FileDescriptor, data: []const u8) Error!usize {
        const of = self.open_files.getPtr(fd) orelse return error.BadFileDescriptor;
        if (!of.flags.write) return error.PermissionDenied;
        const ino = self.inodes.get(of.ino).?;
        if (ino.kind != .file) return error.IsADirectory;

        var file = &ino.data.file;
        const end_offset = of.offset + data.len;
        if (end_offset > file.items.len) {
            try file.resize(end_offset);
        }
        @memcpy(file.items[of.offset..end_offset], data);
        of.offset = end_offset;
        ino.mtime_ms = self.clock_ms();
        return data.len;
    }

    pub fn seek(self: *VFS, fd: FileDescriptor, offset: i64, whence: Whence) Error!u64 {
        const of = self.open_files.getPtr(fd) orelse return error.BadFileDescriptor;
        const ino = self.inodes.get(of.ino).?;
        if (ino.kind != .file) return error.IsADirectory;

        const file_len: i64 = @intCast(ino.data.file.items.len);
        const base: i64 = switch (whence) {
            .set => 0,
            .cur => @intCast(of.offset),
            .end => file_len,
        };
        const new_pos = base + offset;
        if (new_pos < 0) return error.InvalidOffset;
        of.offset = @intCast(new_pos);
        return of.offset;
    }

    pub fn stat(self: *VFS, path: []const u8) Error!Stat {
        const id = try self.resolve(path);
        const ino = self.inodes.get(id).?;
        return self.statInode(ino);
    }

    pub fn fstat(self: *VFS, fd: FileDescriptor) Error!Stat {
        const of = self.open_files.get(fd) orelse return error.BadFileDescriptor;
        const ino = self.inodes.get(of.ino).?;
        return self.statInode(ino);
    }

    pub fn readdir(self: *VFS, path: []const u8, out: *std.array_list.Managed(DirEntry)) Error!void {
        const id = try self.resolve(path);
        const ino = self.inodes.get(id).?;
        switch (ino.data) {
            .directory => |*d| {
                var it = d.iterator();
                while (it.next()) |e| {
                    const child = self.inodes.get(e.value_ptr.*).?;
                    try out.append(.{
                        .name = e.key_ptr.*,
                        .kind = child.kind,
                        .ino = child.id,
                    });
                }
            },
            else => return error.NotADirectory,
        }
    }

    pub fn unlink(self: *VFS, path: []const u8) Error!void {
        const loc = try self.resolveParent(path);
        const parent = self.inodes.get(loc.parent_ino).?;
        switch (parent.data) {
            .directory => |*d| {
                const kv = d.fetchRemove(loc.name) orelse return error.NotFound;
                self.allocator.free(kv.key);
                const child = self.inodes.get(kv.value).?;
                if (child.kind == .directory) return error.IsADirectory;
                switch (child.data) {
                    .file => |*f| f.deinit(),
                    .symlink => |s| self.allocator.free(s),
                    else => {},
                }
                _ = self.inodes.remove(kv.value);
                self.allocator.destroy(child);
            },
            else => return error.NotADirectory,
        }
    }

    pub fn rmdir(self: *VFS, path: []const u8) Error!void {
        const loc = try self.resolveParent(path);
        const parent = self.inodes.get(loc.parent_ino).?;
        switch (parent.data) {
            .directory => |*d| {
                const child_id = d.get(loc.name) orelse return error.NotFound;
                const child = self.inodes.get(child_id).?;
                if (child.kind != .directory) return error.NotADirectory;
                if (child.data.directory.count() != 0) return error.NotEmpty;
                const kv = d.fetchRemove(loc.name).?;
                self.allocator.free(kv.key);
                child.data.directory.deinit();
                _ = self.inodes.remove(child_id);
                self.allocator.destroy(child);
            },
            else => return error.NotADirectory,
        }
    }

    pub fn rename(self: *VFS, old_path: []const u8, new_path: []const u8) Error!void {
        const old_loc = try self.resolveParent(old_path);
        const new_loc = try self.resolveParent(new_path);

        const old_parent = self.inodes.get(old_loc.parent_ino).?;
        if (old_parent.kind != .directory) return error.NotADirectory;
        const child_id = old_parent.data.directory.get(old_loc.name) orelse return error.NotFound;

        const new_parent = self.inodes.get(new_loc.parent_ino).?;
        if (new_parent.kind != .directory) return error.NotADirectory;

        // 如果目标已存在，先删除
        if (new_parent.data.directory.get(new_loc.name)) |existing_id| {
            self.freeInodeRecursive(existing_id);
            // fetchRemove 以释放旧 key
            const removed = new_parent.data.directory.fetchRemove(new_loc.name).?;
            self.allocator.free(removed.key);
        }

        // 从旧父目录移除
        const old_kv = old_parent.data.directory.fetchRemove(old_loc.name).?;
        self.allocator.free(old_kv.key);

        // 插入新父目录
        const new_name = try self.allocator.dupe(u8, new_loc.name);
        new_parent.data.directory.put(new_name, child_id) catch {
            self.allocator.free(new_name);
            return error.OutOfMemory;
        };
    }

    pub fn truncate(self: *VFS, path: []const u8, length: u64) Error!void {
        const id = try self.resolve(path);
        const ino = self.inodes.get(id).?;
        if (ino.kind != .file) return error.IsADirectory;
        try ino.data.file.resize(length);
        ino.mtime_ms = self.clock_ms();
    }

    pub fn ftruncate(self: *VFS, fd: FileDescriptor, length: u64) Error!void {
        const of = self.open_files.getPtr(fd) orelse return error.BadFileDescriptor;
        if (!of.flags.write) return error.PermissionDenied;
        const ino = self.inodes.get(of.ino).?;
        if (ino.kind != .file) return error.IsADirectory;
        try ino.data.file.resize(length);
        ino.mtime_ms = self.clock_ms();
    }

    pub fn chmod(self: *VFS, path: []const u8, mode: FileMode) Error!void {
        const id = try self.resolve(path);
        const ino = self.inodes.get(id).?;
        ino.mode = mode;
    }

    pub fn symlink(self: *VFS, target: []const u8, link_path: []const u8) Error!void {
        const loc = try self.resolveParent(link_path);
        const parent = self.inodes.get(loc.parent_ino).?;
        switch (parent.data) {
            .directory => |*d| {
                if (d.contains(loc.name)) return error.AlreadyExists;
                const new_ino = try self.allocInode(.symlink, 0o777);
                const node = self.inodes.get(new_ino).?;
                node.data.symlink = try self.allocator.dupe(u8, target);
                const name_copy = try self.allocator.dupe(u8, loc.name);
                try d.put(name_copy, new_ino);
            },
            else => return error.NotADirectory,
        }
    }

    pub fn readlink(self: *VFS, path: []const u8) Error![]const u8 {
        // readlink 不跟随最终节点的 symlink
        const loc = try self.resolveParent(path);
        const parent = self.inodes.get(loc.parent_ino).?;
        switch (parent.data) {
            .directory => |*d| {
                const child_id = d.get(loc.name) orelse return error.NotFound;
                const child = self.inodes.get(child_id).?;
                if (child.kind != .symlink) return error.InvalidPath;
                return child.data.symlink;
            },
            else => return error.NotADirectory,
        }
    }

    // ── 便捷 API（对齐 Node.js fs 同步接口）────────────

    pub fn readFile(self: *VFS, path: []const u8) Error![]u8 {
        const id = try self.resolve(path);
        const ino = self.inodes.get(id).?;
        if (ino.kind != .file) return error.IsADirectory;
        return try self.allocator.dupe(u8, ino.data.file.items);
    }

    pub fn writeFile(self: *VFS, path: []const u8, data: []const u8, mode: FileMode) Error!void {
        const ino_id = blk: {
            if (self.resolve(path)) |id| break :blk id else |err| switch (err) {
                error.NotFound => {
                    const loc = try self.resolveParent(path);
                    const parent = self.inodes.get(loc.parent_ino).?;
                    switch (parent.data) {
                        .directory => |*d| {
                            const new_ino = try self.allocInode(.file, mode);
                            const name_copy = try self.allocator.dupe(u8, loc.name);
                            try d.put(name_copy, new_ino);
                            break :blk new_ino;
                        },
                        else => return error.NotADirectory,
                    }
                },
                else => return err,
            }
        };
        const ino = self.inodes.get(ino_id).?;
        if (ino.kind != .file) return error.IsADirectory;
        var file = &ino.data.file;
        file.clearRetainingCapacity();
        try file.appendSlice(data);
        ino.mtime_ms = self.clock_ms();
    }

    pub fn exists(self: *VFS, path: []const u8) bool {
        _ = self.resolve(path) catch return false;
        return true;
    }

    // ── Snapshot 加载（T1.2 VFS 预加载协议）─────────────

    /// 从二进制 snapshot 一次性挂载完整文件树。
    /// 格式：[u32 file_count] { [u32 path_len][u8[] path][u32 data_len][u8[] data][u16 mode] }...
    pub fn loadSnapshot(self: *VFS, snapshot: []const u8) Error!u32 {
        if (snapshot.len < 4) return error.InvalidPath;
        var pos: usize = 0;

        const file_count = std.mem.readInt(u32, snapshot[pos..][0..4], .little);
        pos += 4;

        var loaded: u32 = 0;
        while (loaded < file_count) : (loaded += 1) {
            // path_len
            if (pos + 4 > snapshot.len) return error.InvalidPath;
            const path_len = std.mem.readInt(u32, snapshot[pos..][0..4], .little);
            pos += 4;

            if (pos + path_len > snapshot.len) return error.InvalidPath;
            const path = snapshot[pos .. pos + path_len];
            pos += path_len;

            // data_len
            if (pos + 4 > snapshot.len) return error.InvalidPath;
            const data_len = std.mem.readInt(u32, snapshot[pos..][0..4], .little);
            pos += 4;

            if (pos + data_len > snapshot.len) return error.InvalidPath;
            const data = snapshot[pos .. pos + data_len];
            pos += data_len;

            // mode
            if (pos + 2 > snapshot.len) return error.InvalidPath;
            const mode = std.mem.readInt(u16, snapshot[pos..][0..2], .little);
            pos += 2;

            // 确保父目录存在
            if (std.mem.lastIndexOfScalar(u8, path, '/')) |last_slash| {
                if (last_slash > 0) {
                    try self.mkdirp(path[0..last_slash]);
                }
            }

            // 写入文件
            try self.writeFile(path, data, mode);
        }
        return loaded;
    }

    /// 将当前 VFS 内容导出为 snapshot 二进制。
    pub fn exportSnapshot(self: *VFS, out: *std.array_list.Managed(u8)) Error!u32 {
        // 收集所有文件路径
        var files = std.array_list.Managed(FileEntry).init(self.allocator);
        defer {
            for (files.items) |f| self.allocator.free(f.path);
            files.deinit();
        }
        try self.collectFiles(self.root_ino, "/", &files);

        // 写入 header
        var count_buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &count_buf, @intCast(files.items.len), .little);
        try out.appendSlice(&count_buf);

        var count: u32 = 0;
        for (files.items) |f| {
            // path_len + path
            var path_len_buf: [4]u8 = undefined;
            std.mem.writeInt(u32, &path_len_buf, @intCast(f.path.len), .little);
            try out.appendSlice(&path_len_buf);
            try out.appendSlice(f.path);

            // data_len + data
            const data = f.ino.data.file.items;
            var data_len_buf: [4]u8 = undefined;
            std.mem.writeInt(u32, &data_len_buf, @intCast(data.len), .little);
            try out.appendSlice(&data_len_buf);
            try out.appendSlice(data);

            // mode
            var mode_buf: [2]u8 = undefined;
            std.mem.writeInt(u16, &mode_buf, f.ino.mode, .little);
            try out.appendSlice(&mode_buf);

            count += 1;
        }
        return count;
    }

    fn collectFiles(self: *VFS, ino_id: u64, prefix: []const u8, out: *std.array_list.Managed(FileEntry)) Error!void {
        const ino = self.inodes.get(ino_id) orelse return;
        if (ino.kind != .directory) return;

        var it = ino.data.directory.iterator();
        while (it.next()) |entry| {
            const child_id = entry.value_ptr.*;
            const child = self.inodes.get(child_id) orelse continue;
            const name = entry.key_ptr.*;

            // 构建完整路径
            const path = blk: {
                if (std.mem.eql(u8, prefix, "/")) {
                    break :blk try std.fmt.allocPrint(self.allocator, "/{s}", .{name});
                } else {
                    break :blk try std.fmt.allocPrint(self.allocator, "{s}/{s}", .{ prefix, name });
                }
            };

            switch (child.kind) {
                .file => {
                    try out.append(.{ .path = path, .ino = child });
                },
                .directory => {
                    try self.collectFiles(child_id, path, out);
                    self.allocator.free(path);
                },
                .symlink => {
                    self.allocator.free(path);
                },
            }
        }
    }
};

// ── 单元测试 ────────────────────────────────────────────

fn testClock() u64 {
    return 0;
}

test "VFS basic CRUD" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.mkdir("/tmp", 0o755);
    try std.testing.expect(vfs.exists("/tmp"));

    const fd = try vfs.open("/tmp/hello.txt", .{ .write = true, .create = true }, 0o644);
    const written = try vfs.write(fd, "hello world");
    try std.testing.expectEqual(@as(usize, 11), written);
    try vfs.close(fd);

    const st = try vfs.stat("/tmp/hello.txt");
    try std.testing.expectEqual(@as(u64, 11), st.size);

    const rfd = try vfs.open("/tmp/hello.txt", .{ .read = true }, 0o644);
    var buf: [32]u8 = undefined;
    const n = try vfs.read(rfd, &buf);
    try std.testing.expectEqual(@as(usize, 11), n);
    try std.testing.expectEqualStrings("hello world", buf[0..n]);
    try vfs.close(rfd);
}

test "VFS readdir" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.mkdir("/a", 0o755);
    try vfs.mkdir("/b", 0o755);
    const fd = try vfs.open("/c.txt", .{ .write = true, .create = true }, 0o644);
    try vfs.close(fd);

    var entries = std.array_list.Managed(DirEntry).init(allocator);
    defer entries.deinit();
    try vfs.readdir("/", &entries);
    try std.testing.expectEqual(@as(usize, 3), entries.items.len);
}

test "VFS unlink" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    const fd = try vfs.open("/temp.txt", .{ .write = true, .create = true }, 0o644);
    try vfs.close(fd);
    try std.testing.expect(vfs.exists("/temp.txt"));
    try vfs.unlink("/temp.txt");
    try std.testing.expect(!vfs.exists("/temp.txt"));
}

test "VFS open exclusive flag" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    // 创建文件
    const fd = try vfs.open("/excl.txt", .{ .write = true, .create = true }, 0o644);
    try vfs.close(fd);

    // O_CREAT | O_EXCL 在文件已存在时应失败
    const result = vfs.open("/excl.txt", .{ .write = true, .create = true, .exclusive = true }, 0o644);
    try std.testing.expectError(error.AlreadyExists, result);

    // O_CREAT | O_EXCL 在文件不存在时应成功
    const fd2 = try vfs.open("/new_excl.txt", .{ .write = true, .create = true, .exclusive = true }, 0o644);
    try vfs.close(fd2);
    try std.testing.expect(vfs.exists("/new_excl.txt"));
}

test "VFS rmdir" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.mkdir("/mydir", 0o755);
    try std.testing.expect(vfs.exists("/mydir"));

    // 空目录可删除
    try vfs.rmdir("/mydir");
    try std.testing.expect(!vfs.exists("/mydir"));

    // 非空目录应返回 NotEmpty
    try vfs.mkdir("/nonempty", 0o755);
    const fd = try vfs.open("/nonempty/file.txt", .{ .write = true, .create = true }, 0o644);
    try vfs.close(fd);
    try std.testing.expectError(error.NotEmpty, vfs.rmdir("/nonempty"));
}

test "VFS rename" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/old.txt", "content", 0o644);
    try vfs.rename("/old.txt", "/new.txt");
    try std.testing.expect(!vfs.exists("/old.txt"));
    try std.testing.expect(vfs.exists("/new.txt"));

    const data = try vfs.readFile("/new.txt");
    defer allocator.free(data);
    try std.testing.expectEqualStrings("content", data);
}

test "VFS rename overwrite" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/a.txt", "aaa", 0o644);
    try vfs.writeFile("/b.txt", "bbb", 0o644);
    try vfs.rename("/a.txt", "/b.txt");

    try std.testing.expect(!vfs.exists("/a.txt"));
    const data = try vfs.readFile("/b.txt");
    defer allocator.free(data);
    try std.testing.expectEqualStrings("aaa", data);
}

test "VFS seek" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/seek.txt", "abcdefghij", 0o644);
    const fd = try vfs.open("/seek.txt", .{ .read = true }, 0o644);
    defer vfs.close(fd) catch {};

    // seek to offset 5
    const pos = try vfs.seek(fd, 5, .set);
    try std.testing.expectEqual(@as(u64, 5), pos);

    var buf: [5]u8 = undefined;
    const n = try vfs.read(fd, &buf);
    try std.testing.expectEqual(@as(usize, 5), n);
    try std.testing.expectEqualStrings("fghij", buf[0..n]);

    // seek relative -3
    const pos2 = try vfs.seek(fd, -3, .cur);
    try std.testing.expectEqual(@as(u64, 7), pos2);

    // seek from end
    const pos3 = try vfs.seek(fd, -2, .end);
    try std.testing.expectEqual(@as(u64, 8), pos3);

    var buf2: [2]u8 = undefined;
    const n2 = try vfs.read(fd, &buf2);
    try std.testing.expectEqualStrings("ij", buf2[0..n2]);
}

test "VFS fstat" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/fstat.txt", "hello", 0o644);
    const fd = try vfs.open("/fstat.txt", .{ .read = true }, 0o644);
    defer vfs.close(fd) catch {};

    const st = try vfs.fstat(fd);
    try std.testing.expectEqual(@as(u64, 5), st.size);
    try std.testing.expectEqual(InodeKind.file, st.kind);
    try std.testing.expectEqual(@as(FileMode, 0o644), st.mode);
}

test "VFS truncate and ftruncate" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/trunc.txt", "hello world", 0o644);
    try vfs.truncate("/trunc.txt", 5);

    const data = try vfs.readFile("/trunc.txt");
    defer allocator.free(data);
    try std.testing.expectEqualStrings("hello", data);

    // ftruncate
    const fd = try vfs.open("/trunc.txt", .{ .write = true }, 0o644);
    defer vfs.close(fd) catch {};
    try vfs.ftruncate(fd, 3);

    const data2 = try vfs.readFile("/trunc.txt");
    defer allocator.free(data2);
    try std.testing.expectEqualStrings("hel", data2);
}

test "VFS chmod" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/chmod.txt", "x", 0o644);
    try vfs.chmod("/chmod.txt", 0o755);

    const st = try vfs.stat("/chmod.txt");
    try std.testing.expectEqual(@as(FileMode, 0o755), st.mode);
}

test "VFS symlink and readlink" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/target.txt", "symlink content", 0o644);
    try vfs.symlink("/target.txt", "/link.txt");

    // readlink 返回目标路径
    const target = try vfs.readlink("/link.txt");
    try std.testing.expectEqualStrings("/target.txt", target);

    // 通过 symlink 读取文件内容
    const data = try vfs.readFile("/link.txt");
    defer allocator.free(data);
    try std.testing.expectEqualStrings("symlink content", data);
}

test "VFS readFile and writeFile" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    try vfs.writeFile("/conv.txt", "first", 0o644);
    const d1 = try vfs.readFile("/conv.txt");
    defer allocator.free(d1);
    try std.testing.expectEqualStrings("first", d1);

    // writeFile 覆盖
    try vfs.writeFile("/conv.txt", "second", 0o644);
    const d2 = try vfs.readFile("/conv.txt");
    defer allocator.free(d2);
    try std.testing.expectEqualStrings("second", d2);
}

test "VFS snapshot round-trip" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    // 创建一些文件
    try vfs.mkdir("/src", 0o755);
    try vfs.writeFile("/src/main.ts", "console.log('hello');", 0o644);
    try vfs.writeFile("/package.json", "{\"name\":\"test\"}", 0o644);

    // 导出 snapshot
    var snapshot_buf = std.array_list.Managed(u8).init(allocator);
    defer snapshot_buf.deinit();
    const exported = try vfs.exportSnapshot(&snapshot_buf);
    try std.testing.expectEqual(@as(u32, 2), exported);

    // 创建新 VFS 并加载 snapshot
    var vfs2 = try VFS.init(allocator, &testClock);
    defer vfs2.deinit();
    const loaded = try vfs2.loadSnapshot(snapshot_buf.items);
    try std.testing.expectEqual(@as(u32, 2), loaded);

    // 验证内容
    const main_ts = try vfs2.readFile("/src/main.ts");
    defer allocator.free(main_ts);
    try std.testing.expectEqualStrings("console.log('hello');", main_ts);

    const pkg_json = try vfs2.readFile("/package.json");
    defer allocator.free(pkg_json);
    try std.testing.expectEqualStrings("{\"name\":\"test\"}", pkg_json);
}

test "VFS mkdirp via snapshot" {
    const allocator = std.testing.allocator;
    var vfs = try VFS.init(allocator, &testClock);
    defer vfs.deinit();

    // 手动构建一个 snapshot，包含嵌套路径
    var snap = std.array_list.Managed(u8).init(allocator);
    defer snap.deinit();

    // file_count = 1
    var count_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &count_buf, 1, .little);
    try snap.appendSlice(&count_buf);

    // path: "/a/b/c/file.txt"
    const path = "/a/b/c/file.txt";
    var path_len_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &path_len_buf, path.len, .little);
    try snap.appendSlice(&path_len_buf);
    try snap.appendSlice(path);

    // data: "nested"
    const data = "nested";
    var data_len_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &data_len_buf, data.len, .little);
    try snap.appendSlice(&data_len_buf);
    try snap.appendSlice(data);

    // mode: 0o644
    var mode_buf: [2]u8 = undefined;
    std.mem.writeInt(u16, &mode_buf, 0o644, .little);
    try snap.appendSlice(&mode_buf);

    const loaded = try vfs.loadSnapshot(snap.items);
    try std.testing.expectEqual(@as(u32, 1), loaded);

    // 验证嵌套目录和文件都存在
    try std.testing.expect(vfs.exists("/a"));
    try std.testing.expect(vfs.exists("/a/b"));
    try std.testing.expect(vfs.exists("/a/b/c"));
    try std.testing.expect(vfs.exists("/a/b/c/file.txt"));

    const content = try vfs.readFile("/a/b/c/file.txt");
    defer allocator.free(content);
    try std.testing.expectEqualStrings("nested", content);
}
