import { describe, expect, test } from "bun:test";
import { buildSnapshot, parseSnapshot, snapshotSize } from "../src/vfs-client";

describe("vfs-client", () => {
  test("snapshotSize: 空文件列表", () => {
    expect(snapshotSize([])).toBe(4); // 仅 u32 file_count
  });

  test("snapshotSize: 单文件", () => {
    const files = [{ path: "/a.js", data: "x" }];
    // 4 (count) + 4 (path_len) + 5 ("/a.js") + 4 (data_len) + 1 ("x") + 2 (mode) = 20
    expect(snapshotSize(files)).toBe(20);
  });

  test("buildSnapshot: 返回正确长度的 ArrayBuffer", () => {
    const files = [{ path: "/a.js", data: "hello" }];
    const buf = buildSnapshot(files);
    expect(buf.byteLength).toBe(snapshotSize(files));
  });

  test("round-trip: buildSnapshot → parseSnapshot（字符串内容）", () => {
    const files = [
      { path: "/index.js", data: "console.log('hello')", mode: 0o644 },
      { path: "/lib/util.ts", data: "export const x = 1;", mode: 0o644 },
    ];
    const buf = buildSnapshot(files);
    const parsed = parseSnapshot(buf);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.path).toBe("/index.js");
    expect(parsed[1]!.path).toBe("/lib/util.ts");

    const dec = new TextDecoder();
    expect(dec.decode(parsed[0]!.data as Uint8Array)).toBe("console.log('hello')");
    expect(dec.decode(parsed[1]!.data as Uint8Array)).toBe("export const x = 1;");

    expect(parsed[0]!.mode).toBe(0o644);
    expect(parsed[1]!.mode).toBe(0o644);
  });

  test("round-trip: buildSnapshot → parseSnapshot（二进制内容）", () => {
    const bin = new Uint8Array([0x00, 0xff, 0x42, 0x7f]);
    const files = [{ path: "/data.bin", data: bin, mode: 0o600 }];
    const buf = buildSnapshot(files);
    const parsed = parseSnapshot(buf);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.path).toBe("/data.bin");
    expect(parsed[0]!.mode).toBe(0o600);
    expect(parsed[0]!.data as Uint8Array).toEqual(bin);
  });

  test("round-trip: 多文件含 unicode 路径", () => {
    const files = [
      { path: "/你好/世界.js", data: "// unicode", mode: 0o755 },
      { path: "/emoji🚀/app.ts", data: "", mode: 0o644 },
    ];
    const buf = buildSnapshot(files);
    const parsed = parseSnapshot(buf);

    expect(parsed[0]!.path).toBe("/你好/世界.js");
    expect(parsed[1]!.path).toBe("/emoji🚀/app.ts");
    const dec = new TextDecoder();
    expect(dec.decode(parsed[1]!.data as Uint8Array)).toBe("");
  });

  test("parseSnapshot: file_count=0", () => {
    const buf = buildSnapshot([]);
    expect(parseSnapshot(buf)).toEqual([]);
  });

  test("buildSnapshot 产生的缓冲区是 transferable ArrayBuffer", () => {
    const buf = buildSnapshot([{ path: "/x", data: "y" }]);
    // structuredClone 能传递 ArrayBuffer（验证其是普通 ArrayBuffer 而非 SharedArrayBuffer）
    const cloned = structuredClone(buf);
    expect(new Uint8Array(cloned)).toEqual(new Uint8Array(buf));
  });
});
