declare module 'harness' {
  export const bunEnv: Record<string, string>

  export type DisposableTempDir = {
    toString(): string
    [Symbol.dispose](): void
  }

  export function tempDir(prefix: string, files?: Record<string, string>): DisposableTempDir
}