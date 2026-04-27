export interface ResolverFileSystem {
  existsSync(path: string): boolean
  readFileSync(path: string): string | null
}

export interface ResolveOptions {
  conditions?: string[]
  extensions?: string[]
  fileSystem?: ResolverFileSystem
  tsconfigPaths?: TsconfigPaths
}

export interface ResolveContext {
  specifier: string
  importer?: string
  conditions: string[]
  extensions: string[]
  cwd: string
}

export interface ResolveResult {
  path: string
  format: "esm" | "cjs" | "json" | "wasm" | "asset"
  external?: boolean
}

export interface TsconfigPaths {
  baseUrl?: string
  paths?: Record<string, string[]>
}

export interface TsconfigPathResolver {
  resolve(specifier: string): string[]
}
