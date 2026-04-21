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

/// Bun 全局对象 polyfill。
/// Bun.serve({ fetch, port? }) — 注册路由到 `globalThis.__bun_routes`；Host 侧可通过
/// `kernel.fetch(port, init)` 把请求派发给已注册的 fetch handler。
/// 端口 0 或缺省时自动分配（从 40000 起递增）。
/// RFC Phase 3 T3.4：最小可工作的 Bun.serve 注入；真实 TCP 在 Phase 4+。
const BUN_GLOBAL_SRC: []const u8 =
    \\(function(){
    \\  if(globalThis.__bun_wasm_serve_installed)return;
    \\  globalThis.__bun_wasm_serve_installed=true;
    \\  globalThis.__bun_routes=globalThis.__bun_routes||Object.create(null);
    \\  globalThis.__bun_next_port=globalThis.__bun_next_port||40000;
    \\  function serve(opts){
    \\    if(!opts||typeof opts.fetch!=='function')throw new TypeError('Bun.serve requires { fetch }');
    \\    var port=opts.port;
    \\    if(port===undefined||port===0)port=globalThis.__bun_next_port++;
    \\    globalThis.__bun_routes[port]={fetch:opts.fetch,hostname:opts.hostname||'localhost',development:!!opts.development};
    \\    return {
    \\      port:port,
    \\      hostname:opts.hostname||'localhost',
    \\      url:new URL('http://'+(opts.hostname||'localhost')+':'+port+'/'),
    \\      stop:function(){delete globalThis.__bun_routes[port];},
    \\      reload:function(newOpts){if(newOpts&&typeof newOpts.fetch==='function')globalThis.__bun_routes[port].fetch=newOpts.fetch;},
    \\      development:!!opts.development,
    \\      pendingRequests:0,
    \\      pendingWebSockets:0,
    \\      publish:function(){return 0;},
    \\      upgrade:function(){return false;},
    \\      requestIP:function(){return null;},
    \\      timeout:function(){},
    \\      unref:function(){return this;},
    \\      ref:function(){return this;},
    \\    };
    \\  }
    \\  /** Host 派发入口：Host 侧拿到 Response 后序列化；此函数返回 Promise<Response>。 */
    \\  function __dispatch(port,reqInit){
    \\    var route=globalThis.__bun_routes[port];
    \\    if(!route)return Promise.resolve(new Response('no route for port '+port,{status:502}));
    \\    try{
    \\      var url=reqInit.url||('http://localhost:'+port+'/');
    \\      var init={method:reqInit.method||'GET'};
    \\      if(reqInit.headers)init.headers=reqInit.headers;
    \\      if(reqInit.body!==undefined&&reqInit.body!==null)init.body=reqInit.body;
    \\      var req=new Request(url,init);
    \\      return Promise.resolve(route.fetch(req));
    \\    }catch(e){return Promise.resolve(new Response(String(e),{status:500}));}
    \\  }
    \\  // 若宿主 global 已有真实 Bun（Bun 自身进程/Worker 中 `globalThis.Bun` 为 non-configurable），
    \\  // 我们保存它到 `__bun_real_Bun`，然后尝试把 Bun 整体替换为 WASM 版本。
    \\  // 若替换失败（non-configurable），退化为在真实 Bun 上逐属性覆盖 serve/version。
    \\  var __bunObj={serve:serve,version:'0.1.0-bun-browser'};
    \\  if(globalThis.Bun&&globalThis.Bun.serve)globalThis.__bun_real_Bun=globalThis.Bun;
    \\  var __replaced=false;
    \\  try{Object.defineProperty(globalThis,'Bun',{value:__bunObj,writable:true,configurable:true});__replaced=(globalThis.Bun===__bunObj);}catch(_e){}
    \\  if(!__replaced){try{globalThis.Bun=__bunObj;__replaced=(globalThis.Bun===__bunObj);}catch(_e){}}
    \\  if(!__replaced&&globalThis.Bun){
    \\    try{Object.defineProperty(globalThis.Bun,'serve',{value:serve,writable:true,configurable:true});}catch(_e){try{globalThis.Bun.serve=serve;}catch(_e2){}}
    \\  }
    \\  globalThis.__bun_dispatch_fetch=__dispatch;
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
    _ = try rt.evalScript(BUN_GLOBAL_SRC, "<bun-browser:Bun>");
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

// ──────────────────────────────────────────────────────────
// Phase 1 T1.1：bun_lockfile_parse（最小可验证切片）
//
// 输入：bun.lock 文本（v1 JSON 格式）的 UTF-8 字节流。
// 输出：指向 host_allocs 登记的 JSON 摘要字符串的指针，编码为 u64：
//         高 32 位 = ptr（需由 host 调用 bun_free 释放）
//         低 32 位 = len
//       若 ptr == 0 则解析失败；此时低 32 位是错误码（1 = OOM / 2 = JSON 语法 / 3 = 缺 lockfileVersion）。
//
// 摘要 JSON：{ "lockfileVersion": N, "workspaceCount": N, "packageCount": N,
//              "packages": [{ "key": "...", "name": "...", "version": "..." }, ...] }
//
// 对应 RFC：docs/rfc/bun-wasm-browser-runtime-implementation-plan.md §4.3 T1.1
// 当前实现不依赖 src/install/lockfile.zig（该模块强耦合 JSC/PackageManager），
// 而是直接对 bun.lock 的 JSON 表示做轻量提取，满足 Phase 1 验收条件
// "bun_lockfile_parse 能解析一个真实 bun.lock 文件"。
// ──────────────────────────────────────────────────────────

fn packResult(ptr: u32, len: u32) u64 {
    return (@as(u64, ptr) << 32) | @as(u64, len);
}

fn packError(code: u32) u64 {
    return @as(u64, code);
}

/// 将 buf 所有权转交给 host_allocs，返回打包后的 (ptr, len)。
fn handOff(buf: []u8) u64 {
    const ptr: u32 = @intCast(@intFromPtr(buf.ptr));
    host_allocs.put(allocator, ptr, buf.len) catch {
        allocator.free(buf);
        return packError(1);
    };
    return packResult(ptr, @intCast(buf.len));
}

export fn bun_lockfile_parse(src_ptr: [*]const u8, src_len: u32) u64 {
    if (!initialized) return packError(1);
    const raw = src_ptr[0..src_len];

    // bun.lock 是 JSON5-风味文本（允许尾随逗号），std.json 不支持；
    // 用一个最小预处理：删除对象/数组闭合括号前的尾随逗号。
    // 同时保留字符串内的逗号。
    const preprocessed = stripTrailingCommas(allocator, raw) catch return packError(1);
    defer allocator.free(preprocessed);

    var parsed = std.json.parseFromSlice(
        std.json.Value,
        allocator,
        preprocessed,
        .{ .duplicate_field_behavior = .use_last },
    ) catch return packError(2);
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) return packError(2);

    const version_node = root.object.get("lockfileVersion") orelse return packError(3);
    const version_num: i64 = switch (version_node) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => return packError(3),
    };

    // 组装摘要
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    appendFmt(&out, "{{\"lockfileVersion\":{d}", .{version_num}) catch return packError(1);

    var workspace_count: usize = 0;
    if (root.object.get("workspaces")) |ws| switch (ws) {
        .object => |obj| workspace_count = obj.count(),
        else => {},
    };
    appendFmt(&out, ",\"workspaceCount\":{d}", .{workspace_count}) catch return packError(1);

    var package_count: usize = 0;
    if (root.object.get("packages")) |pkgs| switch (pkgs) {
        .object => |obj| package_count = obj.count(),
        else => {},
    };
    appendFmt(&out, ",\"packageCount\":{d},\"packages\":[", .{package_count}) catch return packError(1);

    // Enumerate packages when present. bun.lock 格式：
    //   "packages": { "<key>": ["<name>@<spec>", ...], ... }
    if (root.object.get("packages")) |pkgs| if (pkgs == .object) {
        var it = pkgs.object.iterator();
        var first = true;
        while (it.next()) |entry| {
            if (!first) out.append(allocator, ',') catch return packError(1);
            first = false;
            const key = entry.key_ptr.*;
            var pkg_name: []const u8 = key;
            var pkg_version: []const u8 = "";
            if (entry.value_ptr.* == .array and entry.value_ptr.array.items.len >= 1 and entry.value_ptr.array.items[0] == .string) {
                const spec = entry.value_ptr.array.items[0].string;
                if (std.mem.lastIndexOfScalar(u8, spec, '@')) |at| {
                    if (at > 0) {
                        pkg_name = spec[0..at];
                        pkg_version = spec[at + 1 ..];
                    }
                }
            }
            out.appendSlice(allocator, "{\"key\":") catch return packError(1);
            jsonEscapeTo(&out, key) catch return packError(1);
            out.appendSlice(allocator, ",\"name\":") catch return packError(1);
            jsonEscapeTo(&out, pkg_name) catch return packError(1);
            out.appendSlice(allocator, ",\"version\":") catch return packError(1);
            jsonEscapeTo(&out, pkg_version) catch return packError(1);
            out.append(allocator, '}') catch return packError(1);
        }
    };

    out.appendSlice(allocator, "]}") catch return packError(1);
    const owned = out.toOwnedSlice(allocator) catch return packError(1);
    return handOff(owned);
}

fn appendFmt(out: *std.ArrayList(u8), comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error!void {
    const needed = std.fmt.count(fmt, args);
    try out.ensureUnusedCapacity(allocator, needed);
    var buf: [128]u8 = undefined;
    if (needed <= buf.len) {
        const s = std.fmt.bufPrint(&buf, fmt, args) catch unreachable;
        try out.appendSlice(allocator, s);
    } else {
        const heap = try allocator.alloc(u8, needed);
        defer allocator.free(heap);
        const s = std.fmt.bufPrint(heap, fmt, args) catch unreachable;
        try out.appendSlice(allocator, s);
    }
}

fn jsonEscapeTo(out: *std.ArrayList(u8), s: []const u8) std.mem.Allocator.Error!void {
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            0...0x08, 0x0b, 0x0c, 0x0e...0x1f => {
                var buf: [6]u8 = undefined;
                const formatted = std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c}) catch unreachable;
                try out.appendSlice(allocator, formatted);
            },
            else => try out.append(allocator, c),
        }
    }
    try out.append(allocator, '"');
}

/// 去除对象/数组闭合括号前的尾随逗号。字符串字面量内的逗号保持不变。
/// 不支持 JSON5 注释（bun.lock 也不写注释）。
fn stripTrailingCommas(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    try out.ensureTotalCapacity(alloc, src.len);

    var i: usize = 0;
    var in_string: bool = false;
    var escape: bool = false;
    while (i < src.len) : (i += 1) {
        const c = src[i];
        if (in_string) {
            try out.append(alloc, c);
            if (escape) {
                escape = false;
            } else if (c == '\\') {
                escape = true;
            } else if (c == '"') {
                in_string = false;
            }
            continue;
        }
        if (c == '"') {
            in_string = true;
            try out.append(alloc, c);
            continue;
        }
        if (c == ',') {
            // 向前看，跳过空白与换行；若首个非空白字符是 } 或 ]，丢弃逗号。
            var j = i + 1;
            while (j < src.len) : (j += 1) {
                const cj = src[j];
                if (cj == ' ' or cj == '\t' or cj == '\n' or cj == '\r') continue;
                break;
            }
            if (j < src.len and (src[j] == '}' or src[j] == ']')) {
                continue; // 丢弃这个逗号
            }
        }
        try out.append(alloc, c);
    }
    return out.toOwnedSlice(alloc);
}

// ──────────────────────────────────────────────────────────
// Phase 1 T1.1：bun_resolve / bun_bundle (最小可验证切片)
//
// 这两个导出与 bun_lockfile_parse 共用 packError / packResult / handOff 协议。
// 设计原则与 lockfile 一致：standalone WASM 不链接 src/resolver/ 与 src/bundler/
// （它们强依赖 JSC / AnyEventLoop），因此在 VFS 之上做一份满足 RFC Phase 1 验收
// 的最小实现——足以支撑 "输入 TypeScript → 点击 Transform → Bundle 输出 JS"。
// ──────────────────────────────────────────────────────────

/// 将 `specifier` 解析为 VFS 绝对路径，使用 Node/bun 风格的扩展名探测与 index.*。
/// 结果 JSON：`{ "path": "...", "loader": "ts|tsx|js|mjs|cjs|json" }`
/// 错误码：1 = OOM，2 = 未找到模块，3 = 空 specifier，4 = 裸包（尚未支持）。
export fn bun_resolve(
    spec_ptr: [*]const u8,
    spec_len: u32,
    from_ptr: [*]const u8,
    from_len: u32,
) u64 {
    if (!initialized) return packError(1);
    const spec = spec_ptr[0..spec_len];
    const from = from_ptr[0..from_len];
    if (spec.len == 0) return packError(3);

    // base_dir 优先使用 from 文件的 dirname；from 为空或非绝对路径时退化到 /
    const base_dir: []const u8 = if (from.len > 0 and from[0] == '/') pathDirname(from) else "/";

    // 裸包（例如 "react"）：不以 / . 开头
    const is_bare = !(spec[0] == '/' or spec[0] == '.');
    if (is_bare) {
        // 在 VFS 中可能仍有 /node_modules/<spec>/package.json —— 尝试作为最小支持
        const resolved = resolveBareInVfs(allocator, base_dir, spec) catch |err| switch (err) {
            error.OutOfMemory => return packError(1),
            error.ModuleNotFound => return packError(4),
        };
        defer allocator.free(resolved.path);
        return emitResolveResult(resolved.path, resolved.loader);
    }

    const resolved = resolveRelative(allocator, base_dir, spec) catch |err| switch (err) {
        error.OutOfMemory => return packError(1),
        error.ModuleNotFound => return packError(2),
    };
    defer allocator.free(resolved.path);
    return emitResolveResult(resolved.path, resolved.loader);
}

/// Phase 1 T1.1：单入口打包器。
/// 输入：`entry` —— VFS 绝对路径。
/// 输出：self-contained IIFE JS，安装一张 __modules__ 表并执行入口。
///
/// 错误码：1 = OOM / 2 = 入口找不到 / 3 = 循环依赖超出深度 / 4 = 转译失败。
export fn bun_bundle(entry_ptr: [*]const u8, entry_len: u32) u64 {
    if (!initialized) return packError(1);
    const entry = entry_ptr[0..entry_len];

    var bundler = Bundler.init(allocator) catch return packError(1);
    defer bundler.deinit();

    bundler.addEntry(entry) catch |err| switch (err) {
        error.OutOfMemory => return packError(1),
        error.ModuleNotFound => return packError(2),
        error.TooDeep => return packError(3),
        error.TranspileFailed => return packError(4),
    };

    const emitted = bundler.emit() catch return packError(1);
    return handOff(emitted);
}

const ResolveResult = struct { path: []u8, loader: []const u8 };

fn classifyLoader(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".tsx")) return "tsx";
    if (std.mem.endsWith(u8, path, ".ts")) return "ts";
    if (std.mem.endsWith(u8, path, ".mts")) return "ts";
    if (std.mem.endsWith(u8, path, ".cts")) return "ts";
    if (std.mem.endsWith(u8, path, ".jsx")) return "jsx";
    if (std.mem.endsWith(u8, path, ".mjs")) return "mjs";
    if (std.mem.endsWith(u8, path, ".cjs")) return "cjs";
    if (std.mem.endsWith(u8, path, ".json")) return "json";
    return "js";
}

/// 尝试以下次序：
///   1. `base/spec` 原样（如果存在，且是文件）
///   2. `base/spec{ext}` for ext in .ts .tsx .mts .cts .mjs .cjs .js .jsx .json
///   3. `base/spec/index{ext}` for ext ...
fn resolveRelative(alloc: std.mem.Allocator, base_dir: []const u8, spec: []const u8) !ResolveResult {
    const abs = try joinPath(alloc, base_dir, spec);
    if (isFile(abs)) {
        return .{ .path = abs, .loader = classifyLoader(abs) };
    }

    const exts = [_][]const u8{ ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json" };
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}{s}", .{ abs, ext });
        if (isFile(p)) {
            alloc.free(abs);
            return .{ .path = p, .loader = classifyLoader(p) };
        }
        alloc.free(p);
    }
    // index.* 探测
    for (exts) |ext| {
        const p = try std.fmt.allocPrint(alloc, "{s}/index{s}", .{ abs, ext });
        if (isFile(p)) {
            alloc.free(abs);
            return .{ .path = p, .loader = classifyLoader(p) };
        }
        alloc.free(p);
    }
    alloc.free(abs);
    return error.ModuleNotFound;
}

fn resolveBareInVfs(alloc: std.mem.Allocator, base_dir: []const u8, name: []const u8) !ResolveResult {
    // 自下而上查找 /node_modules/<name>
    var cur: []const u8 = base_dir;
    while (true) {
        const nm_root = try std.fmt.allocPrint(alloc, "{s}/node_modules/{s}", .{ cur, name });
        defer alloc.free(nm_root);
        if (isDir(nm_root)) {
            return resolveRelative(alloc, nm_root, ".");
        }
        if (std.mem.eql(u8, cur, "/")) break;
        cur = pathDirname(cur);
    }
    return error.ModuleNotFound;
}

fn isFile(path: []const u8) bool {
    const st = vfs_g.stat(path) catch return false;
    return st.kind == .file;
}

fn isDir(path: []const u8) bool {
    const st = vfs_g.stat(path) catch return false;
    return st.kind == .directory;
}

fn emitResolveResult(path: []const u8, loader: []const u8) u64 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    out.appendSlice(allocator, "{\"path\":") catch return packError(1);
    jsonEscapeTo(&out, path) catch return packError(1);
    out.appendSlice(allocator, ",\"loader\":") catch return packError(1);
    jsonEscapeTo(&out, loader) catch return packError(1);
    out.append(allocator, '}') catch return packError(1);
    const owned = out.toOwnedSlice(allocator) catch return packError(1);
    return handOff(owned);
}

// ──────────────────────────────────────────────────────────
// Bundler (Phase 1 T1.1 最小可验证切片)
//
// 策略：
//   1. 从 entry 开始 DFS，每个文件：读取 → 转译（.ts/.tsx）→ 扫描 require("...")
//      与 import ... from "..."（静态形式）与 import("...")。
//   2. 按解析顺序分配 numeric id，建 __modules__ 表。
//   3. 输出一个 IIFE，包含所有模块的工厂函数 + __require() 实现。
//
// 限制（已在 commit message 明文标注）：
//   - 仅支持静态字符串 specifier；`require(expr)` 不处理。
//   - 不做 tree-shaking、代码压缩。
//   - ES module 的 import 统一转为 CJS 语义（转译器已经把 import/export 降级为 CJS）。
// ──────────────────────────────────────────────────────────

const Bundler = struct {
    alloc: std.mem.Allocator,
    /// absPath → id
    by_path: std.StringHashMap(u32),
    /// 按顺序持有：每项为 { path, js_source, deps: []DepEdge }
    entries: std.ArrayListUnmanaged(BundleEntry),
    entry_id: u32 = 0,

    const BundleEntry = struct {
        path: []u8,
        js_source: []u8,
        deps: std.ArrayListUnmanaged(DepEdge) = .{},
    };
    const DepEdge = struct {
        specifier: []u8,
        target_id: u32,
    };

    const BundlerError = error{
        OutOfMemory,
        ModuleNotFound,
        TooDeep,
        TranspileFailed,
    };

    fn init(alloc: std.mem.Allocator) BundlerError!Bundler {
        return .{
            .alloc = alloc,
            .by_path = std.StringHashMap(u32).init(alloc),
            .entries = .{},
        };
    }

    fn deinit(self: *Bundler) void {
        var it = self.by_path.iterator();
        while (it.next()) |e| self.alloc.free(e.key_ptr.*);
        self.by_path.deinit();
        for (self.entries.items) |*e| {
            self.alloc.free(e.path);
            self.alloc.free(e.js_source);
            for (e.deps.items) |*d| self.alloc.free(d.specifier);
            e.deps.deinit(self.alloc);
        }
        self.entries.deinit(self.alloc);
    }

    fn addEntry(self: *Bundler, entry_path: []const u8) BundlerError!void {
        self.entry_id = try self.addFile(entry_path, "/", 0);
    }

    fn addFile(self: *Bundler, specifier: []const u8, base_dir: []const u8, depth: u32) BundlerError!u32 {
        if (depth > 256) return error.TooDeep;

        const resolved = resolveRelative(self.alloc, base_dir, specifier) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.ModuleNotFound => return error.ModuleNotFound,
        };

        if (self.by_path.get(resolved.path)) |id| {
            self.alloc.free(resolved.path);
            return id;
        }

        // 读取 & 转译
        const raw = vfs_g.readFile(resolved.path) catch {
            self.alloc.free(resolved.path);
            return error.ModuleNotFound;
        };
        defer self.alloc.free(raw);

        const js = transpileIfNeeded(self.alloc, resolved.path, raw) catch |err| switch (err) {
            error.OutOfMemory => {
                self.alloc.free(resolved.path);
                return error.OutOfMemory;
            },
            error.TranspileFailed => {
                self.alloc.free(resolved.path);
                return error.TranspileFailed;
            },
        };

        const id: u32 = @intCast(self.entries.items.len);
        try self.by_path.put(try self.alloc.dupe(u8, resolved.path), id);
        try self.entries.append(self.alloc, .{
            .path = resolved.path,
            .js_source = js,
            .deps = .{},
        });

        // 扫描依赖并递归加载（先占位再填充 deps，避免自递归时 id 未分配）
        var deps = scanDependencies(self.alloc, js) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
        };
        errdefer {
            for (deps.items) |*d| self.alloc.free(d.specifier);
            deps.deinit(self.alloc);
        }

        const this_dir = pathDirname(self.entries.items[id].path);
        var i: usize = 0;
        while (i < deps.items.len) : (i += 1) {
            // JSON 或裸包：跳过（作为缺失依赖保留 specifier，但不递归）
            const child_id = self.addFile(deps.items[i].specifier, this_dir, depth + 1) catch |err| switch (err) {
                error.ModuleNotFound => {
                    // 将其标记为 -1 (0xffffffff) —— 运行时报错而非编译期失败，方便调试
                    deps.items[i].target_id = std.math.maxInt(u32);
                    continue;
                },
                else => return err,
            };
            deps.items[i].target_id = child_id;
        }
        self.entries.items[id].deps = deps;
        return id;
    }

    fn emit(self: *Bundler) std.mem.Allocator.Error![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(self.alloc);
        try out.appendSlice(self.alloc,
            \\(function(){
            \\var __modules__=[];
            \\var __cache__={};
            \\function __require(id){
            \\  if(id<0||id>=__modules__.length)throw new Error("module id out of range: "+id);
            \\  if(__cache__[id])return __cache__[id].exports;
            \\  var m={exports:{}};__cache__[id]=m;
            \\  __modules__[id].call(m.exports,m,m.exports,function(spec){
            \\    var t=__modules__[id].__deps__[spec];
            \\    if(t===undefined)throw new Error("unresolved dependency "+spec+" in module "+id);
            \\    return __require(t);
            \\  });
            \\  return m.exports;
            \\}
            \\
        );
        // 每个模块：
        //   __modules__[i]=function(module,exports,require){ ...js... };
        //   __modules__[i].__deps__={ "<spec>": id, ... };
        for (self.entries.items, 0..) |entry, i| {
            try appendFmt(&out, "__modules__[{d}]=function(module,exports,require){{\n", .{i});
            try out.appendSlice(self.alloc, entry.js_source);
            try out.appendSlice(self.alloc, "\n};\n");
            try appendFmt(&out, "__modules__[{d}].__deps__={{", .{i});
            for (entry.deps.items, 0..) |dep, di| {
                if (di != 0) try out.append(self.alloc, ',');
                try jsonEscapeTo(&out, dep.specifier);
                if (dep.target_id == std.math.maxInt(u32)) {
                    try appendFmt(&out, ":-1", .{});
                } else {
                    try appendFmt(&out, ":{d}", .{dep.target_id});
                }
            }
            try out.appendSlice(self.alloc, "};\n");
        }
        try appendFmt(&out, "return __require({d});\n}})();\n", .{self.entry_id});
        return out.toOwnedSlice(self.alloc);
    }
};

fn transpileIfNeeded(alloc: std.mem.Allocator, path: []const u8, src: []const u8) error{ OutOfMemory, TranspileFailed }![]u8 {
    const is_ts = std.mem.endsWith(u8, path, ".ts") or
        std.mem.endsWith(u8, path, ".tsx") or
        std.mem.endsWith(u8, path, ".mts") or
        std.mem.endsWith(u8, path, ".cts");
    if (std.mem.endsWith(u8, path, ".json")) {
        // JSON 作为模块：包装成 module.exports = <json>
        return std.fmt.allocPrint(alloc, "module.exports={s};", .{src}) catch error.OutOfMemory;
    }
    if (!is_ts) return alloc.dupe(u8, src) catch error.OutOfMemory;

    const h = jsi.imports.jsi_transpile(
        @intFromPtr(src.ptr),
        src.len,
        @intFromPtr(path.ptr),
        path.len,
    );
    if (h == jsi.Value.exception_sentinel) return error.TranspileFailed;
    defer jsi.imports.jsi_release(h);
    const js_len = jsi.imports.jsi_string_length(h);
    const js_buf = alloc.alloc(u8, js_len) catch return error.OutOfMemory;
    jsi.imports.jsi_string_read(h, @intFromPtr(js_buf.ptr), js_len);
    return js_buf;
}

/// 扫描源码中的 `require("...")`, `require('...')`, `import ... from "..."`,
/// `import "..."`, 和 `import("...")`。
/// 仅处理静态字符串 specifier。忽略字符串/注释中的匹配（简单状态机）。
fn scanDependencies(alloc: std.mem.Allocator, src: []const u8) error{OutOfMemory}!std.ArrayListUnmanaged(Bundler.DepEdge) {
    var out: std.ArrayListUnmanaged(Bundler.DepEdge) = .{};
    errdefer {
        for (out.items) |*d| alloc.free(d.specifier);
        out.deinit(alloc);
    }

    // 先剥离注释 + 字符串（替换为等长空格），再做简单 substring 扫描，
    // 这样 scanner 逻辑简单且不会把 "require(" 在字符串里误匹配。
    const sanitized = stripCommentsAndStrings(alloc, src) catch return error.OutOfMemory;
    defer alloc.free(sanitized);

    var i: usize = 0;
    while (i < sanitized.len) {
        const next = findNextImportSite(sanitized, i) orelse break;
        // 从 next.after_paren_or_from 开始找字符串字面量
        const spec = extractStringFromOriginal(src, next.quote_search_from) orelse {
            i = next.advance_past;
            continue;
        };
        const copy = alloc.dupe(u8, spec.value) catch return error.OutOfMemory;
        try out.append(alloc, .{ .specifier = copy, .target_id = 0 });
        i = spec.end_in_src;
    }
    return out;
}

const ImportSite = struct {
    /// 原始源码里字符串字面量可能开始的位置（含前导空白）。
    quote_search_from: usize,
    /// sanitized 扫描指针下一步应跳到的位置。
    advance_past: usize,
};

fn findNextImportSite(san: []const u8, from: usize) ?ImportSite {
    var i: usize = from;
    while (i < san.len) : (i += 1) {
        // 形如 `require(` — 需 'e','q','u','i','r','e','(' 且前一个字符为 identifier-stop
        if (san[i] == 'r' and san.len - i >= 8 and std.mem.startsWith(u8, san[i..], "require(")) {
            if (isIdentBoundary(san, i)) {
                return .{ .quote_search_from = i + 8, .advance_past = i + 8 };
            }
        }
        // `import "x"` / `import('x')` / `import x from "x"` / `export ... from "x"`
        if ((san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import ")) or
            (san[i] == 'i' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "import(")) or
            (san[i] == 'e' and san.len - i >= 7 and std.mem.startsWith(u8, san[i..], "export ")))
        {
            if (!isIdentBoundary(san, i)) continue;
            // 从此开始寻找第一个 "from " 或直接的字符串字面量
            const fromIdx = findKeywordFromOrQuote(san, i + 6);
            if (fromIdx) |p| return .{ .quote_search_from = p, .advance_past = p };
        }
    }
    return null;
}

fn isIdentBoundary(san: []const u8, at: usize) bool {
    if (at == 0) return true;
    const p = san[at - 1];
    if (p >= 'a' and p <= 'z') return false;
    if (p >= 'A' and p <= 'Z') return false;
    if (p >= '0' and p <= '9') return false;
    if (p == '_' or p == '$') return false;
    return true;
}

fn findKeywordFromOrQuote(san: []const u8, start: usize) ?usize {
    var i: usize = start;
    while (i < san.len) : (i += 1) {
        const c = san[i];
        if (c == '"' or c == '\'') return i;
        if (c == ';' or c == '\n') {
            // 结束 import 语句
            // 但 export 可能跨多行；接受之
            if (c == ';') return null;
        }
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from ") and isIdentBoundary(san, i)) {
            // 跳过 "from "，继续寻找引号
            return findQuote(san, i + 5);
        }
        if (c == 'f' and san.len - i >= 5 and std.mem.eql(u8, san[i .. i + 5], "from\t") and isIdentBoundary(san, i)) {
            return findQuote(san, i + 5);
        }
    }
    return null;
}

fn findQuote(san: []const u8, start: usize) ?usize {
    var i: usize = start;
    while (i < san.len) : (i += 1) {
        const c = san[i];
        if (c == '"' or c == '\'') return i;
        if (c == ';' or c == '\n') return null;
    }
    return null;
}

const StringLiteral = struct { value: []const u8, end_in_src: usize };

fn extractStringFromOriginal(src: []const u8, from: usize) ?StringLiteral {
    var i: usize = from;
    while (i < src.len and (src[i] == ' ' or src[i] == '\t')) : (i += 1) {}
    if (i >= src.len) return null;
    const q = src[i];
    if (q != '"' and q != '\'') return null;
    const start = i + 1;
    var j: usize = start;
    while (j < src.len) : (j += 1) {
        const c = src[j];
        if (c == '\\') {
            j += 1;
            continue;
        }
        if (c == q) break;
    }
    if (j >= src.len) return null;
    return .{ .value = src[start..j], .end_in_src = j + 1 };
}

/// 将 src 中的字符串/模板/注释替换为等长空白（换行保留以保持行号）。
fn stripCommentsAndStrings(alloc: std.mem.Allocator, src: []const u8) std.mem.Allocator.Error![]u8 {
    const out = try alloc.alloc(u8, src.len);
    @memcpy(out, src);
    var i: usize = 0;
    while (i < out.len) {
        const c = out[i];
        if (c == '/' and i + 1 < out.len and out[i + 1] == '/') {
            // 行注释
            while (i < out.len and out[i] != '\n') : (i += 1) out[i] = ' ';
            continue;
        }
        if (c == '/' and i + 1 < out.len and out[i + 1] == '*') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            while (i + 1 < out.len and !(out[i] == '*' and out[i + 1] == '/')) : (i += 1) {
                if (out[i] != '\n') out[i] = ' ';
            }
            if (i + 1 < out.len) {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
            }
            continue;
        }
        if (c == '"' or c == '\'' or c == '`') {
            const quote = c;
            out[i] = ' ';
            i += 1;
            while (i < out.len) {
                if (out[i] == '\\' and i + 1 < out.len) {
                    out[i] = ' ';
                    if (out[i + 1] != '\n') out[i + 1] = ' ';
                    i += 2;
                    continue;
                }
                if (out[i] == quote) {
                    out[i] = ' ';
                    i += 1;
                    break;
                }
                if (out[i] != '\n') out[i] = ' ';
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    return out;
}
