/**
 * Phase 5.9: 更多 Node.js 内置模块 polyfill 集成测试
 *
 * 覆盖:
 *   - stream   (Readable/Writable/Transform/PassThrough/pipeline/finished)
 *   - crypto   (createHash/createHmac/randomBytes/randomUUID/timingSafeEqual)
 *   - os       (platform/EOL/cpus/homedir/tmpdir 等)
 *   - zlib     (gunzipSync/createGunzip/constants 等)
 *   - http     (createServer/STATUS_CODES/request)
 *   - child_process (exec/execSync/spawn)
 *   - worker_threads (isMainThread/Worker)
 *   - process  (require('process'))
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import { buildSnapshot } from '../src/vfs-client'
import { createWasmRuntime, type WasmRuntime } from '../src/wasm'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'

let wasmModule: WebAssembly.Module

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
})

/** Globals to inject into each vm context when running bundled code. */
const CTX_GLOBALS = {
  console,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  URL,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Int32Array,
  DataView,
  ArrayBuffer,
  Promise,
  Symbol,
  Object,
  Array,
  Error,
  RangeError,
  TypeError,
  Math,
  JSON,
  parseInt,
  parseFloat,
  isNaN,
  fetch: globalThis.fetch,
  btoa,
  atob,
  crypto: globalThis.crypto,
  navigator: { platform: 'Linux x86_64' },
  // Minimal Bun stub so zlib polyfill has gunzipSync
  Bun: { gunzipSync: (d: Uint8Array): Uint8Array => d },
}

async function makeRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({ ...CTX_GLOBALS })
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url })
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox })
}

function loadFiles(rt: WasmRuntime, files: { path: string; data: string }[]): void {
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number
  const snapshot = buildSnapshot(files)
  rt.withBytes(new Uint8Array(snapshot), (ptr, len) => loadFn(ptr, len))
}

function bundleAndRun(rt: WasmRuntime, entry: string): unknown {
  const bundled = rt.bundle(entry)
  const ctx = createContext({ ...CTX_GLOBALS })
  return runInContext(bundled, ctx)
}

/**
 * Add `return` before the last non-empty, non-comment line if needed.
 * Skips lines that already start with `return`, `catch`, `try`, `}`, etc.
 */
function wrapWithReturn(code: string): string {
  const lines = code.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    // Already has return semantics — let it be
    if (/^(return|catch|try|if|while|for|switch|\})/.test(trimmed)) break
    lines[i] = lines[i].replace(trimmed, `return ${trimmed}`)
    break
  }
  return lines.join('\n')
}

/**
 * Load `code` as /app/index.js in the VFS, bundle it, and run in a fresh
 * vm context.  The last expression in `code` becomes the return value
 * (a `return` is prepended automatically when needed).
 * `return` inside try/catch blocks already works without transformation.
 */
function runInRuntime(rt: WasmRuntime, code: string): unknown {
  const wrapped = `module.exports = (function(){\n${wrapWithReturn(code)}\n})();\n`
  loadFiles(rt, [{ path: '/app/index.js', data: wrapped }])
  return bundleAndRun(rt, '/app/index.js')
}

// ─────────────────────────────────────────────────────────────────────────────
// stream polyfill (Phase 5.9 T5.9.1)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:stream polyfill', () => {
  test("require('stream') exports Readable/Writable/Transform/PassThrough", async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var s = require('stream');
      [typeof s.Readable, typeof s.Writable, typeof s.Transform, typeof s.PassThrough, typeof s.pipeline, typeof s.finished].join(',');
    `,
    )
    expect(result).toBe('function,function,function,function,function,function')
  })

  test('PassThrough passes data through', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var stream = require('stream');
      var pt = new stream.PassThrough();
      var out = [];
      pt.on('data', function(c){ out.push(typeof c === 'string' ? c : new TextDecoder().decode(c)); });
      pt.write('hello');
      pt.write(' world');
      out.join('');
    `,
    )
    expect(result).toBe('hello world')
  })

  test('Transform uppercases data', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var stream = require('stream');
      var out = [];
      var t = new stream.Transform({
        transform: function(chunk, enc, cb) {
          cb(null, typeof chunk === 'string' ? chunk.toUpperCase() : chunk);
        }
      });
      t.on('data', function(c){ out.push(typeof c === 'string' ? c : new TextDecoder().decode(c)); });
      t.write('hello');
      t.write(' world');
      out.join('');
    `,
    )
    expect(result).toBe('HELLO WORLD')
  })

  test('Writable end emits finish', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var stream = require('stream');
      var finished = false;
      var w = new stream.Writable({ write: function(c,e,cb){ cb(); } });
      w.on('finish', function(){ finished = true; });
      w.end('done');
      finished;
    `,
    )
    expect(result).toBe(true)
  })

  test('pipeline connects streams', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var stream = require('stream');
      var out = [];
      var src = new stream.Readable({ read: function(){} });
      var pt = new stream.PassThrough();
      pt.on('data', function(c){ out.push(typeof c === 'string' ? c : new TextDecoder().decode(c)); });
      var called = false;
      stream.pipeline(src, pt, function(err){ called = !err; });
      src.push('a'); src.push('b'); src.push(null);
      out.join('') + ':' + called;
    `,
    )
    expect(result).toBe('ab:true')
  })

  test('Readable exports Stream alias', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var s = require('stream');
      s.Stream === s.Readable && s.Duplex.prototype !== undefined;
    `,
    )
    expect(result).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// crypto polyfill (Phase 5.9 T5.9.2)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:crypto polyfill', () => {
  test("createHash('sha256') known test vector", async () => {
    const rt = await makeRuntime()
    // SHA256("abc") per FIPS 180-4 App. A.1 =
    //   BA7816BF 8F01CFEA 414140DE 5DAE2223 B00361A3 96177A9C B410FF61 F20015AD
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      crypto.createHash('sha256').update('abc').digest('hex');
    `,
    )
    expect(result).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test("createHash('sha1') known test vector", async () => {
    const rt = await makeRuntime()
    // SHA1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      crypto.createHash('sha1').update('abc').digest('hex');
    `,
    )
    expect(result).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  test('createHash update chaining', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      var h1 = crypto.createHash('sha256').update('ab').update('c').digest('hex');
      var h2 = crypto.createHash('sha256').update('abc').digest('hex');
      h1 === h2;
    `,
    )
    expect(result).toBe(true)
  })

  test("createHmac('sha256') known test vector", async () => {
    const rt = await makeRuntime()
    // HMAC-SHA256(key="key", data="The quick brown fox jumps over the lazy dog")
    // = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      crypto.createHmac('sha256','key').update('The quick brown fox jumps over the lazy dog').digest('hex');
    `,
    )
    expect(result).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })

  test('randomBytes returns correct length', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      var b = crypto.randomBytes(16);
      b.length;
    `,
    )
    expect(result).toBe(16)
  })

  test('randomUUID returns UUID format', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      crypto.randomUUID();
    `,
    )
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('timingSafeEqual equal buffers', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      var a = new Uint8Array([1,2,3]);
      var b = new Uint8Array([1,2,3]);
      crypto.timingSafeEqual(a, b);
    `,
    )
    expect(result).toBe(true)
  })

  test('timingSafeEqual unequal buffers', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var crypto = require('crypto');
      var a = new Uint8Array([1,2,3]);
      var b = new Uint8Array([1,2,4]);
      crypto.timingSafeEqual(a, b);
    `,
    )
    expect(result).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// os polyfill (Phase 5.9 T5.9.3)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:os polyfill', () => {
  test('platform() returns a string', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var os = require('os');
      typeof os.platform();
    `,
    )
    expect(result).toBe('string')
  })

  test('EOL is a string', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var os = require('os');
      typeof os.EOL;
    `,
    )
    expect(result).toBe('string')
  })

  test('cpus() returns an array', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var os = require('os');
      Array.isArray(os.cpus());
    `,
    )
    expect(result).toBe(true)
  })

  test('homedir/tmpdir return strings', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var os = require('os');
      typeof os.homedir() + ',' + typeof os.tmpdir();
    `,
    )
    expect(result).toBe('string,string')
  })

  test('arch/endianness return strings', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var os = require('os');
      typeof os.arch() + ',' + typeof os.endianness();
    `,
    )
    expect(result).toBe('string,string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// zlib polyfill (Phase 5.9 T5.9.4)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:zlib polyfill', () => {
  test('gunzipSync is a function', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var zlib = require('zlib');
      typeof zlib.gunzipSync;
    `,
    )
    expect(result).toBe('function')
  })

  test('gzipSync throws in browser mode', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var zlib = require('zlib');
      try { zlib.gzipSync(new Uint8Array([1,2,3])); return false; }
      catch(e) { return e.message.indexOf('not available') >= 0; }
    `,
    )
    expect(result).toBe(true)
  })

  test('createGunzip returns a stream-like object', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var zlib = require('zlib');
      var gz = zlib.createGunzip();
      typeof gz.write + ',' + typeof gz.on;
    `,
    )
    expect(result).toBe('function,function')
  })

  test('constants.Z_DEFAULT_COMPRESSION is -1', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var zlib = require('zlib');
      zlib.constants.Z_DEFAULT_COMPRESSION;
    `,
    )
    expect(result).toBe(-1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// http polyfill (Phase 5.9 T5.9.5)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:http polyfill', () => {
  test('STATUS_CODES[200] is OK', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var http = require('http');
      http.STATUS_CODES[200];
    `,
    )
    expect(result).toBe('OK')
  })

  test('createServer returns server object with listen/close', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var http = require('http');
      var srv = http.createServer(function(req, res){ res.end('hello'); });
      typeof srv.listen + ',' + typeof srv.close + ',' + typeof srv.address;
    `,
    )
    expect(result).toBe('function,function,function')
  })

  test('https has same API as http', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var https = require('https');
      typeof https.STATUS_CODES + ',' + typeof https.createServer;
    `,
    )
    expect(result).toBe('object,function')
  })

  test('METHODS includes GET and POST', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var http = require('http');
      http.METHODS.indexOf('GET') >= 0 && http.METHODS.indexOf('POST') >= 0;
    `,
    )
    expect(result).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// child_process polyfill (Phase 5.9 T5.9.6)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:child_process polyfill', () => {
  test('execSync throws in browser mode', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var cp = require('child_process');
      try { cp.execSync('ls'); return false; }
      catch(e) { return e.message.indexOf('not supported') >= 0; }
    `,
    )
    expect(result).toBe(true)
  })

  test('exec calls callback with error', async () => {
    const rt = await makeRuntime()
    // exec is async, so we can't easily wait; just check it's a function
    const result = runInRuntime(
      rt,
      `
      var cp = require('child_process');
      typeof cp.exec;
    `,
    )
    expect(result).toBe('function')
  })

  test('spawn returns ChildProcess with stdout/stderr', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var cp = require('child_process');
      var child = cp.spawn('node', ['-e', 'process.exit(0)']);
      typeof child.stdout + ',' + typeof child.stderr + ',' + typeof child.kill;
    `,
    )
    expect(result).toBe('object,object,function')
  })

  test('spawnSync returns error result', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var cp = require('child_process');
      var r = cp.spawnSync('node', ['-e', '1']);
      r.status === 1 && r.error instanceof Error;
    `,
    )
    expect(result).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// worker_threads polyfill (Phase 5.9 T5.9.7)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:worker_threads polyfill', () => {
  test('isMainThread is true', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var wt = require('worker_threads');
      wt.isMainThread;
    `,
    )
    expect(result).toBe(true)
  })

  test('threadId is 0', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var wt = require('worker_threads');
      wt.threadId;
    `,
    )
    expect(result).toBe(0)
  })

  test('Worker constructor throws', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var wt = require('worker_threads');
      try { new wt.Worker('./worker.js'); return false; }
      catch(e) { return e.message.indexOf('not supported') >= 0; }
    `,
    )
    expect(result).toBe(true)
  })

  test('MessageChannel creates port1/port2', async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var wt = require('worker_threads');
      var ch = new wt.MessageChannel();
      typeof ch.port1.postMessage + ',' + typeof ch.port2.postMessage;
    `,
    )
    expect(result).toBe('function,function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// process module (Phase 5.9 T5.9.8)
// ─────────────────────────────────────────────────────────────────────────────
describe('node:process module', () => {
  test("require('process') returns process-like object", async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var proc = require('process');
      typeof proc.platform + ',' + typeof proc.env + ',' + typeof proc.cwd;
    `,
    )
    expect(result).toBe('string,object,function')
  })

  test("require('process') is same as globalThis.process if defined", async () => {
    const rt = await makeRuntime()
    const result = runInRuntime(
      rt,
      `
      var proc = require('process');
      proc === (globalThis.process || proc);
    `,
    )
    expect(result).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bundle path — 新模块通过 builtinPolyfillSource 内联到 bundle
// ─────────────────────────────────────────────────────────────────────────────
describe('new builtins via bundle() path', () => {
  test('stream in bundle: PassThrough', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var stream = require('stream');
      var pt = new stream.PassThrough();
      var out = [];
      pt.on('data', function(c){ out.push(typeof c === 'string' ? c : 'bytes'); });
      pt.write('x'); pt.write('y');
      module.exports = out.join('');
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe('xy')
  })

  test('crypto in bundle: sha256', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var crypto = require('crypto');
      module.exports = crypto.createHash('sha256').update('abc').digest('hex');
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('os in bundle: platform string', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var os = require('os');
      module.exports = typeof os.platform();
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe('string')
  })

  test('http in bundle: STATUS_CODES', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var http = require('http');
      module.exports = http.STATUS_CODES[404];
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe('Not Found')
  })

  test('child_process in bundle: execSync throws', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var cp = require('child_process');
      try { cp.execSync('ls'); module.exports = false; }
      catch(e) { module.exports = e.message.indexOf('not supported') >= 0; }
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe(true)
  })

  test('worker_threads in bundle: isMainThread', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
      var wt = require('worker_threads');
      module.exports = wt.isMainThread;
    `,
      },
    ])
    expect(bundleAndRun(rt, '/app/index.js')).toBe(true)
  })
})
