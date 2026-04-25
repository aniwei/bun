type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike }

function normalizeText(input: string): string {
  return input
    .replace(/m6-[a-z-]+-\d+-[0-9a-f]+/gi, 'm6-<id>')
    .replace(/\d{10,}/g, '<num>')
}

function sortJson(value: unknown): JsonLike {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value === 'string' ? normalizeText(value) : (value as JsonLike)
  }

  if (Array.isArray(value)) {
    return value.map(item => sortJson(item))
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: { [key: string]: JsonLike } = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key])
    }
    return sorted
  }

  return String(value) as JsonLike
}

export function stableSnapshot(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2)
}
