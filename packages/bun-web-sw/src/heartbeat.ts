export type HeartbeatFn = () => Promise<boolean> | boolean

export class ServiceWorkerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private failures = 0

  constructor(
    private readonly heartbeat: HeartbeatFn,
    private readonly intervalMs = 3000,
    private readonly maxFailures = 2,
  ) {}

  start(): void {
    if (this.timer) return

    this.timer = setInterval(async () => {
      await this.tick()
    }, this.intervalMs)
  }

  async tick(): Promise<void> {
    try {
      const ok = await this.heartbeat()
      if (ok) {
        this.failures = 0
        return
      }
      this.failures += 1
    } catch {
      this.failures += 1
    }
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  needsRecovery(): boolean {
    return this.failures > this.maxFailures
  }
}
