export interface TranspileOptions {
  loader?: 'ts' | 'tsx' | 'js' | 'jsx' | 'json'
  target?: 'browser' | 'bun' | 'node' | string
  jsx?: 'react' | 'react-jsx' | 'preserve'
  jsxFactory?: string
  jsxFragment?: string
  decorators?: boolean
  sourceMaps?: boolean | 'inline'
}

export interface TranspileResult {
  code: string
  imports: string[]
  map?: string
}

export interface ScanImportResult {
  path: string
  kind: 'import' | 'require' | 'dynamic-import'
}