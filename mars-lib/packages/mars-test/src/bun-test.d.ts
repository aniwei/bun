declare module "bun:test" {
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void

  interface Matchers {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toBeNull(): void
    toBeDefined(): void
    toBeTruthy(): void
    toBeFalsy(): void
    not: Matchers
  }

  export const expect: (value: unknown) => Matchers
}

declare const Bun: {
  file(path: string | URL): {
    text(): Promise<string>
  }
}