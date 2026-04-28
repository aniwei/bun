import initSwc, { transformSync } from "@swc/wasm-web"
import { createWasmLoader } from "@mars/shared"

import { scanImports } from "./scan-imports"

import type { ImportRecord, Loader, TransformInput, TransformResult, Transpiler } from "./types"
import type { Options } from "@swc/wasm-web"

const swcWasmLoader = createWasmLoader("@swc/wasm-web", () => initSwc())
let swcWasmEnabled = true

export function setSwcWasmEnabled(enabled: boolean): void {
  swcWasmEnabled = enabled
}

export async function preloadSwcWasm(): Promise<void> {
  if (!swcWasmEnabled) return
  await swcWasmLoader.load()
}

class BasicTranspiler implements Transpiler {
  async transform(input: TransformInput): Promise<TransformResult> {
    const diagnostics = validateSource(input.code, input.path)
    const transformedCode = transformSourceCode(input.code, input.loader, input.define, input.format)
    const imports = scanImports(transformedCode, input.loader)

    return {
      code: transformedCode,
      ...(input.sourcemap ? { map: "" } : {}),
      imports,
      diagnostics,
    }
  }

  scanImports(code: string, loader: Loader) {
    return scanImports(code, loader)
  }
}

export function createTranspiler(): Transpiler {
  return new SwcWasmTranspiler()
}

export function transformSourceCode(
  sourceCode: string,
  loader: Loader,
  define: Record<string, string> = {},
  format: TransformInput["format"] = "commonjs",
): string {
  const executableSource = stripShebang(sourceCode)
  if (loader === "json") return format === "esm" ? `export default ${sourceCode.trim() || "null"};` : sourceCode

  if (swcWasmEnabled && swcWasmLoader.ready) {
    try {
      return transformSourceCodeWithSwc(executableSource, loader, define, undefined, false, format)
    } catch {
      return transformSourceCodeWithBasic(executableSource, loader, define, format)
    }
  }

  return transformSourceCodeWithBasic(executableSource, loader, define, format)
}

class SwcWasmTranspiler implements Transpiler {
  readonly #fallback = new BasicTranspiler()

  async transform(input: TransformInput): Promise<TransformResult> {
    if (input.loader === "json") return this.#fallback.transform(input)

    try {
      if (!swcWasmEnabled) return this.#fallback.transform(input)
      await swcWasmLoader.load()
      const executableSource = stripShebang(input.code)
      const diagnostics = validateSource(input.code, input.path)
      const preparedSource = prepareSourceForSwc(executableSource, input.define, input.format)
      const output = transformSync(preparedSource, createSwcOptions(input))
      const transformedCode = injectMarsJsxHelper(output.code, input.loader)
      const imports = mergeImportRecords(
        scanImports(transformedCode, input.loader),
        scanImports(preparedSource, input.loader),
      )

      return {
        code: transformedCode,
        ...(input.sourcemap ? { map: output.map ?? "" } : {}),
        imports,
        diagnostics,
      }
    } catch {
      return this.#fallback.transform(input)
    }
  }

  scanImports(code: string, loader: Loader) {
    return scanImports(code, loader)
  }
}

function stripShebang(sourceCode: string): string {
  return sourceCode.startsWith("#!") ? sourceCode.replace(/^#!.*(?:\n|$)/, "") : sourceCode
}

function transformSourceCodeWithSwc(
  sourceCode: string,
  loader: Loader,
  define: Record<string, string>,
  path = "mars-source.ts",
  sourcemap = false,
  format: TransformInput["format"] = "commonjs",
): string {
  const preparedSource = prepareSourceForSwc(sourceCode, define, format)
  const output = transformSync(preparedSource, createSwcOptions({
    path,
    code: sourceCode,
    loader,
    sourcemap,
    define,
    format,
  }))

  return injectMarsJsxHelper(output.code, loader)
}

function prepareSourceForSwc(
  sourceCode: string,
  define: Record<string, string> = {},
  format: TransformInput["format"] = "commonjs",
): string {
  const definedSource = applyDefineReplacements(sourceCode, define)

  return format === "esm" ? definedSource : transformDynamicImports(definedSource)
}

function createSwcOptions(input: TransformInput): Options {
  const isTypescript = input.loader === "ts" || input.loader === "tsx"
  const isJsx = input.loader === "jsx" || input.loader === "tsx"

  return {
    filename: input.path,
    sourceMaps: input.sourcemap ? true : false,
    inlineSourcesContent: false,
    jsc: {
      parser: isTypescript
        ? { syntax: "typescript", tsx: isJsx, dynamicImport: true }
        : { syntax: "ecmascript", jsx: isJsx, dynamicImport: true },
      target: "es2022",
      transform: isJsx
        ? {
            react: {
              runtime: "classic",
              pragma: "__mars_jsx",
              pragmaFrag: "__mars_jsx_fragment",
            },
          }
        : undefined,
    },
    module: {
      type: input.format === "esm" ? "es6" : "commonjs",
      strict: true,
      strictMode: false,
      noInterop: true,
      importInterop: "node",
      ignoreDynamic: true,
    },
  }
}

function injectMarsJsxHelper(sourceCode: string, loader: Loader): string {
  if (loader !== "tsx" && loader !== "jsx") return sourceCode
  if (!sourceCode.includes("__mars_jsx(")) return sourceCode
  if (sourceCode.includes("const __mars_jsx =")) return sourceCode

  return [
    "const __mars_jsx = (tag, props, ...children) => ({ tag, props: props ?? {}, children })",
    sourceCode,
  ].join("\n")
}

function mergeImportRecords(
  transformedImports: ImportRecord[],
  sourceImports: ImportRecord[],
): ImportRecord[] {
  const merged = new Map<string, ImportRecord>()

  for (const importRecord of transformedImports) {
    if (!merged.has(importRecord.path)) merged.set(importRecord.path, importRecord)
  }

  for (const importRecord of sourceImports) {
    if (importRecord.kind === "dynamic-import" || !merged.has(importRecord.path)) {
      merged.set(importRecord.path, importRecord)
    }
  }

  return Array.from(merged.values())
}

function transformSourceCodeWithBasic(
  sourceCode: string,
  loader: Loader,
  define: Record<string, string> = {},
  format: TransformInput["format"] = "commonjs",
): string {
  if (loader === "json") return format === "esm" ? `export default ${sourceCode.trim() || "null"};` : sourceCode

  let transformedCode = applyDefineReplacements(sourceCode, define)

  if (loader === "ts" || loader === "tsx") {
    transformedCode = transformedCode
      .replace(
        /(\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>,[\]\s|&?]*(?=\s*=)/g,
        "$1",
      )
      .replace(
        /([,(]\s*[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>,[\]\s|&?]*(?=\s*[,)=])/g,
        "$1",
      )
      .replace(
        /(\))\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>,[\]\s|&?]*(?=\s*[{=>])/g,
        "$1",
      )
      .replace(/interface\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\{[^}]*\}/g, "")
      .replace(/type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^;]+;?/g, "")
  }

  if (loader === "tsx" || loader === "jsx") {
    transformedCode = transformJsxSyntax(transformedCode)
  }

  if (format === "esm") return transformedCode

  transformedCode = transformDynamicImports(transformedCode)
  transformedCode = transformStaticImports(transformedCode)

  return transformEsModuleSyntax(transformedCode)
}

function validateSource(sourceCode: string, path: string) {
  if (sourceCode.trim().length > 0) return []

  return [
    {
      level: "warning" as const,
      message: `empty source file: ${path}`,
    },
  ]
}

function applyDefineReplacements(
  sourceCode: string,
  define: Record<string, string>,
): string {
  let transformedCode = sourceCode

  for (const [key, value] of Object.entries(define)) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(key)}(?![A-Za-z0-9_$])`, "g")
    transformedCode = transformedCode.replace(pattern, (_source, prefix: string) => {
      return `${prefix}${value}`
    })
  }

  return transformedCode
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function transformEsModuleSyntax(sourceCode: string): string {
  const exportedSymbols: string[] = []
  let transformedCode = sourceCode

  transformedCode = transformedCode.replace(
    /export\s+default\s+/g,
    "const __mars_default_export__ = ",
  )

  transformedCode = transformedCode.replace(
    /export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_source, declarationKind: string, symbolName: string) => {
      exportedSymbols.push(symbolName)
      return `${declarationKind} ${symbolName}`
    },
  )

  transformedCode = transformedCode.replace(
    /export\s+async\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_source, symbolName: string) => {
      exportedSymbols.push(symbolName)
      return `async function ${symbolName}`
    },
  )

  transformedCode = transformedCode.replace(
    /export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_source, symbolName: string) => {
      exportedSymbols.push(symbolName)
      return `function ${symbolName}`
    },
  )

  transformedCode = transformedCode.replace(
    /export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    (_source, symbolName: string) => {
      exportedSymbols.push(symbolName)
      return `class ${symbolName}`
    },
  )

  transformedCode = transformedCode.replace(
    /export\s*\{([^}]+)\}\s*;?/g,
    (_source, exportedGroup: string) => {
      const segments = exportedGroup
        .split(",")
        .map(segment => segment.trim())
        .filter(Boolean)

      const assignmentLines = segments.map(segment => {
        const [localName, exportedName] = segment.split(/\s+as\s+/)
        const localSymbol = localName.trim()
        const exposedName = (exportedName ?? localName).trim()

        return `exports.${exposedName} = ${localSymbol}`
      })

      return assignmentLines.join("\n")
    },
  )

  const exportAssignments = exportedSymbols
    .map(symbolName => `exports.${symbolName} = ${symbolName}`)
    .join("\n")

  const defaultAssignment = transformedCode.includes("__mars_default_export__")
    ? "\nexports.default = __mars_default_export__"
    : ""

  if (!exportAssignments && !defaultAssignment) return transformedCode

  return `${transformedCode}\n${exportAssignments}${defaultAssignment}`
}

function transformStaticImports(sourceCode: string): string {
  let importIndex = 0
  let transformedCode = sourceCode

  transformedCode = transformedCode.replace(
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,
    (_source, defaultName: string, namedGroup: string, specifier: string) => {
      const importName = `__mars_import_${importIndex++}`
      return [
        `const ${importName} = require(${JSON.stringify(specifier)})`,
        `const ${defaultName} = ${importName}.default ?? ${importName}`,
        `const { ${normalizeNamedImports(namedGroup)} } = ${importName}`,
      ].join("\n")
    },
  )

  transformedCode = transformedCode.replace(
    /import\s+\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,
    (_source, namedGroup: string, specifier: string) => {
      return `const { ${normalizeNamedImports(namedGroup)} } = require(${JSON.stringify(specifier)})`
    },
  )

  transformedCode = transformedCode.replace(
    /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*["']([^"']+)["'];?/g,
    (_source, namespaceName: string, specifier: string) => {
      return `const ${namespaceName} = require(${JSON.stringify(specifier)})`
    },
  )

  transformedCode = transformedCode.replace(
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*["']([^"']+)["'];?/g,
    (_source, defaultName: string, specifier: string) => {
      const importName = `__mars_import_${importIndex++}`
      return [
        `const ${importName} = require(${JSON.stringify(specifier)})`,
        `const ${defaultName} = ${importName}.default ?? ${importName}`,
      ].join("\n")
    },
  )

  return transformedCode.replace(
    /import\s*["']([^"']+)["'];?/g,
    (_source, specifier: string) => `require(${JSON.stringify(specifier)})`,
  )
}

function transformDynamicImports(sourceCode: string): string {
  return sourceCode.replace(
    /import\(\s*(["'][^"']+["'])\s*\)/g,
    (_source, specifier: string) => `__mars_dynamic_import(${specifier})`,
  )
}

function transformJsxSyntax(sourceCode: string): string {
  let changed = false
  let transformedCode = sourceCode.replace(
    /<([A-Za-z][A-Za-z0-9]*)\s*\/\s*>/g,
    (_source, tagName: string) => {
      changed = true
      return `__mars_jsx(${JSON.stringify(tagName)}, null)`
    },
  )

  transformedCode = transformedCode.replace(
    /<([A-Za-z][A-Za-z0-9]*)>(\{([^}]+)\}|[^<]*)<\/\1>/g,
    (_source, tagName: string, rawChild: string, expressionChild: string | undefined) => {
      changed = true
      const childExpression = expressionChild
        ? expressionChild.trim()
        : JSON.stringify(rawChild.trim())

      return `__mars_jsx(${JSON.stringify(tagName)}, null, ${childExpression})`
    },
  )

  if (!changed) return transformedCode

  return [
    "const __mars_jsx = (tag, props, ...children) => ({ tag, props: props ?? {}, children })",
    transformedCode,
  ].join("\n")
}

function normalizeNamedImports(namedGroup: string): string {
  return namedGroup
    .split(",")
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.replace(/\s+as\s+/g, ": "))
    .join(", ")
}
