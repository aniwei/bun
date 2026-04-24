export interface TranspileOptions {
  loader?: 'ts' | 'tsx' | 'js' | 'jsx'
  target?: string
}

export interface ScanImportResult {
  path: string
  kind: 'import' | 'require' | 'dynamic-import'
}

const IMPORT_RE = /import\s+(?:[^'"()]*?from\s+)?['\"]([^'\"]+)['\"]/g
const REQUIRE_RE = /require\(\s*['\"]([^'\"]+)['\"]\s*\)/g
const DYNAMIC_IMPORT_RE = /import\(\s*['\"]([^'\"]+)['\"]\s*\)/g

function stripTypeOnlySyntax(code: string): string {
  return code
    .replace(/:\s*[A-Za-z_$][A-Za-z0-9_$<>,\s\[\]\|&?:]*/g, '')
    .replace(/interface\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\{[^}]*\}/g, '')
    .replace(/type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^;]+;/g, '')
}

export class WebTranspiler {
  transform(code: string, options: TranspileOptions = {}): string {
    const loader = options.loader ?? 'ts'

    if (typeof Bun !== 'undefined' && typeof Bun.Transpiler === 'function') {
      const transpiler = new Bun.Transpiler({
        loader,
        target: options.target as Bun.TranspilerOptions['target'],
      })
      return transpiler.transformSync(code)
    }

    if (loader === 'ts' || loader === 'tsx') {
      return stripTypeOnlySyntax(code)
    }

    return code
  }

  scanImports(code: string): ScanImportResult[] {
    const out: ScanImportResult[] = []

    for (const match of code.matchAll(IMPORT_RE)) {
      out.push({ path: match[1], kind: 'import' })
    }
    for (const match of code.matchAll(REQUIRE_RE)) {
      out.push({ path: match[1], kind: 'require' })
    }
    for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
      out.push({ path: match[1], kind: 'dynamic-import' })
    }

    return out
  }
}

export function createTranspiler(): WebTranspiler {
  return new WebTranspiler()
}

export function scanImports(code: string): ScanImportResult[] {
  return createTranspiler().scanImports(code)
}
