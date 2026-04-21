//! Bun Browser Runtime — Standalone WASM entry point.
//!
//! This is a self-contained version of `bun_browser.zig` that does NOT
//! import `@import("bun")`.  It can be compiled by `build-wasm-smoke.zig`
//! (or any lightweight build script) into a real `bun-core.wasm` binary
//! without pulling in the full Bun dependency graph (JSC, libuv, etc.).
//!
//! Exported ABI (consumed by packages/bun-browser/src/kernel-worker.ts):
//!
//!   bun_browser_init()                     — one-time runtime init
//!   bun_browser_run(ptr, len) i32          — run an entry path from VFS
//!   bun_browser_eval(sp,sl,fp,fl) i32      — eval raw JS source
//!   bun_vfs_load_snapshot(ptr, len) u32    — load VFS snapshot
//!   bun_tick() u32                         — drive event loop; returns ms until next timer (0=idle)
//!   bun_vfs_write(p,pl,d,dl) i32           — write a file into VFS from Host
//!   jsi_host_invoke(id,this,argv,argc) u32 — HostFn dispatch
//!   jsi_host_arg_scratch(argc) [*]u32      — HostFn argv scratch
//!   bun_malloc(n) u32                      — linear-memory alloc (for host)
//!   bun_free(ptr)                          — linear-memory free

const std = @import("std");
const Timer = @import("timer.zig").Timer;

// ── External JSI / sys_wasm imports (injected via build module map) ──
const jsi = @import("jsi");
const sys_wasm = @import("sys_wasm");

// ── Allocator: wasm_allocator grows the wasm linear memory via memory.grow ──
const allocator = std.heap.wasm_allocator;

// ──────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────

var vfs_g: sys_wasm.VFS = undefined;
var runtime_g: jsi.Runtime = undefined;
var loader_g: ModuleLoader = undefined;
var timer_g: Timer = undefined;
var host_arg_scratch: std.ArrayListUnmanaged(u32) = .{};
var initialized: bool = false;
var g_exit_code: i32 = 0;
var g_explicit_exit: bool = false;
var host_allocs: std.AutoHashMapUnmanaged(u32, usize) = .{};


/// Host clock — provided by `env.jsi_now_ms`.
extern "env" fn jsi_now_ms() u64;

fn clockMs() u64 {
    return jsi_now_ms();
}



// ──────────────────────────────────────────────────────────
// Path utilities  (identical to bun_browser.zig)
// ──────────────────────────────────────────────────────────

fn normPath(alloc: std.mem.Allocator, path: []const u8) std.mem.Allocator.Error![]u8 {
    var parts: std.ArrayListUnmanaged([]const u8) = .{};
    defer parts.deinit(alloc);

    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |seg| {
        if (seg.len == 0 or std.mem.eql(u8, seg, ".")) continue;
        if (std.mem.eql(u8, seg, "..")) {
            if (parts.items.len > 0) parts.shrinkRetainingCapacity(parts.items.len - 1);
        } else {
            try parts.append(alloc, seg);
        }
    }

    var buf: std.ArrayListUnmanaged(u8) = .{};
    for (parts.items) |seg| {
        try buf.append(alloc, '/');
        try buf.appendSlice(alloc, seg);
    }
    if (buf.items.len == 0) try buf.append(alloc, '/');
    return buf.toOwnedSlice(alloc);
}

fn joinPath(alloc: std.mem.Allocator, base_dir: []const u8, rel: []const u8) ![]u8 {
    if (rel.len > 0 and rel[0] == '/') return alloc.dupe(u8, rel);
    const combined = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ base_dir, rel });
    defer alloc.free(combined);
    return normPath(alloc, combined);
}

fn pathDirname(path: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, path, '/')) |idx| {
        return if (idx == 0) "/" else path[0..idx];
    }
    return "/";
}

// ──────────────────────────────────────────────────────────
// CJS Module Loader
// ──────────────────────────────────────────────────────────

const ModuleLoader = struct {
    alloc: std.mem.Allocator,
    vfs: *sys_wasm.VFS,
    rt: *jsi.Runtime,
    cache: std.StringHashMap(u32),
    current_dir: []const u8,

    fn init(alloc_: std.mem.Allocator, v: *sys_wasm.VFS, rt: *jsi.Runtime) ModuleLoader {
        return .{
            .alloc = alloc_,
            .vfs = v,
            .rt = rt,
            .cache = std.StringHashMap(u32).init(alloc_),
            .current_dir = "/",
        };
    }

    fn resolve(self: *ModuleLoader, specifier: []const u8) ![]u8 {
        const abs = try joinPath(self.alloc, self.current_dir, specifier);
        errdefer self.alloc.free(abs);

        if (self.vfs.stat(abs)) |_| return abs else |_| {}

        for ([_][]const u8{ ".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json" }) |ext| {
            const with_ext = try std.fmt.allocPrint(self.alloc, "{s}{s}", .{ abs, ext });
            if (self.vfs.stat(with_ext)) |_| {
                self.alloc.free(abs);
                return with_ext;
            } else |_| self.alloc.free(with_ext);
        }

        return error.ModuleNotFound;
    }

    fn load(self: *ModuleLoader, specifier: []const u8) !u32 {
        const abs_path = try self.resolve(specifier);
        defer self.alloc.free(abs_path);

        if (self.cache.get(abs_path)) |h| return h;

        const source = try self.vfs.readFile(abs_path);
        defer self.alloc.free(source);

        // JSON: eval as expression
        if (std.mem.endsWith(u8, abs_path, ".json")) {
            const eval_code = try std.fmt.allocPrint(self.alloc, "return ({s})", .{source});
            defer self.alloc.free(eval_code);
            const result_handle = jsi.imports.jsi_eval(
                @intFromPtr(eval_code.ptr),
                eval_code.len,
                @intFromPtr(abs_path.ptr),
                abs_path.len,
            );
            if (result_handle == jsi.Value.exception_sentinel) return error.JSIException;
            _ = jsi.imports.jsi_retain(result_handle);
            const key = try self.alloc.dupe(u8, abs_path);
            try self.cache.put(key, result_handle);
            return result_handle;
        }

        // TypeScript: transpile first
        const is_ts = std.mem.endsWith(u8, abs_path, ".ts") or
            std.mem.endsWith(u8, abs_path, ".tsx") or
            std.mem.endsWith(u8, abs_path, ".mts") or
            std.mem.endsWith(u8, abs_path, ".cts");
        const js_source: []const u8 = if (is_ts) blk: {
            const h = jsi.imports.jsi_transpile(
                @intFromPtr(source.ptr),
                source.len,
                @intFromPtr(abs_path.ptr),
                abs_path.len,
            );
            if (h == jsi.Value.exception_sentinel) return error.JSIException;
            defer jsi.imports.jsi_release(h);
            const js_len = jsi.imports.jsi_string_length(h);
            const js_buf = try self.alloc.alloc(u8, js_len);
            jsi.imports.jsi_string_read(h, @intFromPtr(js_buf.ptr), js_len);
            break :blk js_buf;
        } else source;
        defer if (is_ts) self.alloc.free(js_source);

        // Wrap in CJS
        const wrapper = try std.fmt.allocPrint(
            self.alloc,
            "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.require);return __m.exports;",
            .{js_source},
        );
        defer self.alloc.free(wrapper);

        const saved_dir = self.current_dir;
        self.current_dir = pathDirname(abs_path);
        const result_handle = jsi.imports.jsi_eval(
            @intFromPtr(wrapper.ptr),
            wrapper.len,
            @intFromPtr(abs_path.ptr),
            abs_path.len,
        );
        self.current_dir = saved_dir;

        if (result_handle == jsi.Value.exception_sentinel) return error.JSIException;
        _ = jsi.imports.jsi_retain(result_handle);
        const key = try self.alloc.dupe(u8, abs_path);
        try self.cache.put(key, result_handle);
        return result_handle;
    }
};

// ──────────────────────────────────────────────────────────
// process.exit HostFn
// ──────────────────────────────────────────────────────────

fn processExitFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    const code: f64 = if (args.len > 0) jsi.imports.jsi_to_number(args[0].handle) else 0;
    g_exit_code = @intFromFloat(@trunc(code));
    g_explicit_exit = true;
    return error.ProcessExit;
}

// ──────────────────────────────────────────────────────────
// Built-in module sources (path, fs)
// ──────────────────────────────────────────────────────────

const PATH_MODULE_SRC: []const u8 =
    \\const sep = '/';
    \\function normalize(p) {
    \\  const abs = p.startsWith('/');
    \\  const segs = p.split('/').reduce((a, s) => {
    \\    if (s === '' || s === '.') return a;
    \\    if (s === '..') { a.pop(); return a; }
    \\    a.push(s); return a;
    \\  }, []);
    \\  return (abs ? '/' : '') + segs.join('/');
    \\}
    \\function join(...parts) { return normalize(parts.filter(Boolean).join('/')); }
    \\function resolve(...ps) {
    \\  let r = typeof globalThis.__bun_cwd === 'string' ? globalThis.__bun_cwd : '/';
    \\  for (const p of ps) r = p.startsWith('/') ? p : r.endsWith('/') ? r+p : r+'/'+p;
    \\  return normalize(r);
    \\}
    \\function dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? (i===0?'/':'.') : p.slice(0,i); }
    \\function basename(p, ext) { let b = p.split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, b.length - ext.length); return b; }
    \\function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
    \\function isAbsolute(p) { return p.startsWith('/'); }
    \\function relative(from, to) {
    \\  const f = resolve(from).split('/').filter(Boolean);
    \\  const t = resolve(to).split('/').filter(Boolean);
    \\  let i = 0; while (i < f.length && f[i] === t[i]) i++;
    \\  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
    \\}
    \\module.exports = { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, posix: module.exports };
;

const URL_MODULE_SRC: []const u8 =
    \\var _URL=(typeof URL!=='undefined'?URL:(globalThis.URL||null));
    \\function fileURLToPath(url){
    \\  var href=typeof url==='string'?url:url.href;
    \\  if(!_URL)return href.replace(/^file:\/\//,'');
    \\  try{return new _URL(href).pathname;}catch(e){return href;}
    \\}
    \\function pathToFileURL(path){
    \\  var p=path&&path[0]==='/'?path:'/'+path;
    \\  if(_URL)return new _URL('file://'+p);
    \\  return{href:'file://'+p,pathname:p};
    \\}
    \\function parse(urlStr){
    \\  if(!_URL)return null;
    \\  try{var u=new _URL(urlStr);return{href:u.href,protocol:u.protocol,hostname:u.hostname,port:u.port||null,pathname:u.pathname,search:u.search||null,hash:u.hash||null,host:u.host,auth:null};}
    \\  catch(e){return null;}
    \\}
    \\function format(urlObj){
    \\  if(typeof urlObj==='string')return urlObj;
    \\  if(urlObj&&typeof urlObj.href==='string')return urlObj.href;
    \\  return '';
    \\}
    \\module.exports={URL:_URL,fileURLToPath:fileURLToPath,pathToFileURL:pathToFileURL,parse:parse,format:format};
;

const UTIL_MODULE_SRC: []const u8 =
    \\function format(fmt){
    \\  if(typeof fmt!=='string'){var a=Array.prototype.slice.call(arguments);return a.map(function(x){try{return typeof x==='object'&&x!==null?JSON.stringify(x):String(x);}catch(e){return String(x);}}).join(' ');}
    \\  var i=1,args=arguments;
    \\  var s=fmt.replace(/%[sdifjoO%]/g,function(m){
    \\    if(m==='%%')return'%';if(i>=args.length)return m;var v=args[i++];
    \\    if(m==='%s')return String(v);if(m==='%d'||m==='%i')return Math.floor(Number(v));if(m==='%f')return Number(v);
    \\    try{return JSON.stringify(v);}catch(e){return'[Circular]';}
    \\  });
    \\  if(i<args.length)s+=' '+Array.prototype.slice.call(args,i).join(' ');
    \\  return s;
    \\}
    \\function inspect(v){try{return JSON.stringify(v,null,2);}catch(e){return String(v);}}
    \\function promisify(fn){return function(){var a=Array.prototype.slice.call(arguments);return new Promise(function(res,rej){fn.apply(null,a.concat(function(e,v){e?rej(e):res(v);}));});};}
    \\module.exports={format:format,inspect:inspect,promisify:promisify,debuglog:function(){return function(){};},deprecate:function(fn){return fn;},isDeepStrictEqual:function(a,b){return JSON.stringify(a)===JSON.stringify(b);}};
;

const BUFFER_POLYFILL_SRC: []const u8 =
    \\(function(){
    \\  if(globalThis.Buffer&&globalThis.Buffer.isBuffer)return;
    \\  var Buf={
    \\    from:function(src,enc){
    \\      if(typeof src==='string'){
    \\        enc=enc||'utf8';
    \\        if(enc==='hex'){var h=new Uint8Array(src.length>>1);for(var i=0;i<h.length;i++)h[i]=parseInt(src.slice(i*2,i*2+2),16);return Buf._w(h);}
    \\        if(enc==='base64'){var bin=atob(src),b=new Uint8Array(bin.length);for(var j=0;j<bin.length;j++)b[j]=bin.charCodeAt(j);return Buf._w(b);}
    \\        return Buf._w(new TextEncoder().encode(src));
    \\      }
    \\      if(src instanceof ArrayBuffer)return Buf._w(new Uint8Array(src));
    \\      if(ArrayBuffer.isView(src))return Buf._w(new Uint8Array(src.buffer,src.byteOffset,src.byteLength));
    \\      if(Array.isArray(src))return Buf._w(new Uint8Array(src));
    \\      return Buf._w(new Uint8Array(0));
    \\    },
    \\    alloc:function(n,fill){var b=new Uint8Array(n);if(fill!==undefined)b.fill(typeof fill==='number'?fill:fill.charCodeAt(0));return Buf._w(b);},
    \\    allocUnsafe:function(n){return Buf._w(new Uint8Array(n));},
    \\    isBuffer:function(v){return v!=null&&v._isBunBuf===true;},
    \\    concat:function(list,len){
    \\      if(len===undefined)len=list.reduce(function(a,b){return a+b.byteLength;},0);
    \\      var r=new Uint8Array(len),off=0;
    \\      for(var i=0;i<list.length;i++){r.set(list[i],off);off+=list[i].byteLength;}
    \\      return Buf._w(r);
    \\    },
    \\    _w:function(u8){
    \\      Object.defineProperty(u8,'_isBunBuf',{value:true,enumerable:false,configurable:true});
    \\      u8.toString=function(enc){
    \\        enc=enc||'utf8';
    \\        if(enc==='utf8'||enc==='utf-8')return new TextDecoder().decode(this);
    \\        if(enc==='base64')return btoa(String.fromCharCode.apply(null,Array.from(this)));
    \\        if(enc==='hex')return Array.from(this).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    \\        return String.fromCharCode.apply(null,Array.from(this));
    \\      };
    \\      return u8;
    \\    }
    \\  };
    \\  globalThis.Buffer=Buf;
    \\})();
;

fn evalBuiltinSrc(src: []const u8, url: []const u8) !jsi.Value {
    const wrapper = try std.fmt.allocPrint(
        allocator,
        "var __m={{exports:{{}}}};(function(module,exports,require){{{s}\n}})(__m,__m.exports,globalThis.require);return __m.exports;",
        .{src},
    );
    defer allocator.free(wrapper);
    const h = jsi.imports.jsi_eval(@intFromPtr(wrapper.ptr), wrapper.len, @intFromPtr(url.ptr), url.len);
    if (h == jsi.Value.exception_sentinel) return error.JSIException;
    return .{ .handle = h };
}

fn makeFsModule() !jsi.Value {
    const obj = runtime_g.makeObject();
    const fns = [_]struct { name: []const u8, func: jsi.host_function.HostFn }{
        .{ .name = "readFileSync",  .func = fsReadFileSyncFn  },
        .{ .name = "writeFileSync", .func = fsWriteFileSyncFn },
        .{ .name = "existsSync",    .func = fsExistsSyncFn    },
        .{ .name = "mkdirSync",     .func = fsMkdirSyncFn     },
        .{ .name = "readdirSync",   .func = fsReaddirSyncFn   },
        .{ .name = "statSync",      .func = fsStatSyncFn      },
    };
    inline for (fns) |f| {
        const v = try runtime_g.createHostFunction(f.func, f.name, 1);
        runtime_g.setProperty(obj, f.name, v);
    }
    return obj;
}

fn requireFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (!initialized) return jsi.Value.undefined_;
    if (args.len == 0) return jsi.Value.undefined_;

    const len = jsi.imports.jsi_string_length(args[0].handle);
    const specifier = try allocator.alloc(u8, len);
    defer allocator.free(specifier);
    jsi.imports.jsi_string_read(args[0].handle, @intFromPtr(specifier.ptr), len);

    // ── Built-in module interception ──────────────────────
    if (std.mem.eql(u8, specifier, "path") or std.mem.eql(u8, specifier, "node:path")) {
        return evalBuiltinSrc(PATH_MODULE_SRC, "<path>");
    }
    if (std.mem.eql(u8, specifier, "fs") or std.mem.eql(u8, specifier, "node:fs")) {
        return makeFsModule();
    }
    if (std.mem.eql(u8, specifier, "url") or std.mem.eql(u8, specifier, "node:url")) {
        return evalBuiltinSrc(URL_MODULE_SRC, "<url>");
    }
    if (std.mem.eql(u8, specifier, "util") or std.mem.eql(u8, specifier, "node:util")) {
        return evalBuiltinSrc(UTIL_MODULE_SRC, "<util>");
    }

    // ── VFS CJS loader ────────────────────────────────────
    const l = &loader_g;
    const handle = try l.load(specifier);
    _ = jsi.imports.jsi_retain(handle);
    return .{ .handle = handle };
}

// ──────────────────────────────────────────────────────────
// require("fs") HostFunctions
// ──────────────────────────────────────────────────────────

fn fsReadFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const data = vfs_g.readFile(path) catch return error.JSIException;
    defer allocator.free(data);

    // If second arg is "utf8" or "utf-8", return string; else return Buffer-like (ArrayBuffer)
    if (args.len > 1 and jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        return runtime_g.makeString(data);
    }
    return runtime_g.makeArrayBuffer(data, true);
}

fn fsWriteFileSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 2) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);

    // Ensure parent dirs exist
    const dir = pathDirname(path);
    if (!std.mem.eql(u8, dir, "/")) {
        vfs_g.mkdir(dir, 0o755) catch {};
    }

    if (jsi.imports.jsi_typeof(args[1].handle) == @intFromEnum(jsi.TypeTag.string)) {
        const content = try runtime_g.dupeString(args[1]);
        defer allocator.free(content);
        vfs_g.writeFile(path, content, 0o644) catch return error.JSIException;
    } else {
        // ArrayBuffer / Buffer: best-effort — return undefined
    }
    return jsi.Value.undefined_;
}

fn fsExistsSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return runtime_g.makeBool(false);
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const exists = if (vfs_g.stat(path)) |_| true else |_| false;
    return runtime_g.makeBool(exists);
}

fn fsMkdirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return jsi.Value.undefined_;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    vfs_g.mkdir(path, 0o755) catch {};
    return jsi.Value.undefined_;
}

fn fsReaddirSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);

    var entries = std.array_list.Managed(sys_wasm.DirEntry).init(allocator);
    defer {
        for (entries.items) |e| allocator.free(e.name);
        entries.deinit();
    }
    vfs_g.readdir(path, &entries) catch return error.JSIException;

    const arr = runtime_g.makeArray(@intCast(entries.items.len));
    for (entries.items, 0..) |entry, idx| {
        const name_val = runtime_g.makeString(entry.name);
        defer jsi.imports.jsi_release(name_val.handle);
        runtime_g.setIndex(arr, @intCast(idx), name_val);
    }
    return arr;
}

fn fsStatSyncFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len == 0) return error.JSIException;
    const path = try runtime_g.dupeString(args[0]);
    defer allocator.free(path);
    const st = vfs_g.stat(path) catch return error.JSIException;

    const obj = runtime_g.makeObject();
    runtime_g.setProperty(obj, "size", runtime_g.makeNumber(@floatFromInt(st.size)));
    runtime_g.setProperty(obj, "isFile", try runtime_g.createHostFunction(statIsFileFn, "isFile", 0));
    runtime_g.setProperty(obj, "isDirectory", try runtime_g.createHostFunction(statIsDirFn, "isDirectory", 0));
    // store kind as a hidden property for the above callbacks
    runtime_g.setProperty(obj, "__kind", runtime_g.makeNumber(@floatFromInt(@intFromEnum(st.kind))));
    return obj;
}

fn statIsFileFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return runtime_g.makeBool(k == .file);
}

fn statIsDirFn(_: *anyopaque, this_: jsi.Value, _: []const jsi.Value) anyerror!jsi.Value {
    const kind_val = runtime_g.getProperty(this_, "__kind");
    const k: sys_wasm.InodeKind = @enumFromInt(@as(u8, @intFromFloat(jsi.imports.jsi_to_number(kind_val.handle))));
    return runtime_g.makeBool(k == .directory);
}


// ──────────────────────────────────────────────────────────
// console.* HostFunctions
// ──────────────────────────────────────────────────────────

fn consolePrintArgs(args: []const jsi.Value, level: u32) void {
    var buf: std.ArrayListUnmanaged(u8) = .{};
    defer buf.deinit(allocator);

    for (args, 0..) |arg, i| {
        if (i > 0) buf.append(allocator, ' ') catch return;
        const tag = jsi.imports.jsi_typeof(arg.handle);
        switch (tag) {
            4 => { // string
                const len = jsi.imports.jsi_string_length(arg.handle);
                const start = buf.items.len;
                buf.resize(allocator, start + len) catch return;
                jsi.imports.jsi_string_read(arg.handle, @intFromPtr(buf.items.ptr + start), len);
            },
            3 => { // number
                const n = jsi.imports.jsi_to_number(arg.handle);
                if (n == @floor(n) and n >= -1e15 and n <= 1e15) {
                    const i64val: i64 = @intFromFloat(n);
                    var tmp: [32]u8 = undefined;
                    const s = std.fmt.bufPrint(&tmp, "{d}", .{i64val}) catch return;
                    buf.appendSlice(allocator, s) catch return;
                } else {
                    var tmp: [64]u8 = undefined;
                    const s = std.fmt.bufPrint(&tmp, "{d}", .{n}) catch return;
                    buf.appendSlice(allocator, s) catch return;
                }
            },
            2 => { // boolean
                const b = jsi.imports.jsi_to_boolean(arg.handle) != 0;
                buf.appendSlice(allocator, if (b) "true" else "false") catch return;
            },
            0 => buf.appendSlice(allocator, "undefined") catch return,
            1 => buf.appendSlice(allocator, "null") catch return,
            else => buf.appendSlice(allocator, "[object]") catch return,
        }
    }
    buf.append(allocator, '\n') catch return;
    jsi.imports.jsi_print(@intFromPtr(buf.items.ptr), buf.items.len, level);
}

fn consoleLogFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

fn consoleWarnFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

fn consoleErrorFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 2);
    return jsi.Value.undefined_;
}

fn consoleInfoFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

fn consoleDebugFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    consolePrintArgs(args, 1);
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// Timer HostFunctions (timer_g-based)
// ──────────────────────────────────────────────────────────

/// High bit distinguishes timer callback tags from host_function tags.
const TIMER_TAG_BASE: u32 = 0x8000_0000;
const TIMER_TAG_REPEATING: u32 = 0x4000_0000;
const TIMER_TAG_INDEX_MASK: u32 = 0x3fff_ffff;
var timer_cb_table: std.ArrayListUnmanaged(u32) = .{};

/// Stores a JS fn handle in timer_cb_table; returns its tag.
fn callbackTagForHandle(handle: u32, repeating: bool) !u32 {
    const idx: u32 = @intCast(timer_cb_table.items.len);
    if (idx > TIMER_TAG_INDEX_MASK) return error.OutOfMemory;
    try timer_cb_table.append(allocator, handle);
    return TIMER_TAG_BASE |
        (if (repeating) TIMER_TAG_REPEATING else 0) |
        idx;
}

fn releaseTimerTag(tag: u32) void {
    if ((tag & TIMER_TAG_BASE) == 0) return;
    const idx = tag & TIMER_TAG_INDEX_MASK;
    if (idx >= timer_cb_table.items.len) return;

    const cb_handle = timer_cb_table.items[idx];
    if (cb_handle <= jsi.Value.global.handle) return;

    jsi.imports.jsi_release(cb_handle);
    timer_cb_table.items[idx] = jsi.Value.undefined_.handle;
}

/// Called by timer_g.tick() for each expired timer.
fn dispatchTimerCallback(tag: u32) void {
    if ((tag & TIMER_TAG_BASE) == 0) return;
    const is_repeating = (tag & TIMER_TAG_REPEATING) != 0;
    const idx = tag & TIMER_TAG_INDEX_MASK;
    if (idx >= timer_cb_table.items.len) return;
    const cb_handle = timer_cb_table.items[idx];
    if (cb_handle <= jsi.Value.global.handle) return;

    const result = jsi.imports.jsi_call(cb_handle, jsi.Value.undefined_.handle, 0, 0);
    if (result != jsi.Value.exception_sentinel and result > jsi.Value.global.handle) {
        jsi.imports.jsi_release(result);
    }

    if (!is_repeating) {
        releaseTimerTag(tag);
    }
}

fn setTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const delay_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle, false);
    const id = try timer_g.set(delay_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn setIntervalFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len < 1) return jsi.Value.undefined_;
    // jsi_retain returns a NEW independent handle that won't be released by the HostFn wrapper.
    const cb_handle = jsi.imports.jsi_retain(args[0].handle);
    const period_ms: u64 = if (args.len >= 2) @intFromFloat(@max(0, jsi.imports.jsi_to_number(args[1].handle))) else 0;
    const tag = try callbackTagForHandle(cb_handle, true);
    const id = try timer_g.setInterval(period_ms, tag);
    return runtime_g.makeNumber(@floatFromInt(id));
}

fn clearTimeoutFn(_: *anyopaque, _: jsi.Value, args: []const jsi.Value) anyerror!jsi.Value {
    if (args.len >= 1) {
        const id: u32 = @intFromFloat(jsi.imports.jsi_to_number(args[0].handle));
        if (timer_g.callbackTagForId(id)) |tag| {
            releaseTimerTag(tag);
        }
        timer_g.clear(id);
    }
    return jsi.Value.undefined_;
}

// ──────────────────────────────────────────────────────────
// VFS write-file helper (called from Host to add files)
// ──────────────────────────────────────────────────────────

fn setupGlobals(rt: *jsi.Runtime) !void {
    // ── require / process.exit ────────────────────────────
    const require_val = try rt.createHostFunction(requireFn, "__bun_require", 1);
    rt.setProperty(rt.global, "__bun_require", require_val);
    const exit_fn = try rt.createHostFunction(processExitFn, "exit", 1);
    rt.setProperty(rt.global, "__bun_process_exit", exit_fn);

    // ── console ───────────────────────────────────────────
    const log_fn   = try rt.createHostFunction(consoleLogFn,   "log",   0);
    const warn_fn  = try rt.createHostFunction(consoleWarnFn,  "warn",  0);
    const err_fn   = try rt.createHostFunction(consoleErrorFn, "error", 0);
    const info_fn  = try rt.createHostFunction(consoleInfoFn,  "info",  0);
    const debug_fn = try rt.createHostFunction(consoleDebugFn, "debug", 0);
    rt.setProperty(rt.global, "__bun_console_log",   log_fn);
    rt.setProperty(rt.global, "__bun_console_warn",  warn_fn);
    rt.setProperty(rt.global, "__bun_console_error", err_fn);
    rt.setProperty(rt.global, "__bun_console_info",  info_fn);
    rt.setProperty(rt.global, "__bun_console_debug", debug_fn);

    // ── timers ────────────────────────────────────────────
    const set_timeout_fn   = try rt.createHostFunction(setTimeoutFn,  "setTimeout",   2);
    const set_interval_fn  = try rt.createHostFunction(setIntervalFn, "setInterval",  2);
    const clear_timer_fn   = try rt.createHostFunction(clearTimeoutFn,  "clearTimeout", 1);
    rt.setProperty(rt.global, "__bun_set_timeout",   set_timeout_fn);
    rt.setProperty(rt.global, "__bun_set_interval",  set_interval_fn);
    rt.setProperty(rt.global, "__bun_clear_timer",   clear_timer_fn);

    _ = try rt.evalScript(
        \\globalThis.require = globalThis.__bun_require;
        \\delete globalThis.__bun_require;
        \\globalThis.process = {
        \\  version: 'v0.1.0-bun-browser',
        \\  platform: 'browser',
        \\  env: {},
        \\  argv: ['bun'],
        \\  cwd() { return globalThis.__bun_cwd || '/'; },
        \\  exit: globalThis.__bun_process_exit,
        \\  nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); },
        \\};
        \\globalThis.__bun_cwd = '/';
        \\delete globalThis.__bun_process_exit;
        \\// console — assign HostFns directly so deleting globals doesn't break them
        \\globalThis.console = {
        \\  log:   globalThis.__bun_console_log,
        \\  warn:  globalThis.__bun_console_warn,
        \\  error: globalThis.__bun_console_error,
        \\  info:  globalThis.__bun_console_info,
        \\  debug: globalThis.__bun_console_debug,
        \\};
        \\delete globalThis.__bun_console_log;
        \\delete globalThis.__bun_console_warn;
        \\delete globalThis.__bun_console_error;
        \\delete globalThis.__bun_console_info;
        \\delete globalThis.__bun_console_debug;
        \\// timers — assign HostFns directly
        \\globalThis.setTimeout   = globalThis.__bun_set_timeout;
        \\globalThis.setInterval  = globalThis.__bun_set_interval;
        \\globalThis.clearTimeout  = globalThis.__bun_clear_timer;
        \\globalThis.clearInterval = globalThis.__bun_clear_timer;
        \\delete globalThis.__bun_set_timeout;
        \\delete globalThis.__bun_set_interval;
        \\delete globalThis.__bun_clear_timer;
    ,
        "<bun-browser:polyfill>",
    );
    _ = try rt.evalScript(BUFFER_POLYFILL_SRC, "<bun-browser:buffer>");
}

// ──────────────────────────────────────────────────────────
// Exported WASM ABI
// ──────────────────────────────────────────────────────────

export fn bun_browser_init() void {
    if (initialized) return;
    initialized = true;

    vfs_g = sys_wasm.VFS.init(allocator, &clockMs) catch @panic("VFS init OOM");
    runtime_g = jsi.Runtime.init(allocator);
    loader_g = ModuleLoader.init(allocator, &vfs_g, &runtime_g);
    timer_g = Timer.init(allocator, &clockMs);
    setupGlobals(&runtime_g) catch @panic("setupGlobals OOM");
}

/// Drive the WASM-side timer queue.
/// Returns milliseconds until the next timer fires (0 = no pending timers).
/// The host (kernel-worker.ts) should call this every animation frame or after
/// awaiting the returned duration.
export fn bun_tick() u32 {
    if (!initialized) return 0;
    return timer_g.tick(&dispatchTimerCallback);
}

/// Wakeup hook for host-driven loops.
/// The current timer loop is polled by `bun_tick()`, so this is a no-op placeholder
/// kept for ABI compatibility with the browser runtime protocol.
export fn bun_wakeup() void {}

export fn bun_vfs_load_snapshot(ptr: [*]const u8, len: u32) u32 {
    if (!initialized) return 0;
    const count = vfs_g.loadSnapshot(ptr[0..len]) catch return 0;
    return count;
}

export fn bun_browser_run(path_ptr: [*]const u8, path_len: u32) i32 {
    if (!initialized) return 1;
    g_exit_code = 0;
    g_explicit_exit = false;
    const path = path_ptr[0..path_len];
    loader_g.current_dir = pathDirname(path);
    const handle = loader_g.load(path) catch {
        return if (g_explicit_exit) g_exit_code else 2;
    };
    jsi.imports.jsi_release(handle);
    return if (g_explicit_exit) g_exit_code else 0;
}

export fn bun_browser_eval(src_ptr: [*]const u8, src_len: u32, file_ptr: [*]const u8, file_len: u32) i32 {
    if (!initialized) return 1;
    const src = src_ptr[0..src_len];
    const file = file_ptr[0..file_len];
    const result = jsi.imports.jsi_eval(
        @intFromPtr(src.ptr),
        src.len,
        @intFromPtr(file.ptr),
        file.len,
    );
    if (result == jsi.Value.exception_sentinel) return 3;
    jsi.imports.jsi_release(result);
    return 0;
}

/// Synchronously spawn a "bun" sub-process in-process.
///
/// `cmd_ptr/cmd_len` points to a JSON array string, e.g. `["bun","-e","code"]`.
///
/// Supported forms:
///   ["bun", "-e", "<js code>"]      — eval JS inline
///   ["bun", "run", "<vfs path>"]    — load + run from VFS
///
/// Returns the exit code (0 = success).  In Phase 2 this is synchronous;
/// true process isolation is a Phase 4 concern.
export fn bun_spawn(cmd_ptr: [*]const u8, cmd_len: u32) i32 {
    if (!initialized) return 1;

    const cmd_json = cmd_ptr[0..cmd_len];

    // Stash the JSON in a temp global so JS-side JSON.parse can reach it.
    const json_val = runtime_g.makeString(cmd_json);
    defer jsi.imports.jsi_release(json_val.handle);
    runtime_g.setProperty(runtime_g.global, "__spawn_cmd", json_val);

    const parse_src = "var __r=JSON.parse(globalThis.__spawn_cmd);delete globalThis.__spawn_cmd;return __r;";
    const arr = runtime_g.evalScript(parse_src, "<spawn:parse>") catch return 2;
    defer jsi.imports.jsi_release(arr.handle);

    // argv length
    const len_val = runtime_g.getProperty(arr, "length");
    defer jsi.imports.jsi_release(len_val.handle);
    const argc: u32 = @intFromFloat(jsi.imports.jsi_to_number(len_val.handle));

    if (argc == 0) return 1;

    // argv[0] must be "bun"
    const cmd0 = runtime_g.getIndex(arr, 0);
    defer jsi.imports.jsi_release(cmd0.handle);
    if (jsi.imports.jsi_typeof(cmd0.handle) != @intFromEnum(jsi.TypeTag.string)) return 1;
    const exe = runtime_g.dupeString(cmd0) catch return 2;
    defer allocator.free(exe);
    if (!std.mem.eql(u8, exe, "bun")) return 1;

    if (argc < 2) return 0; // bare "bun" — nothing to do

    // argv[1] = subcommand / flag
    const cmd1 = runtime_g.getIndex(arr, 1);
    defer jsi.imports.jsi_release(cmd1.handle);
    const subcmd = runtime_g.dupeString(cmd1) catch return 2;
    defer allocator.free(subcmd);

    g_exit_code = 0;
    g_explicit_exit = false;

    if (std.mem.eql(u8, subcmd, "-e")) {
        // bun -e "<js code>"
        if (argc < 3) return 0;
        const code_val = runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(code_val.handle);
        const code_src = runtime_g.dupeString(code_val) catch return 2;
        defer allocator.free(code_src);

        const url_lit = "<bun:-e>";
        const result = jsi.imports.jsi_eval(
            @intFromPtr(code_src.ptr),
            code_src.len,
            @intFromPtr(url_lit.ptr),
            url_lit.len,
        );
        if (result != jsi.Value.exception_sentinel) {
            jsi.imports.jsi_release(result);
        }
        return if (g_explicit_exit) g_exit_code else 0;
    }

    if (std.mem.eql(u8, subcmd, "run")) {
        // bun run <vfs-path>
        if (argc < 3) return 1;
        const file_val = runtime_g.getIndex(arr, 2);
        defer jsi.imports.jsi_release(file_val.handle);
        const file = runtime_g.dupeString(file_val) catch return 2;
        defer allocator.free(file);

        loader_g.current_dir = pathDirname(file);
        const handle = loader_g.load(file) catch {
            return if (g_explicit_exit) g_exit_code else 2;
        };
        jsi.imports.jsi_release(handle);
        return if (g_explicit_exit) g_exit_code else 0;
    }

    return 0; // unknown subcommand — no-op, treat as success
}

/// Stub: signal a spawned process. Currently all spawns are synchronous and
/// inline, so this is a no-op kept for ABI completeness.
export fn bun_kill(_: u32, _: u32) void {}

/// Stub: write to a spawned process's stdin.
export fn bun_feed_stdin(_: u32, _: [*]const u8, _: u32) void {}

/// Stub: close a spawned process's stdin.
export fn bun_close_stdin(_: u32) void {}

export fn jsi_host_invoke(fn_id: u32, this_handle: u32, argv_ptr: [*]const u32, argc: u32) u32 {
    if (!initialized) return jsi.Value.exception_sentinel;

    // argv_ptr may alias host_arg_scratch memory (set by jsi_host_arg_scratch).
    // Copy args to a stack-local temp BEFORE mutating the scratch buffer.
    var args_tmp: [64]u32 = undefined;
    const safe_count = @min(argc, args_tmp.len);
    for (0..safe_count) |i| args_tmp[i] = argv_ptr[i];

    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.append(allocator, this_handle) catch return jsi.Value.exception_sentinel;
    host_arg_scratch.appendSlice(allocator, args_tmp[0..safe_count]) catch return jsi.Value.exception_sentinel;

    return jsi.host_function.dispatchHostFn(
        &runtime_g.host_fns,
        @as(*anyopaque, @ptrCast(&runtime_g)),
        fn_id,
        host_arg_scratch.items,
    );
}

export fn jsi_host_arg_scratch(argc: u32) [*]u32 {
    host_arg_scratch.clearRetainingCapacity();
    host_arg_scratch.resize(allocator, argc) catch @panic("host_arg_scratch OOM");
    return host_arg_scratch.items.ptr;
}

/// Simple malloc/free for host-side read/write of WASM linear memory.
export fn bun_malloc(n: u32) u32 {
    const alloc_len: usize = if (n == 0) 1 else n;
    const buf = allocator.alloc(u8, alloc_len) catch return 0;
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));

    host_allocs.put(allocator, ptr, alloc_len) catch {
        allocator.free(buf);
        return 0;
    };

    return ptr;
}

export fn bun_free(ptr: u32) void {
    if (host_allocs.fetchRemove(ptr)) |entry| {
        const p: [*]u8 = @ptrFromInt(entry.key);
        allocator.free(p[0..entry.value]);
    }
}
