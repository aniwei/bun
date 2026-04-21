/**
 * Kernel worker 入口 —— 在专用 Web Worker 里拉起 bun-core.wasm + JSI Host。
 *
 * 注意：此文件假定运行在 Web Worker 上下文（`self` 为 `DedicatedWorkerGlobalScope`）。
 * 浏览器端需通过 `new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" })` 加载。
 */

import { PROTOCOL_VERSION, type HostRequest, type KernelEvent } from "./protocol";
import { createWasmRuntime, type WasmRuntime } from "./wasm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any;

function post(event: KernelEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer);
}

let rt: WasmRuntime | undefined;
let tickTimer: number | undefined;
let tickRunning = false;
let tickRequested = false;

function clearTickTimer(): void {
  if (tickTimer !== undefined) {
    clearTimeout(tickTimer);
    tickTimer = undefined;
  }
}

function scheduleTick(delayMs: number): void {
  clearTickTimer();
  tickTimer = self.setTimeout(() => {
    tickTimer = undefined;
    driveTickLoop();
  }, Math.max(0, delayMs));
}

function driveTickLoop(): void {
  if (!rt) return;
  const tick = rt.instance.exports.bun_tick as (() => number) | undefined;
  if (!tick) return;

  if (tickRunning) {
    tickRequested = true;
    return;
  }

  tickRunning = true;
  try {
    while (rt) {
      tickRequested = false;
      const nextMs = tick();
      if (nextMs > 0) {
        scheduleTick(nextMs);
        return;
      }
      if (!tickRequested) return;
    }
  } finally {
    tickRunning = false;
  }
}

function wakeTickLoop(): void {
  tickRequested = true;
  clearTickTimer();
  queueMicrotask(driveTickLoop);
}

function evalScript(runtime: WasmRuntime, source: string, filename: string): number {
  const evalFn = runtime.instance.exports.bun_browser_eval as
    | ((srcPtr: number, srcLen: number, filePtr: number, fileLen: number) => number)
    | undefined;
  if (!evalFn) throw new Error("bun_browser_eval export missing");

  let code = -1;
  runtime.withString(source, (srcPtr, srcLen) => {
    runtime.withString(filename, (filePtr, fileLen) => {
      code = evalFn(srcPtr, srcLen, filePtr, fileLen);
    });
  });
  return code;
}

function pathDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function applyProcessState(
  runtime: WasmRuntime,
  argv?: string[],
  env?: Record<string, string>,
  cwd?: string,
): void {
  if (argv === undefined && env === undefined && cwd === undefined) return;

  const nextArgv = ["bun", ...(argv ?? [])];
  const nextEnv = env ?? {};
  const nextCwd = cwd ?? "/";
  const code = evalScript(
    runtime,
    `if (globalThis.process && typeof globalThis.process === 'object') { globalThis.process.argv = ${JSON.stringify(nextArgv)}; globalThis.process.env = ${JSON.stringify(nextEnv)}; globalThis.__bun_cwd = ${JSON.stringify(nextCwd)}; }`,
    "<kernel:process-state>",
  );
  if (code !== 0) {
    throw new Error(`failed to apply process state: ${code}`);
  }
}

self.addEventListener("message", async (ev: MessageEvent<HostRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case "handshake": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `Protocol version mismatch: host=${msg.protocolVersion}, kernel=${PROTOCOL_VERSION}`,
          );
        }
        rt = await createWasmRuntime(msg.wasmModule, {
          onPrint: (data, kind) => post({ kind, data }),
        });
        post({ kind: "handshake:ack", protocolVersion: PROTOCOL_VERSION, engine: "browser" });

        const initialCwd = msg.entry ? pathDirname(msg.entry) : undefined;
        applyProcessState(rt, msg.argv, msg.env, initialCwd);

        if (msg.vfsSnapshot) {
          const loader = rt.instance.exports.bun_vfs_load_snapshot as
            | ((ptr: number, len: number) => number)
            | undefined;
          if (loader) {
            rt.withBytes(new Uint8Array(msg.vfsSnapshot), (ptr, len) => loader(ptr, len));
          }
        }

        post({ kind: "ready" });

        if (msg.entry) {
          const runner = rt.instance.exports.bun_browser_run as
            | ((entryPtr: number, entryLen: number) => number)
            | undefined;
          if (runner) {
            rt.withString(msg.entry, (ptr, len) => {
              const code = runner(ptr, len);
              post({ kind: "exit", code });
            });
            wakeTickLoop();
          }
        }
        break;
      }

      case "run": {
        if (!rt) throw new Error("not initialized");
        applyProcessState(rt, msg.argv, msg.env, pathDirname(msg.entry));

        const runner = rt.instance.exports.bun_browser_run as
          | ((entryPtr: number, entryLen: number) => number)
          | undefined;
        if (!runner) throw new Error("bun_browser_run export missing");
        rt.withString(msg.entry, (ptr, len) => {
          const code = runner(ptr, len);
          post({ kind: "exit", code });
        });
        wakeTickLoop();
        break;
      }

      case "vfs:snapshot": {
        if (!rt) throw new Error("not initialized");
        const loader = rt.instance.exports.bun_vfs_load_snapshot as
          | ((ptr: number, len: number) => number)
          | undefined;
        if (loader) {
          rt.withBytes(new Uint8Array(msg.snapshot), (ptr, len) => loader(ptr, len));
        }
        break;
      }

      case "eval": {
        if (!rt) throw new Error("not initialized");
        let evalErr: string | undefined;
        const code = evalScript(rt, msg.source, msg.filename ?? "<eval>");
        if (code !== 0) evalErr = `eval returned exit code ${code}`;
        post({ kind: "eval:result", id: msg.id, error: evalErr });
        wakeTickLoop();
        break;
      }

      case "spawn": {
        if (!rt) throw new Error("not initialized");
        // Apply env/cwd overrides before running the spawned command.
        if (msg.env !== undefined || msg.cwd !== undefined) {
          applyProcessState(rt, msg.argv, msg.env, msg.cwd);
        }
        const spawnFn = rt.instance.exports.bun_spawn as
          | ((cmdPtr: number, cmdLen: number) => number)
          | undefined;
        if (!spawnFn) throw new Error("bun_spawn export missing");
        let exitCode = 0;
        rt.withString(JSON.stringify(msg.argv), (ptr, len) => {
          exitCode = spawnFn(ptr, len);
        });
        post({ kind: "spawn:exit", id: msg.id, code: exitCode });
        wakeTickLoop();
        break;
      }

      case "serve:fetch": {
        if (!rt) throw new Error("not initialized");
        // 用户 JS 经由 `jsi_eval` = `new Function(code)()` 在 worker globalThis 下执行；
        // `Bun.serve()` 把路由写到 `globalThis.__bun_routes[port]`，这里直接读同一 globalThis。
        const routes = (self as Record<string, unknown>).__bun_routes as
          | Record<number, { fetch: (req: Request) => Response | Promise<Response> }>
          | undefined;
        const route = routes?.[msg.port];
        if (!route) {
          post({
            kind: "serve:fetch:response",
            id: msg.id,
            status: 502,
            headers: {},
            body: "",
            error: `no route registered for port ${msg.port}`,
          });
          break;
        }
        // 异步派发；响应到达后再 post。注意不要 await —— onMessage 是同步回调。
        void (async () => {
          try {
            const init: RequestInit = { method: msg.method ?? "GET" };
            if (msg.headers) init.headers = msg.headers;
            if (msg.body !== undefined) init.body = msg.body as BodyInit;
            const req = new Request(msg.url, init);
            const res = await route.fetch(req);
            const body = await res.text();
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            post({
              kind: "serve:fetch:response",
              id: msg.id,
              status: res.status,
              statusText: res.statusText,
              headers,
              body,
            });
          } catch (err) {
            post({
              kind: "serve:fetch:response",
              id: msg.id,
              status: 500,
              headers: {},
              body: "",
              error: (err as Error).message,
            });
          }
          wakeTickLoop();
        })();
        break;
      }

      case "stop": {
        clearTickTimer();
        post({ kind: "exit", code: msg.code ?? 130 });
        break;
      }

      default:
        break;
    }
  } catch (e) {
    const err = e as Error;
    post({ kind: "error", message: err.message, stack: err.stack });
  }
});

