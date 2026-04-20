# bun-browser

Host-side driver for running **Bun Core** (Zig, compiled to WebAssembly) inside a browser, driven by the host JS engine through a JSI bridge — without shipping JavaScriptCore.

> **Status:** scaffold. Phase 0 of the implementation plan. The WASM artifact (`bun-core.wasm`) is not produced yet; the TS here defines the host-side contract and will be wired up as later phases land.

## Shape

```
┌──────────────── UI thread ────────────────┐
│  Kernel (kernel.ts)                       │
│     ├─ spawns Worker(kernel-worker.ts)    │
│     └─ postMessage() protocol.ts          │
└────────────────────┬──────────────────────┘
                     │ structured clone / Transferable
┌────────────────────▼──────────────────────┐
│  Worker                                   │
│    JsiHost ──imports──► bun-core.wasm     │
│       │                    │              │
│       └── Zig sys_wasm ◄── VFS snapshot   │
└───────────────────────────────────────────┘
```

See [`docs/rfc/bun-wasm-browser-runtime-technical-design.md`](../../docs/rfc/bun-wasm-browser-runtime-technical-design.md) and [`docs/rfc/bun-wasm-browser-runtime-implementation-plan.md`](../../docs/rfc/bun-wasm-browser-runtime-implementation-plan.md) for the full design.

## Layout

| file | purpose |
| ---- | ------- |
| `src/protocol.ts` | UI ↔ Kernel message schema, versioned |
| `src/jsi-host.ts` | `jsi` WebAssembly imports; mirrors `src/jsi/imports.zig` |
| `src/vfs-client.ts` | Snapshot (de)serializer; mirrors `src/sys_wasm/vfs.zig` format |
| `src/kernel-worker.ts` | Web Worker entry: instantiates wasm + WASI shim + JSI |
| `src/kernel.ts` | UI thread API (spawn / handshake / run / I/O) |
| `src/index.ts` | Public exports |

## Requirements

- Cross-origin isolation (COOP: `same-origin`, COEP: `require-corp`) when SharedArrayBuffer-based threading lands in a later phase.
- ES modules + Web Workers support (module workers).
