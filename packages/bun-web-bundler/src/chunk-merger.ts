export interface ChunkMergeArtifact {
  path: string
  kind: 'entry-point' | 'chunk' | 'asset' | 'sourcemap' | 'bytecode'
  bytes: number
}

export type ChunkMergeMode = 'metadata' | 'entry-only' | 'size-buckets'

export interface ChunkMergeSizeBucket {
  label: 'tiny' | 'small' | 'medium' | 'large'
  minBytes: number
  maxBytes: number | null
  count: number
  totalBytes: number
  paths: string[]
}

export interface ChunkMergeSummary {
  mode: ChunkMergeMode
  entryPointCount: number
  chunkCount: number
  omittedChunkCount: number
  totalBytes: number
  paths: string[]
  sizeBuckets?: ChunkMergeSizeBucket[]
}

const sizeBuckets: Array<{
  label: ChunkMergeSizeBucket['label']
  minBytes: number
  maxBytes: number | null
}> = [
  { label: 'tiny', minBytes: 0, maxBytes: 1023 },
  { label: 'small', minBytes: 1024, maxBytes: 10 * 1024 - 1 },
  { label: 'medium', minBytes: 10 * 1024, maxBytes: 100 * 1024 - 1 },
  { label: 'large', minBytes: 100 * 1024, maxBytes: null },
]

function summarizeSizeBuckets(artifacts: ChunkMergeArtifact[]): ChunkMergeSizeBucket[] {
  return sizeBuckets.map(bucket => {
    const matched = artifacts.filter(artifact => {
      if (artifact.bytes < bucket.minBytes) {
        return false
      }

      if (bucket.maxBytes === null) {
        return true
      }

      return artifact.bytes <= bucket.maxBytes
    })

    return {
      label: bucket.label,
      minBytes: bucket.minBytes,
      maxBytes: bucket.maxBytes,
      count: matched.length,
      totalBytes: matched.reduce((acc, item) => acc + item.bytes, 0),
      paths: matched.map(item => item.path),
    }
  })
}

export function createChunkMergeSummary(
  artifacts: ChunkMergeArtifact[],
  mode: ChunkMergeMode = 'metadata',
): ChunkMergeSummary | null {
  const mergeable = artifacts
    .filter(artifact => artifact.kind === 'entry-point' || artifact.kind === 'chunk')
    .sort((a, b) => a.path.localeCompare(b.path))

  if (mergeable.length === 0) {
    return null
  }

  const entryPoints = mergeable.filter(item => item.kind === 'entry-point')
  const chunks = mergeable.filter(item => item.kind === 'chunk')

  const selected = mode === 'entry-only' ? entryPoints : mergeable

  return {
    mode,
    entryPointCount: entryPoints.length,
    chunkCount: chunks.length,
    omittedChunkCount: mode === 'entry-only' ? chunks.length : 0,
    totalBytes: selected.reduce((acc, item) => acc + item.bytes, 0),
    paths: selected.map(item => item.path),
    sizeBuckets: mode === 'size-buckets' ? summarizeSizeBuckets(mergeable) : undefined,
  }
}