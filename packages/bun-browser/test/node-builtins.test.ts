/**
 * Phase 5.8: Node.js 内置模块 polyfill 集成测试
 *
 * 覆盖新增的五个内置模块:
 *   - events   (EventEmitter)
 *   - buffer   (Buffer class)
 *   - assert   (断言函数)
 *   - querystring (URL 查询字符串)
 *   - string_decoder (StringDecoder)
 *
 * 测试途径:
 *   1. require() 直接调用（通过 bun_browser_run 执行代码）
 *   2. bundle 打包路径（builtinPolyfillSource）
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

async function makeRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    JSON,
    Math,
    Object,
    Array,
    Promise,
    Error,
    TypeError,
    Symbol,
  })
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url })
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox })
}

function loadFiles(rt: WasmRuntime, files: { path: string; data: string }[]): void {
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number
  const snapshot = buildSnapshot(files)
  rt.withBytes(new Uint8Array(snapshot), (ptr, len) => loadFn(ptr, len))
}

/** 将代码打包后在沙箱中执行，返回结果值 */
async function bundleAndRun(rt: WasmRuntime, entry: string): Promise<unknown> {
  const bundled = rt.bundle(entry)
  const ctx = createContext({ console, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer, Object, Array })
  return runInContext(bundled, ctx, { filename: entry })
}

// ──────────────────────────────────────────────────────────
// events
// ──────────────────────────────────────────────────────────
describe('node:events polyfill', () => {
  test('EventEmitter on/emit/off', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
var ee = new EE();
var calls = [];
function h(v) { calls.push(v); }
ee.on('data', h);
ee.emit('data', 1);
ee.emit('data', 2);
ee.off('data', h);
ee.emit('data', 3);
module.exports = calls;
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as number[]
    expect(result).toEqual([1, 2])
  })

  test('EventEmitter once fires only once', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('node:events');
var ee = new EE();
var count = 0;
ee.once('x', function(){ count++; });
ee.emit('x');
ee.emit('x');
ee.emit('x');
module.exports = count;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(1)
  })

  test('EventEmitter listenerCount', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
var ee = new EE();
var fn = function(){};
ee.on('x', fn);
ee.on('x', fn);
module.exports = ee.listenerCount('x');
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(2)
  })

  test('EventEmitter removeAllListeners', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
var ee = new EE();
ee.on('a', function(){});
ee.on('b', function(){});
ee.removeAllListeners();
module.exports = ee.eventNames();
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as string[]
    expect(result).toEqual([])
  })

  test('EventEmitter prependListener fires first', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
var ee = new EE();
var order = [];
ee.on('x', function(){ order.push('second'); });
ee.prependListener('x', function(){ order.push('first'); });
ee.emit('x');
module.exports = order;
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as string[]
    expect(result).toEqual(['first', 'second'])
  })

  test('EventEmitter subclass via inherits', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
function MyEmitter() { EE.call(this); }
EE.inherits(MyEmitter, EE);
MyEmitter.prototype.go = function() { this.emit('go', 42); };
var me = new MyEmitter();
var got;
me.on('go', function(v){ got = v; });
me.go();
module.exports = got;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(42)
  })
})

// ──────────────────────────────────────────────────────────
// buffer
// ──────────────────────────────────────────────────────────
describe('node:buffer polyfill', () => {
  test('Buffer.from string utf8 + toString', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('buffer').Buffer;
var buf = B.from('hello');
module.exports = buf.toString('utf8');
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('hello')
  })

  test('Buffer.from string hex roundtrip', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('buffer').Buffer;
var buf = B.from('deadbeef', 'hex');
module.exports = buf.toString('hex');
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('deadbeef')
  })

  test('Buffer.alloc fills with zeros', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('node:buffer').Buffer;
var buf = B.alloc(4);
module.exports = Array.from(buf);
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as number[]
    expect(result).toEqual([0, 0, 0, 0])
  })

  test('Buffer.concat joins buffers', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('buffer').Buffer;
var a = B.from([1,2]);
var b = B.from([3,4]);
var c = B.concat([a, b]);
module.exports = Array.from(c);
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as number[]
    expect(result).toEqual([1, 2, 3, 4])
  })

  test('Buffer.isBuffer detects buffer', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('buffer').Buffer;
var buf = B.from([1,2,3]);
module.exports = [B.isBuffer(buf), B.isBuffer({}), B.isBuffer('str')];
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as boolean[]
    expect(result[0]).toBe(true)
    expect(result[1]).toBe(false)
    expect(result[2]).toBe(false)
  })

  test('Buffer read/write UInt32BE', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var B = require('buffer').Buffer;
var buf = B.alloc(4);
buf.writeUInt32BE(0xDEADBEEF, 0);
module.exports = buf.readUInt32BE(0);
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(0xdeadbeef)
  })
})

// ──────────────────────────────────────────────────────────
// assert
// ──────────────────────────────────────────────────────────
describe('node:assert polyfill', () => {
  test('assert.ok passes on truthy', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('assert');
var threw = false;
try { assert.ok(1); } catch(e) { threw = true; }
module.exports = threw;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(false)
  })

  test('assert.strictEqual throws on mismatch', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('node:assert');
var threw = false;
try { assert.strictEqual(1, 2); } catch(e) { threw = e.name; }
module.exports = threw;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('AssertionError')
  })

  test('assert.deepStrictEqual passes for equal objects', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('assert');
var threw = false;
try { assert.deepStrictEqual({a:1,b:[2]},{a:1,b:[2]}); } catch(e) { threw = true; }
module.exports = threw;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(false)
  })

  test('assert.throws catches expected errors', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('assert');
var threw = false;
try {
  assert.throws(function() { throw new Error('oops'); });
} catch(e) { threw = true; }
module.exports = threw;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe(false)
  })

  test('assert(false) throws AssertionError', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('assert');
var caught = null;
try { assert(false, 'custom message'); } catch(e) { caught = e.message; }
module.exports = caught;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('custom message')
  })
})

// ──────────────────────────────────────────────────────────
// querystring
// ──────────────────────────────────────────────────────────
describe('node:querystring polyfill', () => {
  test('parse basic query string', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var qs = require('querystring');
module.exports = qs.parse('foo=bar&baz=qux');
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as Record<string, string>
    expect(result.foo).toBe('bar')
    expect(result.baz).toBe('qux')
  })

  test('stringify object to query string', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var qs = require('node:querystring');
module.exports = qs.stringify({a:'1',b:'hello world'});
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as string
    expect(result).toBe('a=1&b=hello+world')
  })

  test('parse handles + as space and array values', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var qs = require('querystring');
var r = qs.parse('a=hello+world&b=1&b=2');
module.exports = [r.a, r.b];
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as [string, string[]]
    expect(result[0]).toBe('hello world')
    expect(result[1]).toEqual(['1', '2'])
  })

  test('stringify array values', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var qs = require('querystring');
module.exports = qs.stringify({x: ['a','b']});
`,
      },
    ])
    const result = (await bundleAndRun(rt, '/app/index.js')) as string
    expect(result).toBe('x=a&x=b')
  })
})

// ──────────────────────────────────────────────────────────
// string_decoder
// ──────────────────────────────────────────────────────────
describe('node:string_decoder polyfill', () => {
  test('StringDecoder decodes UTF-8 buffer', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var SD = require('string_decoder').StringDecoder;
var d = new SD('utf8');
var buf = new Uint8Array([0x68,0x65,0x6c,0x6c,0x6f]); // "hello"
module.exports = d.write(buf);
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('hello')
  })

  test('StringDecoder end flushes remaining', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var SD = require('node:string_decoder').StringDecoder;
var d = new SD();
var a = d.write(new Uint8Array([0x62,0x75]));
var b = d.end(new Uint8Array([0x6e]));
module.exports = a + b;
`,
      },
    ])
    const result = await bundleAndRun(rt, '/app/index.js')
    expect(result).toBe('bun')
  })
})

// ──────────────────────────────────────────────────────────
// bundle 路径：builtinPolyfillSource 中也能解析这些模块
// ──────────────────────────────────────────────────────────
describe('node builtins via bundle() path', () => {
  test('bundle with events dependency works', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var EE = require('events');
var ee = new EE();
var result = 0;
ee.on('tick', function(n){ result += n; });
ee.emit('tick', 7);
ee.emit('tick', 3);
module.exports = result;
`,
      },
    ])
    const bundled = rt.bundle('/app/index.js')
    expect(bundled).toContain('EventEmitter')
    const ctx = createContext({ console, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer, Object, Array })
    const result = runInContext(bundled, ctx, { filename: '/bundle.js' })
    expect(result).toBe(10)
  })

  test('bundle with assert dependency works', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var assert = require('assert');
var ok = true;
try { assert.strictEqual(1+1, 2); } catch(e) { ok = false; }
module.exports = ok;
`,
      },
    ])
    const bundled = rt.bundle('/app/index.js')
    expect(bundled).toContain('AssertionError')
    const ctx = createContext({ console, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer, Object, Array })
    const result = runInContext(bundled, ctx, { filename: '/bundle.js' })
    expect(result).toBe(true)
  })

  test('bundle with querystring dependency works', async () => {
    const rt = await makeRuntime()
    loadFiles(rt, [
      {
        path: '/app/index.js',
        data: `
var qs = require('querystring');
module.exports = qs.parse('k=v').k;
`,
      },
    ])
    const bundled = rt.bundle('/app/index.js')
    const ctx = createContext({ console, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer, Object, Array })
    const result = runInContext(bundled, ctx, { filename: '/bundle.js' })
    expect(result).toBe('v')
  })
})
