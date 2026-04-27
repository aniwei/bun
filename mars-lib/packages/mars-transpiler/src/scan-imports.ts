import type { ImportRecord, Loader } from "./types"

const staticImportPattern = /(?:import\s+[^"']*from\s*|import\s*)["']([^"']+)["']/g
const dynamicImportPattern = /(?<![A-Za-z0-9_$])import\(\s*["']([^"']+)["']\s*\)/g
const marsDynamicImportPattern = /__mars_dynamic_import\(\s*["']([^"']+)["']\s*\)/g
const requirePattern = /require\(\s*["']([^"']+)["']\s*\)/g

export function scanImports(code: string, loader: Loader): ImportRecord[] {
  void loader
  const records: ImportRecord[] = []

  records.push(...extractByPattern(code, staticImportPattern, "import"))
  records.push(...extractByPattern(code, dynamicImportPattern, "dynamic-import"))
  records.push(...extractByPattern(code, marsDynamicImportPattern, "dynamic-import"))
  records.push(...extractByPattern(code, requirePattern, "require"))

  return records
}

function extractByPattern(
  sourceCode: string,
  pattern: RegExp,
  kind: ImportRecord["kind"],
): ImportRecord[] {
  const records: ImportRecord[] = []

  for (const match of sourceCode.matchAll(pattern)) {
    if (!match[1]) continue
    records.push({ path: match[1], kind })
  }

  return records
}
