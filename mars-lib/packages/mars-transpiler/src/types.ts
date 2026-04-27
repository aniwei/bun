export type Loader = "js" | "jsx" | "ts" | "tsx" | "json"

export interface TransformInput {
  path: string
  code: string
  loader: Loader
  target?: "browser" | "bun" | "node"
  format?: "commonjs" | "esm"
  sourcemap?: boolean
  define?: Record<string, string>
}

export interface ImportRecord {
  path: string
  kind: "import" | "require" | "dynamic-import"
}

export interface Diagnostic {
  level: "error" | "warning" | "info"
  message: string
}

export interface TransformResult {
  code: string
  map?: string
  imports: ImportRecord[]
  diagnostics: Diagnostic[]
}

export interface Transpiler {
  transform(input: TransformInput): Promise<TransformResult>
  scanImports(code: string, loader: Loader): ImportRecord[]
}
