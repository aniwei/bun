/**
 * JSI Host —— 浏览器侧 WebAssembly `jsi` 命名空间实现。
 *
 * 此文件是 [src/jsi/imports.zig](../../../src/jsi/imports.zig) 的 TS 对应物；
 * 每一条 `extern "jsi" fn ...` 都必须在这里有一个同名同语义的槽位。
 *
 * 字符串约定：UTF-8，`(ptr, len)` 成对传递；`ptr` 为 WASM 线性内存偏移。
 * 异常约定：返回 `u32` 句柄时若出错，返回 `EXCEPTION_SENTINEL = 0xFFFFFFFF`。
 *
 * Handle 空间：
 *   - 0..=4 为 Zig 侧保留（undefined/null/true/false/global）—— 见 `src/jsi/value.zig`
 *   - 5..  由本类的自由表分配
 */

export const EXCEPTION_SENTINEL = 0xffffffff >>> 0;

export const enum ReservedHandle {
  Undefined = 0,
  Null = 1,
  True = 2,
  False = 3,
  Global = 4,
}

/** JSI 类型标签，必须与 `src/jsi/value.zig` 的 `TypeTag` 对齐。 */
export const enum TypeTag {
  Undefined = 0,
  Null = 1,
  Boolean = 2,
  Number = 3,
  String = 4,
  Symbol = 5,
  Object = 6,
  Function = 7,
  Array = 8,
  ArrayBuffer = 9,
  TypedArray = 10,
  Promise = 11,
  Error = 12,
}

/** HostFunction 回调签名（由 Zig 侧 `jsi_host_invoke` 反向驱动 —— 通过 WASM 导出，不经由 imports 表）。 */
export type HostFnImpl = (thisHandle: number, argv: number[]) => number;

/** 打印级别，对应 `jsi_print` level 参数。 */
export const enum PrintLevel {
  Stdout = 1,
  Stderr = 2,
}

export interface JsiHostOptions {
  global?: object;
  memory?: WebAssembly.Memory | undefined;
  /** stdout/stderr 输出回调。默认路由到 console.log / console.error。 */
  onPrint?: (data: string, level: PrintLevel) => void;
  /**
   * TypeScript 转译回调。接收原始 TS 源码 + 文件名，返回 转译后 JS。
   * 默认为恒等（identity）——即不提供转译，原文直接返回。
   * 中高级用法：插入 esbuild-wasm / swc-wasm 实现。
   */
  transpile?: (source: string, filename: string) => string;
  /**
   * 代码求值器。默认为 `new Function(code)()`（宿主 global 作用域）。
   * Node 宿主可注入 `vm.runInContext` 以隔离到沙箱 Context，满足 Phase 2 验收
   * "同一 wasm 在 Node.js 宿主下用 vm.Context 作为 JSI backend"。
   */
  evaluator?: (code: string, url: string) => unknown;
}

export class JsiHost {
  private handles: Array<unknown>;
  private freeList: number[] = [];
  private textDecoder = new TextDecoder("utf-8", { fatal: false });
  private textEncoder = new TextEncoder();
  private lastException: unknown = undefined;
  private memory: WebAssembly.Memory | undefined;
  private onPrint: (data: string, level: PrintLevel) => void;
  private transpile: (source: string, filename: string) => string;
  private evaluator: (code: string, url: string) => unknown;
  public wasmExports: WebAssembly.Exports | undefined;

  constructor(opts: JsiHostOptions = {}) {
    const g = opts.global ?? globalThis;
    this.handles = [undefined, null, true, false, g];
    this.memory = opts.memory;
    this.onPrint =
      opts.onPrint ??
      ((data, level) => {
        if (level === PrintLevel.Stderr) console.error(data);
        else console.log(data);
      });
    this.transpile = opts.transpile ?? ((source) => source);
    this.evaluator =
      opts.evaluator ??
      ((code, url) => {
        // 默认：宿主 global 作用域 eval。sourceURL 注释便于 DevTools 栈帧归属。
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        return new Function(`${code}\n//# sourceURL=${url}`)();
      });
  }

  bind(instance: WebAssembly.Instance): void {
    this.wasmExports = instance.exports;
    const mem = instance.exports.memory;
    if (mem instanceof WebAssembly.Memory) this.memory = mem;
  }

  private memBytes(): Uint8Array {
    const m = this.memory;
    if (!m) throw new Error("JsiHost: memory not bound");
    return new Uint8Array(m.buffer);
  }

  private memView(): DataView {
    const m = this.memory;
    if (!m) throw new Error("JsiHost: memory not bound");
    return new DataView(m.buffer);
  }

  retain(value: unknown): number {
    if (value === undefined) return ReservedHandle.Undefined;
    if (value === null) return ReservedHandle.Null;
    if (value === true) return ReservedHandle.True;
    if (value === false) return ReservedHandle.False;
    const reused = this.freeList.pop();
    if (reused !== undefined) {
      this.handles[reused] = value;
      return reused;
    }
    this.handles.push(value);
    return this.handles.length - 1;
  }

  release(handle: number): void {
    if (handle <= ReservedHandle.Global) return;
    if (handle === EXCEPTION_SENTINEL) return;
    this.handles[handle] = undefined;
    this.freeList.push(handle);
  }

  deref(handle: number): unknown {
    if (handle === EXCEPTION_SENTINEL) throw new Error("JSI: exception handle used as value");
    return this.handles[handle];
  }

  readString(ptr: number, len: number): string {
    return this.textDecoder.decode(new Uint8Array(this.memBytes().buffer, ptr, len));
  }

  /**
   * Import table passed to `WebAssembly.instantiate` under the `"jsi"` namespace.
   * 每个导入的签名必须与 `src/jsi/imports.zig` 完全一致。
   */
  imports(): WebAssembly.ModuleImports {
    const self = this;

    return {
      // ── lifecycle ────────────────────────────────────
      // Zig 侧 retain 语义：在 handles 表中为同一值分配新槽，使其生命周期独立于原句柄。
      // 保留句柄 (0..Global) 和哨兵不需要计数，直接返回。
      jsi_retain: (handle: number): number => {
        if (handle <= ReservedHandle.Global || handle === EXCEPTION_SENTINEL) return handle;
        return self.retain(self.handles[handle]);
      },
      jsi_release: (handle: number): void => self.release(handle),

      // ── construction ─────────────────────────────────
      jsi_make_number: (value: number): number => self.retain(value),
      jsi_make_string: (ptr: number, len: number): number => self.retain(self.readString(ptr, len)),
      jsi_make_object: (): number => self.retain({}),
      jsi_make_array: (len: number): number => self.retain(new Array(len)),
      jsi_make_arraybuffer: (ptr: number, len: number, copy: number): number => {
        const src = self.memBytes().subarray(ptr, ptr + len);
        if (copy !== 0) {
          const ab = new ArrayBuffer(len);
          new Uint8Array(ab).set(src);
          return self.retain(ab);
        }
        // Zig 侧 copy=0 请求零拷贝视图；WASM grow 可能使其失效。
        return self.retain(src.slice().buffer);
      },
      jsi_make_error: (ptr: number, len: number): number => {
        return self.retain(new Error(self.readString(ptr, len)));
      },

      // ── type queries ─────────────────────────────────
      jsi_typeof: (handle: number): number => {
        const v = self.deref(handle);
        if (v === undefined) return TypeTag.Undefined;
        if (v === null) return TypeTag.Null;
        switch (typeof v) {
          case "boolean":
            return TypeTag.Boolean;
          case "number":
            return TypeTag.Number;
          case "string":
            return TypeTag.String;
          case "function":
            return TypeTag.Function;
          case "symbol":
            return TypeTag.Symbol;
          case "bigint":
            // Zig TypeTag 无 bigint；回退到 number（最接近的 scalar）。
            return TypeTag.Number;
          default:
            if (Array.isArray(v)) return TypeTag.Array;
            if (v instanceof ArrayBuffer) return TypeTag.ArrayBuffer;
            if (ArrayBuffer.isView(v)) return TypeTag.TypedArray;
            if (v instanceof Promise) return TypeTag.Promise;
            if (v instanceof Error) return TypeTag.Error;
            return TypeTag.Object;
        }
      },
      jsi_to_number: (handle: number): number => Number(self.deref(handle)),
      jsi_to_boolean: (handle: number): number => (self.deref(handle) ? 1 : 0),
      // 将任意值强制转为 JS 字符串（等价于 String(v)），返回新 retain 的 handle。
      jsi_to_string: (handle: number): number => {
        try {
          return self.retain(String(self.deref(handle)));
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },
      jsi_string_length: (handle: number): number => {
        const s = self.deref(handle);
        if (typeof s !== "string") return 0;
        return self.textEncoder.encode(s).byteLength;
      },
      jsi_string_read: (handle: number, bufPtr: number, bufLen: number): void => {
        const s = self.deref(handle);
        if (typeof s !== "string") return;
        self.textEncoder.encodeInto(s, self.memBytes().subarray(bufPtr, bufPtr + bufLen));
      },

      // ── properties ───────────────────────────────────
      jsi_get_prop: (obj: number, namePtr: number, nameLen: number): number => {
        try {
          const o = self.deref(obj) as Record<string, unknown>;
          return self.retain(o[self.readString(namePtr, nameLen)]);
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },
      jsi_set_prop: (obj: number, namePtr: number, nameLen: number, val: number): void => {
        try {
          const o = self.deref(obj) as Record<string, unknown>;
          o[self.readString(namePtr, nameLen)] = self.deref(val);
        } catch (e) {
          self.lastException = e;
        }
      },
      jsi_get_index: (arr: number, idx: number): number => {
        try {
          return self.retain((self.deref(arr) as unknown[])[idx]);
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },
      jsi_set_index: (arr: number, idx: number, val: number): void => {
        try {
          (self.deref(arr) as unknown[])[idx] = self.deref(val);
        } catch (e) {
          self.lastException = e;
        }
      },
      jsi_has_prop: (obj: number, namePtr: number, nameLen: number): number => {
        try {
          const o = self.deref(obj) as object;
          return self.readString(namePtr, nameLen) in o ? 1 : 0;
        } catch {
          return 0;
        }
      },

      // ── call / construct ─────────────────────────────
      jsi_call: (fn: number, thisH: number, argvPtr: number, argc: number): number => {
        try {
          const f = self.deref(fn) as (...args: unknown[]) => unknown;
          const view = self.memView();
          const args: unknown[] = new Array(argc);
          for (let i = 0; i < argc; i++) args[i] = self.deref(view.getUint32(argvPtr + i * 4, true));
          return self.retain(f.apply(self.deref(thisH) as object, args));
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },
      jsi_new: (ctor: number, argvPtr: number, argc: number): number => {
        try {
          const C = self.deref(ctor) as new (...args: unknown[]) => unknown;
          const view = self.memView();
          const args: unknown[] = new Array(argc);
          for (let i = 0; i < argc; i++) args[i] = self.deref(view.getUint32(argvPtr + i * 4, true));
          return self.retain(new C(...args));
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },

      // ── host function factory ────────────────────────
      jsi_make_host_function: (
        tag: number,
        namePtr: number,
        nameLen: number,
        argc: number,
      ): number => {
        void argc;
        const name = nameLen > 0 ? self.readString(namePtr, nameLen) : `host_fn_${tag}`;
        const fn = function hostFn(this: unknown, ...args: unknown[]): unknown {
          const thisHandle = self.retain(this);
          const argHandles = args.map((a) => self.retain(a));
          try {
            const scratch = self.wasmExports?.jsi_host_arg_scratch as
              | ((count: number) => number)
              | undefined;
            const invoke = self.wasmExports?.jsi_host_invoke as
              | ((fnId: number, thisH: number, argvPtr: number, argc: number) => number)
              | undefined;
            if (!scratch || !invoke) throw new Error("jsi_host_* exports missing");

            const ptr = scratch(argHandles.length);
            const view = self.memView();
            for (let i = 0; i < argHandles.length; i++) {
              view.setUint32(ptr + i * 4, argHandles[i]!, true);
            }
            const resultHandle = invoke(tag, thisHandle, ptr, argHandles.length);
            if (resultHandle === EXCEPTION_SENTINEL) {
              throw self.lastException ?? new Error(`JSI host function '${name}' threw`);
            }
            return self.deref(resultHandle);
          } finally {
            self.release(thisHandle);
            for (const h of argHandles) self.release(h);
          }
        };
        try {
          Object.defineProperty(fn, "name", { value: name });
        } catch {
          // ignore
        }
        return self.retain(fn);
      },

      // ── promise ──────────────────────────────────────
      jsi_make_promise: (resolverTag: number): number => {
        void resolverTag;
        // Phase 0 占位：返回 pending promise，resolver 由 Zig 侧 Resolver table 驱动。
        let resolveFn: (v: unknown) => void = () => {};
        let rejectFn: (e: unknown) => void = () => {};
        const p = new Promise<unknown>((res, rej) => {
          resolveFn = res;
          rejectFn = rej;
        });
        // 把 resolver 挂上以便 jsi_resolve / jsi_reject 定位。
        (p as unknown as { __resolve: typeof resolveFn }).__resolve = resolveFn;
        (p as unknown as { __reject: typeof rejectFn }).__reject = rejectFn;
        return self.retain(p);
      },
      jsi_resolve: (promise: number, value: number): void => {
        const p = self.deref(promise) as { __resolve?: (v: unknown) => void } | null;
        p?.__resolve?.(self.deref(value));
      },
      jsi_reject: (promise: number, value: number): void => {
        const p = self.deref(promise) as { __reject?: (v: unknown) => void } | null;
        p?.__reject?.(self.deref(value));
      },

      // ── eval ─────────────────────────────────────────
      jsi_eval: (codePtr: number, codeLen: number, urlPtr: number, urlLen: number): number => {
        try {
          const code = self.readString(codePtr, codeLen);
          const url = urlLen > 0 ? self.readString(urlPtr, urlLen) : "<eval>";
          return self.retain(self.evaluator(code, url));
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },
      jsi_eval_module: (
        codePtr: number,
        codeLen: number,
        urlPtr: number,
        urlLen: number,
      ): number => {
        // Phase 0: 暂按 script 语义执行；后续 Phase 替换为 import() + Blob URL。
        try {
          const code = self.readString(codePtr, codeLen);
          const url = urlLen > 0 ? self.readString(urlPtr, urlLen) : "<module>";
          return self.retain(self.evaluator(code, url));
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },

      // ── host helpers ─────────────────────────────────
      jsi_schedule_microtask: (): void => {
        const tick = self.wasmExports?.bun_tick as (() => void) | undefined;
        if (tick) queueMicrotask(tick);
      },

      // ── 直接打印（Zig → Host stdout/stderr）──────────────
      jsi_print: (ptr: number, len: number, level: number): void => {
        const data = self.textDecoder.decode(
          new Uint8Array(self.memBytes().buffer, ptr, len),
        );
        self.onPrint(data, level as PrintLevel);
      },

      // ── TypeScript transpile ─────────────────────
      jsi_transpile: (
        srcPtr: number,
        srcLen: number,
        filenamePtr: number,
        filenameLen: number,
      ): number => {
        try {
          const source = self.readString(srcPtr, srcLen);
          const filename = filenameLen > 0 ? self.readString(filenamePtr, filenameLen) : "unknown.ts";
          const js = self.transpile(source, filename);
          return self.retain(js);
        } catch (e) {
          self.lastException = e;
          return EXCEPTION_SENTINEL;
        }
      },

      // ── Phase 5.7: ArrayBuffer I/O ───────────────
      /**
       * Copy bytes from an ArrayBuffer/TypedArray handle into WASM linear memory.
       * Returns bytes copied, or -1 if handle is not a buffer.
       */
      jsi_read_arraybuffer: (handle: number, destPtr: number, destLen: number): number => {
        const v = self.deref(handle);
        let bytes: Uint8Array;
        if (v instanceof ArrayBuffer) {
          bytes = new Uint8Array(v);
        } else if (ArrayBuffer.isView(v)) {
          bytes = new Uint8Array(
            (v as ArrayBufferView).buffer,
            (v as ArrayBufferView).byteOffset,
            (v as ArrayBufferView).byteLength,
          );
        } else {
          return -1;
        }
        const count = Math.min(bytes.byteLength, destLen);
        self.memBytes().subarray(destPtr, destPtr + count).set(bytes.subarray(0, count));
        return count;
      },
      /** Return byteLength of an ArrayBuffer/TypedArray handle, or -1. */
      jsi_arraybuffer_byteLength: (handle: number): number => {
        const v = self.deref(handle);
        if (v instanceof ArrayBuffer) return v.byteLength;
        if (ArrayBuffer.isView(v)) return (v as ArrayBufferView).byteLength;
        return -1;
      },
    };
  }
}

/**
 * 类型化的 imports 表——主要用于测试中将 `host.imports()` cast 成可调用类型。
 * 生产炴不要使用；运行时 ABI 由 `src/jsi/imports.zig` 定义。
 */
export interface JsiImportsTyped {
  jsi_retain: (handle: number) => number;
  jsi_release: (handle: number) => void;
  jsi_make_number: (value: number) => number;
  jsi_make_string: (ptr: number, len: number) => number;
  jsi_make_object: () => number;
  jsi_make_array: (length: number) => number;
  jsi_make_arraybuffer: (ptr: number, len: number, copy: number) => number;
  jsi_make_error: (ptr: number, len: number) => number;
  jsi_typeof: (handle: number) => number;
  jsi_to_number: (handle: number) => number;
  jsi_to_boolean: (handle: number) => number;
  jsi_to_string: (handle: number) => number;
  jsi_string_length: (handle: number) => number;
  jsi_string_read: (handle: number, bufPtr: number, bufLen: number) => void;
  jsi_get_prop: (obj: number, namePtr: number, nameLen: number) => number;
  jsi_set_prop: (obj: number, namePtr: number, nameLen: number, val: number) => void;
  jsi_get_index: (arr: number, idx: number) => number;
  jsi_set_index: (arr: number, idx: number, val: number) => void;
  jsi_has_prop: (obj: number, namePtr: number, nameLen: number) => number;
  jsi_call: (fn: number, thisH: number, argvPtr: number, argc: number) => number;
  jsi_new: (ctor: number, argvPtr: number, argc: number) => number;
  jsi_make_host_function: (tag: number, namePtr: number, nameLen: number, argc: number) => number;
  jsi_make_promise: (resolverTag: number) => number;
  jsi_resolve: (promise: number, value: number) => void;
  jsi_reject: (promise: number, value: number) => void;
  jsi_eval: (codePtr: number, codeLen: number, urlPtr: number, urlLen: number) => number;
  jsi_eval_module: (codePtr: number, codeLen: number, urlPtr: number, urlLen: number) => number;
  jsi_schedule_microtask: () => void;
  jsi_print: (ptr: number, len: number, level: number) => void;
  jsi_transpile: (srcPtr: number, srcLen: number, filenamePtr: number, filenameLen: number) => number;
  jsi_read_arraybuffer: (handle: number, destPtr: number, destLen: number) => number;
  jsi_arraybuffer_byteLength: (handle: number) => number;
}
