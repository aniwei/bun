declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: unknown
  }
}

declare const __MARS_LABEL__: string

declare const Bun: {
  file(path: string | URL): {
    text(): Promise<string>
  }
}

declare function require(specifier: string): Record<string, string | number>

declare module "react" {
  export function useMemo<T>(factory: () => T, deps: unknown[]): T
  export function useState<T>(initialValue: T): [T, (nextValue: T | ((currentValue: T) => T)) => void]
}

declare module "react-dom/client" {
  export function createRoot(container: Element | DocumentFragment): {
    render(node: unknown): void
  }
}

declare module "react/jsx-runtime" {
  export const Fragment: symbol
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
}

declare module "*.css" {
  const stylesheet: string
  export default stylesheet
}

declare module "*?raw" {
  const source: string
  export default source
}