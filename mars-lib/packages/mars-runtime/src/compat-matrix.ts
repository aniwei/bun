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
    notes: "Virtual HTTP server registration, listen(0)-style dynamic ports and fetch dispatch are covered; WebSocket upgrade uses an in-process MarsServerWebSocket/MarsClientWebSocket MessageChannel pair — server.upgrade(request) returns true and triggers the websocket.open/message/close callbacks, while the client side uses MarsClientWebSocket instead of a native ws:// connection since Service Workers cannot intercept native WebSocket upgrades.",
    tests: [
      "Phase 1 Bun.serve registers a virtual port and runtime fetch dispatches to it",
      "Phase 3 Bun.serve WebSocket upgrade creates bidirectional WebSocket connection",
    ],
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
    notes: "Shell command `bun install` reads package.json dependencies/devDependencies/optionalDependencies/peerDependencies/workspaces from MarsVFS and writes node_modules plus mars-lock.json/bun.lock through MarsInstaller. bun.lock uses a structured payload (lockfileVersion/configVersion/workspaces/packages) with deterministic ordering, root workspace name, tuple-style package entries (specifier/source/metadata object plus optional resolved field), resolved dependency versions inside package metadata, and resolved/workspace package metadata, and installer can replay locked versions from bun.lock/mars-lock.json when root dependency declarations match. Cache miss can fetch registry metadata and tarball bytes through an injected registry client, optional dependencies are installed when available and skipped when missing, required peer dependencies are installed when missing, existing peer versions are checked against requested ranges, optional peers may be skipped, local workspace packages are discovered from package.json workspaces, can satisfy workspace: protocol ranges and are linked into node_modules as VFS symlinks, package/root preinstall/install/postinstall lifecycle scripts are executed through MarsShell with failure propagation, lifecycle env includes npm_lifecycle_*, npm_command, npm_package_json, npm_config_{global,local_prefix,prefix,user_agent} and flattened npm_package_* fields, package bin metadata writes node_modules/.bin shims that lifecycle PATH can execute as shebang JS binaries, basic npm .tgz/PAX archives are extracted into package files with PAX path/linkpath, safe tar symlinks and path traversal filtering, and common semver ranges select the highest satisfying version with hyphen range, partial comparator, partial caret/tilde, comma comparator sets, spaced comparator tokens, OR-combined prerelease gating, v-prefixed exact and partial versions, prerelease opt-in and build metadata support; full Bun lockfile text-format parity and remaining advanced npm semver edge syntax are pending. Current Express/Koa playground cases use built-in app-shaped fixtures, not npm express/koa packages.",
    tests: ["Phase 2 shell bun install writes offline packages from package.json", "Phase 2 installer fetches missing packages from registry", "Phase 2 installer extracts registry tgz package files", "Phase 2 installer extracts PAX tar paths and ignores unsafe entries", "Phase 2 installer selects highest satisfying semver ranges", "Phase 2 installer installs available optional dependencies and skips missing ones", "Phase 2 shell bun install reads optionalDependencies from package.json", "Phase 2 installer installs required peer dependencies and skips missing optional peers", "Phase 2 installer rejects incompatible peer dependency ranges", "Phase 2 shell bun install reads peerDependencies from package.json", "Phase 2 installer links local workspace packages and workspace protocol dependencies", "Phase 2 shell bun install discovers package.json workspaces", "Phase 2 shell bun install runs package and root lifecycle scripts", "Phase 2 shell bun install executes package JS bins from lifecycle scripts", "Phase 2 shell bun install fails when lifecycle script fails", "Phase 2 shell bun install can fetch package.json dependencies from registry"],
  },
  {
    api: "Bun.spawn",
    status: "partial",
    phase: "M3",
    notes: "Bun.spawn({ cmd }) and runtime.spawn() can execute both bun run <entry> and generic shell commands through the current in-memory Kernel pid + shell dispatch path; Process Worker isolation and streaming stdin backpressure parity are pending.",
    tests: [
      "Phase 3 Bun.spawn executes bun run index.ts through kernel stdio",
      "Phase 3 Bun.spawn executes general shell command through kernel stdio",
      "Phase 3 runtime.spawn executes general shell command through kernel stdio",
    ],
  },
  {
    api: "Bun.spawnSync",
    status: "partial",
    phase: "M3",
    notes: "Supports explicit capability-aware fallback: no-SAB profile returns a deterministic SharedArrayBuffer/Atomics requirement error, SAB-enabled profile returns a deterministic not-wired-yet sync executor error; SAB-backed true sync execution is pending.",
    tests: [
      "Phase 3 Bun.spawnSync returns explicit fallback result",
      "Phase 3 Bun.spawnSync reports no-SAB fallback explicitly",
    ],
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
    notes: "Bun.sql uses sql.js (sqlite WASM) with MarsVFS-backed binary database persistence, covering create/insert/select/count/update/delete, tagged queries and BEGIN/COMMIT/ROLLBACK transaction semantics.",
    tests: [
      "Phase 3 Bun.sql stores and queries rows through MarsVFS",
      "Phase 3 Bun.sql supports BEGIN/COMMIT/ROLLBACK transaction semantics",
    ],
  },
]

export function getBunApiCompat(api: string): BunApiCompatEntry | null {
  return bunApiCompatMatrix.find(entry => entry.api === api) ?? null
}