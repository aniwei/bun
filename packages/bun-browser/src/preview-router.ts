/**
 * Preview Router —— Phase 3 T3.1 可测 slice。
 *
 * 浏览器中 ServiceWorker 拦截 `${origin}/__bun_preview__/{port}/{path}`，
 * 将请求通过 MessageChannel 转发给 Kernel Worker。Router 本身只是一个
 * 端口注册表 + URL 解析/匹配规则，便于在 Node 下做单元测试。
 *
 * 注：本文件在 ServiceWorker、主线程 SDK、单测中共享（纯逻辑，无 DOM 依赖）。
 */

/** 预览 URL 的固定前缀。 */
export const PREVIEW_PATH_PREFIX = "/__bun_preview__/";

/** 从预览 URL 解析出端口与转发到 Worker 时使用的 `url`。 */
export interface ParsedPreviewUrl {
  /** 注册到 `Bun.serve()` 时分配的端口。 */
  port: number;
  /** 传给 handler 的 `Request.url`，规范化为 `http://localhost:{port}{pathAndQuery}`。 */
  forwardUrl: string;
  /** 原始请求 path（含 query、不含 prefix 与 port），以 `/` 开头。 */
  path: string;
}

/**
 * 解析形如 `https://host/__bun_preview__/40123/api/hello?x=1` 的 URL。
 * 不匹配前缀或端口非数字时返回 null。
 */
export function parsePreviewUrl(input: string | URL): ParsedPreviewUrl | null {
  const url = typeof input === "string" ? safeUrl(input) : input;
  if (!url) return null;
  const { pathname } = url;
  if (!pathname.startsWith(PREVIEW_PATH_PREFIX)) return null;
  const rest = pathname.slice(PREVIEW_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const portStr = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "/" : rest.slice(slash);
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) return null;
  const path = tail.length > 0 ? tail : "/";
  const search = url.search || "";
  const hash = url.hash || "";
  return {
    port,
    forwardUrl: `http://localhost:${port}${path}${search}${hash}`,
    path: `${path}${search}`,
  };
}

/** 由端口生成预览 URL 基路径（不含 origin），末尾含 `/`。 */
export function buildPreviewBasePath(port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) {
    throw new Error(`invalid preview port: ${port}`);
  }
  return `${PREVIEW_PATH_PREFIX}${port}/`;
}

/** 基于 location.origin + 端口构造完整预览 URL。 */
export function buildPreviewUrl(origin: string, port: number, path = "/"): string {
  const base = buildPreviewBasePath(port);
  const suffix = path.startsWith("/") ? path.slice(1) : path;
  return `${stripTrailingSlash(origin)}${base}${suffix}`;
}

/**
 * 主线程侧：维护已注册端口集合，以便 ServiceWorker 的 message 中同步更新。
 */
export class PreviewPortRegistry {
  private ports = new Set<number>();
  private listeners = new Set<(ports: number[]) => void>();

  add(port: number): void {
    if (this.ports.has(port)) return;
    this.ports.add(port);
    this.notify();
  }

  remove(port: number): boolean {
    const ok = this.ports.delete(port);
    if (ok) this.notify();
    return ok;
  }

  has(port: number): boolean {
    return this.ports.has(port);
  }

  list(): number[] {
    return [...this.ports].sort((a, b) => a - b);
  }

  onChange(fn: (ports: number[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const snapshot = this.list();
    for (const fn of this.listeners) fn(snapshot);
  }
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
