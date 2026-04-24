export class OPFSAdapter {
  private readonly store = new Map<string, Uint8Array>()

  static async open(): Promise<OPFSAdapter> {
    return new OPFSAdapter()
  }

  readSync(path: string): Uint8Array {
    const found = this.store.get(path)
    if (!found) {
      throw new Error(`File not found: ${path}`)
    }

    return found
  }

  writeSync(path: string, data: Uint8Array): void {
    this.store.set(path, data)
  }

  unlinkSync(path: string): void {
    this.store.delete(path)
  }

  readdirSync(path: string): string[] {
    const prefix = path.endsWith('/') ? path : path + '/'
    const output: string[] = []
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        output.push(key.slice(prefix.length))
      }
    }
    return output
  }

  mkdirSync(path: string): void {
    void path
  }
}
