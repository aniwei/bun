/**
 * VFS client —— UI 线程侧辅助，用于构造要发送到 Worker 的 VFS snapshot 缓冲区。
 *
 * Snapshot 二进制格式（小端）：
 *   [u32 file_count]
 *   { [u32 path_len][u8[] path][u32 data_len][u8[] data][u16 mode] } × file_count
 *
 * 必须与 `src/sys_wasm/vfs.zig` 的 `loadSnapshot` / `exportSnapshot` 保持一致。
 */

export interface VfsFile {
  path: string;
  data: Uint8Array | string;
  /** POSIX mode bits（例如 0o644），缺省 0o644。 */
  mode?: number;
}

const encoder = new TextEncoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** 计算 snapshot 所需字节数。 */
export function snapshotSize(files: readonly VfsFile[]): number {
  let total = 4; // u32 file_count
  for (const f of files) {
    const pathBytes = encoder.encode(f.path).byteLength;
    const dataBytes = toBytes(f.data).byteLength;
    total += 4 + pathBytes + 4 + dataBytes + 2;
  }
  return total;
}

/** 序列化一组文件为 snapshot 缓冲区（返回 transferable ArrayBuffer）。 */
export function buildSnapshot(files: readonly VfsFile[]): ArrayBuffer {
  const buf = new ArrayBuffer(snapshotSize(files));
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  view.setUint32(off, files.length, true);
  off += 4;

  for (const f of files) {
    const path = encoder.encode(f.path);
    const data = toBytes(f.data);
    const mode = f.mode ?? 0o644;

    view.setUint32(off, path.byteLength, true);
    off += 4;
    bytes.set(path, off);
    off += path.byteLength;

    view.setUint32(off, data.byteLength, true);
    off += 4;
    bytes.set(data, off);
    off += data.byteLength;

    view.setUint16(off, mode & 0xffff, true);
    off += 2;
  }

  return buf;
}

/** 解析 snapshot（主要用于测试/调试）。 */
export function parseSnapshot(buf: ArrayBuffer): VfsFile[] {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder("utf-8");
  let off = 0;
  const count = view.getUint32(off, true);
  off += 4;
  const out: VfsFile[] = [];
  for (let i = 0; i < count; i++) {
    const pathLen = view.getUint32(off, true);
    off += 4;
    const path = decoder.decode(bytes.subarray(off, off + pathLen));
    off += pathLen;
    const dataLen = view.getUint32(off, true);
    off += 4;
    const data = bytes.slice(off, off + dataLen);
    off += dataLen;
    const mode = view.getUint16(off, true);
    off += 2;
    out.push({ path, data, mode });
  }
  return out;
}
