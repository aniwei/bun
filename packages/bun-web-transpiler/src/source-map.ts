function encodeBase64(input: string): string {
  if (typeof btoa === 'function') {
    return btoa(input)
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64')
  }

  throw new Error('No base64 encoder available')
}

export function createSimpleSourceMap(code: string, sourceFile = 'input.ts'): string {
  const lineCount = code.split(/\r?\n/).length
  return JSON.stringify({
    version: 3,
    file: sourceFile,
    names: [],
    sources: [sourceFile],
    sourcesContent: [code],
    mappings: ';'.repeat(Math.max(0, lineCount - 1)),
  })
}

export function inlineSourceMap(code: string, map: string): string {
  const encoded = encodeBase64(map)
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${encoded}`
}