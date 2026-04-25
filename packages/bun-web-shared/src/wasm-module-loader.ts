export type WasmModuleFactory<TModule> = () => Promise<TModule | null>

export class WasmModuleLoader<TModule> {
  private readonly defaultFactory: WasmModuleFactory<TModule>
  private currentFactory: WasmModuleFactory<TModule>
  private loadedModule: TModule | null = null
  private loadingModule: Promise<TModule | null> | null = null

  constructor(factory: WasmModuleFactory<TModule>) {
    this.defaultFactory = factory
    this.currentFactory = factory
  }

  async load(): Promise<TModule | null> {
    if (this.loadedModule) {
      return this.loadedModule
    }

    if (this.loadingModule) {
      return this.loadingModule
    }

    this.loadingModule = this.currentFactory()
    const loaded = await this.loadingModule
    this.loadingModule = null
    this.loadedModule = loaded
    return loaded
  }

  getLoaded(): TModule | null {
    return this.loadedModule
  }

  setFactory(factory: WasmModuleFactory<TModule>): void {
    this.currentFactory = factory
    this.clear()
  }

  resetFactory(): void {
    this.currentFactory = this.defaultFactory
    this.clear()
  }

  clear(): void {
    try {
      const maybeStoppable = this.loadedModule as unknown as { stop?: () => void } | null
      maybeStoppable?.stop?.()
    } catch {
      // Ignore best-effort cleanup errors.
    }

    this.loadedModule = null
    this.loadingModule = null
  }
}