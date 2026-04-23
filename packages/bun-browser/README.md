# bun-browser

Host-side driver for running **Bun Core** (Zig, compiled to WebAssembly) inside a browser, driven by the host JS engine through a JSI bridge — without shipping JavaScriptCore.

> **Status:** Phase 5.11 complete. Full WebContainer-compatible API surface (`Kernel`, `ProcessHandle`, `WebContainer` compat layer, `kernel.fs.*`, `kernel.mount/exportFs`, `Kernel.on("port"/"server-ready"/"preview-message")`). The WASM artifact (`bun-core.wasm`) is checked-in and functional.

## Quick Start

```ts
import { WebContainer } from 'bun-browser/webcontainer-compat'

// Boot — identical to @webcontainer/api
const wc = await WebContainer.boot({ wasmModule })

// Mount files
await wc.mount({
  'index.ts': { file: { contents: 'console.log("Hello from Bun WASM!")' } },
})

// Listen for Bun.serve() port registrations
wc.on('server-ready', ({ port, url }) => {
  console.log(`Server ready at ${url}`)
  iframe.src = url
})

// Spawn a process — returns ReadableStream-based handle
const p = await wc.spawn('bun', ['run', 'index.ts'])
p.output.pipeTo(new WritableStream({ write: chunk => console.log(chunk) }))
const code = await p.exit  // → 0

// File system API
await wc.fs.writeFile('/app/data.json', '{"ok":true}')
const txt = await wc.fs.readFile('/app/data.json', 'utf-8')  // → '{"ok":true}'
const entries = await wc.fs.readdir('/')  // → [{ name, type }]
```

Or use the low-level `Kernel` API directly:

```ts
import { Kernel, ProcessHandle } from 'bun-browser'

const kernel = new Kernel({ wasmModule, workerUrl: new URL('./kernel-worker.ts', import.meta.url) })
await kernel.whenReady()

kernel.on('port', ({ port, url }) => console.log('Bun.serve port:', port, url))
kernel.on('preview-message', ({ data, origin }) => console.log('iframe message:', data, origin))

const handle = await kernel.process(['bun', '-e', 'console.log("hi")'])
const output = await new Response(handle.output).text()
const code = await handle.exit  // → 0
```

## Shape

```
┌──────────────── UI thread ────────────────┐
│  WebContainer  (webcontainer-compat.ts)   │
│    └─ Kernel (kernel.ts)                  │
│         ├─ spawns Worker(kernel-worker.ts)│
│         ├─ on("port" / "server-ready")    │
│         ├─ on("preview-message")          │
│         ├─ fs.{readFile,writeFile,...}     │
│         ├─ mount(FileSystemTree)          │
│         ├─ process(argv) → ProcessHandle  │
│         └─ postMessage() protocol.ts      │
└────────────────────┬──────────────────────┘
                     │ structured clone / Transferable
┌────────────────────▼──────────────────────┐
│  Worker (kernel-worker.ts)                │
│    JsiHost ──imports──► bun-core.wasm     │
│    installBunServeHook()  ← Proxy/Bun.serve
│    ProcessManager (spawn-worker.ts)        │
└───────────────────────────────────────────┘
```

See [docs/rfc/bun-wasm-browser-runtime-phase5-iteration.md](../../docs/rfc/bun-wasm-browser-runtime-phase5-iteration.md) for the full design and implementation plan.

## Layout

| file | purpose |
| ---- | ------- |
| `src/protocol.ts` | UI ↔ Worker message schema, versioned |
| `src/kernel.ts` | UI thread API — spawn / eval / fs / on / process / mount |
| `src/kernel-worker.ts` | Web Worker entry: wasm init + WASI shim + JSI + hooks |
| `src/webcontainer-compat.ts` | `@webcontainer/api`-compatible `WebContainer` factory class |
| `src/process-manager.ts` | Sub-process isolation via independent WASM Workers |
| `src/spawn-worker.ts` | Isolated WASM child-process Worker entry |
| `src/jsi-host.ts` | `jsi` WebAssembly imports; mirrors `src/jsi/imports.zig` |
| `src/vfs-client.ts` | Snapshot (de)serializer + FileSystemTree ↔ VfsFile conversion |
| `src/preview-router.ts` | `__bun_preview__` URL routing + `PreviewPortRegistry` |
| `src/service-worker.ts` | ServiceWorker: intercepts preview URLs, forwards to kernel |
| `src/installer.ts` | In-Worker `bun install` (fetch → gunzip → ustar → VFS) |
| `src/thread-pool.ts` | Worker thread pool for WASM threads support |
| `src/sab-ring.ts` | SharedArrayBuffer SPSC byte ring (stdio foundation) |
| `src/index.ts` | Public exports |

## API Reference (Phase 5.11)

### `WebContainer` (compat layer)

```ts
const wc = await WebContainer.boot({ wasmModule, workerUrl? })

// FileSystem
wc.fs.readFile(path): Promise<ArrayBuffer>
wc.fs.readFile(path, 'utf-8'): Promise<string>
wc.fs.writeFile(path, data): Promise<void>
wc.fs.readdir(path): Promise<FsDirEntry[]>
wc.fs.mkdir(path, { recursive? }): Promise<void>
wc.fs.rm(path, { recursive? }): Promise<void>
wc.fs.rename(from, to): Promise<void>
wc.fs.stat(path): Promise<FsStatInfo>

// Files
wc.mount(tree: FileSystemTree, { mountPoint? }): Promise<void>
wc.export(path?): Promise<FileSystemTree>            // bun-browser ext.

// Process
wc.spawn(cmd, args?, opts?): Promise<WebContainerProcess>
//   .output / .stdout / .stderr: ReadableStream<string>
//   .exit: Promise<number>
//   .kill(signal?)
//   .input: WritableStream<string>  (stub, T5.12.2)

// Events
wc.on('server-ready', ({ port, url }) => ...)
wc.on('port', ({ port, url }) => ...)
wc.on('preview-message', ({ data, source, origin }) => ...)

// Lifecycle
wc.teardown(): void
```

### `Kernel` (low-level)

```ts
const kernel = new Kernel({ wasmModule, workerUrl, spawnWorkerUrl?, initialFiles?, ... })
await kernel.whenReady()

kernel.on('port' | 'server-ready' | 'preview-message', listener)
kernel.off('port' | 'server-ready' | 'preview-message', listener)
kernel.process(argv, { env?, cwd? }): Promise<ProcessHandle>
kernel.readFile(path, encoding?): Promise<ArrayBuffer | string>
kernel.writeFile(path, data): Promise<void>
kernel.readdir(path): Promise<FsDirEntry[]>
kernel.mkdir(path, opts?): Promise<void>
kernel.rm(path, opts?): Promise<void>
kernel.rename(from, to): Promise<void>
kernel.stat(path): Promise<FsStatInfo>
kernel.mount(tree, prefix?): Promise<void>
kernel.exportFs(prefix?): Promise<FileSystemTree>
kernel.spawn(argv, opts?): Promise<number>           // simple exit-code API
kernel.eval(id, source, filename?): Promise<void>
kernel.fetch(port, init?): Promise<Response-like>
kernel.installPackages(deps, opts?): Promise<InstallResult>
kernel.registerPreviewPort(port, origin?): string
kernel.terminate(): void
```

## Requirements

- Cross-origin isolation (COOP: `same-origin`, COEP: `require-corp`) when SharedArrayBuffer-based threading is needed (Phase 5.12).
- ES modules + Web Workers support (module workers).
