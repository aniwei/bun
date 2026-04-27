export type CompatStatus = "supported" | "partial" | "unsupported" | "planned"

export interface BunApiCompatEntry {
  api: string
  status: CompatStatus
  phase: "M1" | "M2" | "M3" | "M4"
  notes: string
  tests?: string[]
}

export const bunApiCompatMatrix: BunApiCompatEntry[] = [
  {
    api: "Bun.file",
    status: "partial",
    phase: "M1",
    notes: "MarsVFS-backed text/json/arrayBuffer/stream path is covered; native file metadata parity is pending.",
    tests: ["Phase 1 Bun.file and Bun.write read and write through MarsVFS"],
  },
  {
    api: "Bun.write",
    status: "partial",
    phase: "M1",
    notes: "Writes string, Blob, Response, Request and Uint8Array-compatible input into MarsVFS.",
    tests: ["Phase 1 Bun.file and Bun.write read and write through MarsVFS"],
  },
  {
    api: "Bun.serve",
    status: "partial",
    phase: "M1",
    notes: "Virtual HTTP server registration and fetch dispatch are covered; WebSocket upgrade is pending.",
    tests: ["Phase 1 Bun.serve registers a virtual port and runtime fetch dispatches to it"],
  },
  {
    api: "Bun.build",
    status: "partial",
    phase: "M3",
    notes: "Single or multi-entry transpile output can be written to MarsVFS; full dependency bundling and splitting are pending.",
    tests: ["Phase 3 Bun.build writes transformed output to MarsVFS"],
  },
  {
    api: "Bun.spawn",
    status: "planned",
    phase: "M3",
    notes: "Planned as controlled Worker or built-in command execution, not native process spawning.",
  },
  {
    api: "Bun.spawnSync",
    status: "planned",
    phase: "M3",
    notes: "SAB-backed sync path and explicit fallback behavior are not implemented yet.",
  },
]

export function getBunApiCompat(api: string): BunApiCompatEntry | null {
  return bunApiCompatMatrix.find(entry => entry.api === api) ?? null
}