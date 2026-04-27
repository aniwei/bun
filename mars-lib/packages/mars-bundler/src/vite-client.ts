export function createViteClientModule(): string {
  return [
    "const listeners = new Set()",
    "export const hot = {",
    "  accept(callback) { if (callback) listeners.add(callback) },",
    "  dispose() {},",
    "  invalidate() {},",
    "}",
    "export function __mars_dispatch_update(payload) {",
    "  for (const listener of listeners) listener(payload)",
    "}",
    "export default { hot }",
    "",
  ].join("\n")
}