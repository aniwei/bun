export type SecureContext = {
  options: Record<string, unknown>
}

export function createSecureContext(options: Record<string, unknown> = {}): SecureContext {
  return { options }
}
