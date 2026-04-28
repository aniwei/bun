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
    notes: "Virtual HTTP server registration, listen(0)-style dynamic ports and fetch dispatch are covered; WebSocket upgrade is pending.",
    tests: ["Phase 1 Bun.serve registers a virtual port and runtime fetch dispatches to it"],
  },
  {
    api: "node:http",
    status: "partial",
    phase: "M1",
    notes: "createServer/listen/listen(0)/address/close, listening/request/close events, IncomingMessage request metadata/body access and ServerResponse writeHead/write/end are covered through pure node:http plus Express app/router/middleware and Koa async middleware playground paths. node:http registers directly with MarsKernel instead of wrapping Bun.serve; both share the virtual port table and dispatch path. Streaming and upgrade parity are pending.",
    tests: ["Phase 1 node:http compat creates virtual servers for pure Node HTTP, Express and Koa style handlers"],
  },
  {
    api: "Bun.build",
    status: "partial",
    phase: "M3",
    notes: "Single or multi-entry esbuild-wasm transform output and external source map artifacts can be written to MarsVFS; full dependency bundling and splitting are pending.",
    tests: ["Phase 3 Bun.build writes transformed output to MarsVFS", "Phase 3 Bun.build writes external source map output to MarsVFS"],
  },
  {
    api: "bun run",
    status: "partial",
    phase: "M3",
    notes: "MarsShell can dispatch bun run <entry> into the current in-memory Kernel pid and runEntryScript path; Process Worker isolation and real ServiceWorker module interception are pending.",
    tests: ["Phase 3 shell bun run executes index.ts through kernel stdio"],
  },
  {
    api: "bun install",
    status: "partial",
    phase: "M2",
    notes: "Shell command `bun install` reads package.json dependencies/devDependencies from MarsVFS and writes node_modules plus mars-lock.json through MarsInstaller. Cache miss can fetch registry metadata and tarball bytes through an injected registry client, and basic npm .tgz archives are extracted into package files; lifecycle scripts, workspaces, full semver and Bun lockfile parity are pending. Current Express/Koa playground cases use built-in app-shaped fixtures, not npm express/koa packages.",
    tests: ["Phase 2 shell bun install writes offline packages from package.json", "Phase 2 installer fetches missing packages from registry", "Phase 2 installer extracts registry tgz package files", "Phase 2 shell bun install can fetch package.json dependencies from registry"],
  },
  {
    api: "Bun.spawn",
    status: "partial",
    phase: "M3",
    notes: "Bun.spawn({ cmd }) and runtime.spawn() can execute bun run <entry> through the current in-memory Kernel pid path; general command execution, Process Worker isolation and streaming stdin are pending.",
    tests: ["Phase 3 Bun.spawn executes bun run index.ts through kernel stdio"],
  },
  {
    api: "Bun.spawnSync",
    status: "partial",
    phase: "M3",
    notes: "Returns an explicit unsupported fallback result in the current async browser profile; SAB-backed sync execution is pending.",
    tests: ["Phase 3 Bun.spawnSync returns explicit fallback result"],
  },
  {
    api: "Bun.CryptoHasher",
    status: "partial",
    phase: "M3",
    notes: "WebCrypto-backed sha1/sha256/sha512 digest path and Mars md5 fallback are covered; Bun's synchronous digest parity is pending.",
    tests: ["Phase 3 CryptoHasher digests common algorithms"],
  },
  {
    api: "Bun.password",
    status: "partial",
    phase: "M3",
    notes: "WebCrypto PBKDF2-SHA256 hash/verify fallback is covered; Bun bcrypt/argon2 compatibility is pending.",
    tests: ["Phase 3 Bun.password hashes and verifies through WebCrypto"],
  },
  {
    api: "node:crypto",
    status: "partial",
    phase: "M3",
    notes: "randomUUID, randomBytes, async createHash digest and async createHmac digest are covered for common algorithms; full Node synchronous Hash/Hmac parity is pending.",
    tests: ["Phase 3 node crypto subset covers random, createHash and createHmac"],
  },
  {
    api: "Bun.sql",
    status: "partial",
    phase: "M3",
    notes: "MarsVFS-backed sqlite prework supports create/insert/select/count/update/delete and tagged queries; native sqlite WASM parity is pending.",
    tests: ["Phase 3 Bun.sql stores and queries rows through MarsVFS"],
  },
]

export function getBunApiCompat(api: string): BunApiCompatEntry | null {
  return bunApiCompatMatrix.find(entry => entry.api === api) ?? null
}