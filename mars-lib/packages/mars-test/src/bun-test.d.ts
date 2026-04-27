declare module "bun:test" {
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void
  export const expect: (value: unknown) => {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
  }
}

declare const Bun: {
  file(path: string | URL): {
    text(): Promise<string>
  }
}