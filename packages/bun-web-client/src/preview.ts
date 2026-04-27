export interface ServerReadyPayload {
  host: string
  port: number
  protocol?: 'http' | 'https'
}

export class PreviewController {
  private iframe: HTMLIFrameElement | null = null
  private currentURL: string | null = null

  bind(iframe: HTMLIFrameElement): void {
    this.iframe = iframe
    if (this.currentURL) {
      this.iframe.src = this.currentURL
    }
  }

  updateFromServerReady(payload: ServerReadyPayload): string {
    const protocol = payload.protocol ?? 'http'
    const next = `${protocol}://${payload.host}:${payload.port}`
    this.currentURL = next
    if (this.iframe) {
      this.iframe.src = next
    }
    return next
  }

  getCurrentURL(): string | null {
    return this.currentURL
  }
}
