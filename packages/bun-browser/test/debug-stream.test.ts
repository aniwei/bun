import { test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { buildSnapshot } from "../src/vfs-client";
import { createWasmRuntime } from "../src/wasm";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";

test("debug stream bundle", async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  const wasmModule = await WebAssembly.compile(bytes);

  const CTX_GLOBALS = {
    console, queueMicrotask, setTimeout, clearTimeout,
    URL, TextEncoder, TextDecoder, Uint8Array, Int32Array, DataView,
    ArrayBuffer, Promise, Symbol, Object, Array, Error, RangeError, TypeError,
    Math, JSON, parseInt, parseFloat, isNaN,
    fetch: globalThis.fetch, btoa, atob, crypto: (globalThis as unknown as { crypto: unknown }).crypto,
    navigator: { platform: "Linux x86_64" },
    Bun: { gunzipSync: (d: Uint8Array) => d },
  };

  const sandbox = createContext({ ...CTX_GLOBALS });
  const evaluator = (code: string, url: string) => runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url });
  const rt = await createWasmRuntime(wasmModule, { evaluator, global: sandbox });

  const code = `
var stream = require('stream');
var pt = new stream.PassThrough();
var out = [];
pt.on('data', function(c){ out.push(typeof c === 'string' ? c : new TextDecoder().decode(c)); });
pt.write('hello');
pt.write(' world');
module.exports = out.join('');
`;
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
  const snapshot = buildSnapshot([{ path: "/app/index.js", data: code }]);
  rt.withBytes(new Uint8Array(snapshot), (ptr, len) => loadFn(ptr, len));

  const bundled = rt.bundle("/app/index.js");
  console.log("=== BUNDLED OUTPUT (full) ===");
  console.log(bundled);
  console.log("=== END ===");
  const ctx = createContext({ ...CTX_GLOBALS });
  const result = runInContext(bundled, ctx);
  console.log("Result:", JSON.stringify(result));
});
