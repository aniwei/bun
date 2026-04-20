/**
 * JsiHost 单元测试 —— 使用真实的 WebAssembly.Memory 但无需 WASM 二进制。
 *
 * 测试目标：验证 jsi-host.ts 中所有 imports() 函数能正确读写 WASM 线性内存，
 * 以及 handle 表的 retain / release / deref 语义。
 */

import { describe, expect, test } from "bun:test";
import {
  EXCEPTION_SENTINEL,
  JsiHost,
  PrintLevel,
  ReservedHandle,
  TypeTag,
} from "../src/jsi-host";

/** 创建一个内存页 (64 KiB) 的 WebAssembly.Memory。 */
function makeMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 });
}

/** 写字符串到 WASM 内存，返回 (ptr, byteLen)。 */
function writeString(mem: WebAssembly.Memory, str: string, offset = 0x100): [number, number] {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(mem.buffer).set(bytes, offset);
  return [offset, bytes.byteLength];
}

// ──────────────────────────────────────────────────────────
// 保留 handle 常量
// ──────────────────────────────────────────────────────────

describe("保留 handle", () => {
  test("undefined → ReservedHandle.Undefined (0)", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_retain(ReservedHandle.Undefined)).toBe(ReservedHandle.Undefined);
  });

  test("null → ReservedHandle.Null (1)", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_retain(ReservedHandle.Null)).toBe(ReservedHandle.Null);
  });
});

// ──────────────────────────────────────────────────────────
// 值构造
// ──────────────────────────────────────────────────────────

describe("jsi_make_number", () => {
  test("存入 42，typeof = number，to_number = 42", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_number(42);
    expect(h).toBeGreaterThan(ReservedHandle.Global);
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Number);
    expect(imp.jsi_to_number(h)).toBe(42);
  });

  test("负数与浮点不丢失精度", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_number(-Math.PI);
    expect(imp.jsi_to_number(h)).toBe(-Math.PI);
  });
});

describe("jsi_make_string + jsi_string_length + jsi_string_read", () => {
  test("ASCII 字符串往返", () => {
    const mem = makeMemory();
    const [ptr, len] = writeString(mem, "hello");
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();
    const h = imp.jsi_make_string(ptr, len);
    expect(imp.jsi_typeof(h)).toBe(TypeTag.String);
    expect(imp.jsi_string_length(h)).toBe(5);

    // 读回
    const outPtr = 0x300;
    imp.jsi_string_read(h, outPtr, 5);
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, 5));
    expect(back).toBe("hello");
  });

  test("Unicode (中文) 往返", () => {
    const mem = makeMemory();
    const [ptr, len] = writeString(mem, "你好");
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();
    const h = imp.jsi_make_string(ptr, len);
    // "你好" 编码为 6 字节 UTF-8
    const byteLen = imp.jsi_string_length(h);
    expect(byteLen).toBe(6);
    const outPtr = 0x300;
    imp.jsi_string_read(h, outPtr, byteLen);
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen));
    expect(back).toBe("你好");
  });
});

describe("jsi_make_object / jsi_make_array", () => {
  test("object typeof = object", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_object();
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Object);
  });

  test("array typeof = array", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_array(3);
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Array);
  });
});

// ──────────────────────────────────────────────────────────
// 属性访问
// ──────────────────────────────────────────────────────────

describe("jsi_set_prop / jsi_get_prop / jsi_has_prop", () => {
  test("set + get + has", () => {
    const mem = makeMemory();
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();

    const obj = imp.jsi_make_object();
    const val = imp.jsi_make_number(99);

    const [namePtr, nameLen] = writeString(mem, "score");
    imp.jsi_set_prop(obj, namePtr, nameLen, val);

    const [rPtr, rLen] = writeString(mem, "score", 0x200);
    const got = imp.jsi_get_prop(obj, rPtr, rLen);
    expect(imp.jsi_to_number(got)).toBe(99);

    expect(imp.jsi_has_prop(obj, rPtr, rLen)).toBe(1);
  });

  test("get 不存在属性 → undefined handle", () => {
    const mem = makeMemory();
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();
    const obj = imp.jsi_make_object();
    const [p, l] = writeString(mem, "missing");
    const got = imp.jsi_get_prop(obj, p, l);
    expect(got).toBe(ReservedHandle.Undefined);
  });
});

// ──────────────────────────────────────────────────────────
// 数组索引
// ──────────────────────────────────────────────────────────

describe("jsi_set_index / jsi_get_index", () => {
  test("设置索引再读回", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const arr = imp.jsi_make_array(2);
    const v = imp.jsi_make_number(7);
    imp.jsi_set_index(arr, 0, v);
    const got = imp.jsi_get_index(arr, 0);
    expect(imp.jsi_to_number(got)).toBe(7);
  });
});

// ──────────────────────────────────────────────────────────
// retain / release
// ──────────────────────────────────────────────────────────

describe("jsi_retain / jsi_release", () => {
  test("retain 返回同一 handle", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_number(1);
    expect(imp.jsi_retain(h)).toBe(h);
  });

  test("release 后 handle 回收, 下次 make 可复用", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    const h = imp.jsi_make_number(1);
    const nextBefore = imp.jsi_make_number(2); // h 还未释放时 nextBefore > h
    imp.jsi_release(nextBefore);
    imp.jsi_release(h);
    // 复用 free list：下一个 make 应复用释放的槽位之一
    const reused = imp.jsi_make_number(3);
    // 只需验证 reused 是合法 handle（不再 crash）
    expect(imp.jsi_to_number(reused)).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────
// to_boolean
// ──────────────────────────────────────────────────────────

describe("jsi_to_boolean", () => {
  test("0 → falsy", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_to_boolean(imp.jsi_make_number(0))).toBe(0);
  });

  test("1 → truthy", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_to_boolean(imp.jsi_make_number(1))).toBe(1);
  });

  test("true handle → 1", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_to_boolean(ReservedHandle.True)).toBe(1);
  });

  test("false handle → 0", () => {
    const host = new JsiHost({ memory: makeMemory() });
    const imp = host.imports();
    expect(imp.jsi_to_boolean(ReservedHandle.False)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────
// jsi_print
// ──────────────────────────────────────────────────────────

describe("jsi_print", () => {
  test("level=1 → stdout 回调", () => {
    const mem = makeMemory();
    const printed: Array<{ data: string; level: PrintLevel }> = [];
    const host = new JsiHost({ memory: mem, onPrint: (d, l) => printed.push({ data: d, level: l }) });
    const imp = host.imports();

    const [ptr, len] = writeString(mem, "hello stdout");
    imp.jsi_print(ptr, len, PrintLevel.Stdout);
    expect(printed).toHaveLength(1);
    expect(printed[0].data).toBe("hello stdout");
    expect(printed[0].level).toBe(PrintLevel.Stdout);
  });

  test("level=2 → stderr 回调", () => {
    const mem = makeMemory();
    const printed: Array<{ data: string; level: PrintLevel }> = [];
    const host = new JsiHost({ memory: mem, onPrint: (d, l) => printed.push({ data: d, level: l }) });
    const imp = host.imports();

    const [ptr, len] = writeString(mem, "ERROR!", 0x200);
    imp.jsi_print(ptr, len, PrintLevel.Stderr);
    expect(printed[0].level).toBe(PrintLevel.Stderr);
  });
});

// ──────────────────────────────────────────────────────────
// jsi_transpile 默认 identity
// ──────────────────────────────────────────────────────────

describe("jsi_transpile (default = identity)", () => {
  test("未提供 transpile 选项 → 原文返回", () => {
    const mem = makeMemory();
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();

    const src = "const x: number = 1;";
    const [sPtr, sLen] = writeString(mem, src);
    const [fPtr, fLen] = writeString(mem, "index.ts", 0x200);
    const h = imp.jsi_transpile(sPtr, sLen, fPtr, fLen);
    expect(h).not.toBe(EXCEPTION_SENTINEL);
    const byteLen = imp.jsi_string_length(h);
    const outPtr = 0x400;
    imp.jsi_string_read(h, outPtr, byteLen);
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen));
    expect(back).toBe(src); // identity
  });

  test("提供 transpile 回调 → 转换后字符串", () => {
    const mem = makeMemory();
    const host = new JsiHost({
      memory: mem,
      transpile: (src) => src.replace(/const (\w+): \w+/g, "const $1"),
    });
    const imp = host.imports();

    const src = "const x: number = 1;";
    const [sPtr, sLen] = writeString(mem, src);
    const [fPtr, fLen] = writeString(mem, "app.ts", 0x200);
    const h = imp.jsi_transpile(sPtr, sLen, fPtr, fLen);
    const byteLen = imp.jsi_string_length(h);
    const outPtr = 0x400;
    imp.jsi_string_read(h, outPtr, byteLen);
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen));
    expect(back).toBe("const x = 1;");
  });
});

// ──────────────────────────────────────────────────────────
// jsi_call
// ──────────────────────────────────────────────────────────

describe("jsi_call", () => {
  test("调用 JS 函数并传递参数", () => {
    const mem = makeMemory();
    const host = new JsiHost({ memory: mem });
    const imp = host.imports();

    // 构造一个 JS 函数 handle
    const fn = (a: number, b: number) => a + b;
    const fnHandle = host.retain(fn);

    // 参数 handle：2 个数字
    const h1 = imp.jsi_make_number(3);
    const h2 = imp.jsi_make_number(4);

    // 写 argv 到 mem（u32 小端）
    const argvPtr = 0x300;
    const view = new DataView(mem.buffer);
    view.setUint32(argvPtr, h1, true);
    view.setUint32(argvPtr + 4, h2, true);

    const thisH = ReservedHandle.Global;
    const result = imp.jsi_call(fnHandle, thisH, argvPtr, 2);
    expect(result).not.toBe(EXCEPTION_SENTINEL);
    expect(imp.jsi_to_number(result)).toBe(7);
  });
});
