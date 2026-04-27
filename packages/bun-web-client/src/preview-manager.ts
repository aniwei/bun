import { Subscription } from '@mars/web-shared'
import type { ContainerEvents, ServerReadyEvent } from './client.types'

type ReadyCallback = (event: ServerReadyEvent) => void
type PreviewManagerEvents = {
  'server-ready': (event: ServerReadyEvent) => void
}

type ServerReadySource = {
  on(event: 'server-ready', listener: ContainerEvents['server-ready']): () => void
}

/**
 * PreviewManager — 管理 iframe 预览面板（RFC §23）
 *
 * 职责：
 * - attach/detach iframe
 * - 监听 'server-ready' 事件并自动更新 iframe src
 * - 支持手动 onServerReady 回调
 */
export class PreviewManager extends Subscription<PreviewManagerEvents> {
  private iframe: HTMLIFrameElement | null = null
  private lastEvent: ServerReadyEvent | null = null

  constructor() {
    super()
  }

  attach(iframe: HTMLIFrameElement): void {
    this.iframe = iframe
    // 若容器已就绪，立即同步 URL
    if (this.lastEvent) {
      this.iframe.src = this.lastEvent.url
    }
  }

  detach(): void {
    this.iframe = null
  }

  /**
   * 注册 server-ready 回调（可多次调用，每次注册一个新监听器）
   */
  onServerReady(callback: ReadyCallback): () => void {
    const unsubscribe = this.subscribe('server-ready', callback)
    // 若已有事件，立即触发
    if (this.lastEvent) {
      try {
        callback(this.lastEvent)
      } catch {}
    }
    return unsubscribe
  }

  bind(source: ServerReadySource): () => void {
    return source.on('server-ready', event => {
      this.handleReady(event)
    })
  }

  /**
   * 由 BunContainer 的 'server-ready' 事件驱动，更新预览 URL。
   * 通常由调用方 `container.on('server-ready', pm.handleReady.bind(pm))` 连接。
   */
  handleReady(event: ServerReadyEvent): void {
    this.lastEvent = event
    if (this.iframe) {
      this.iframe.src = event.url
    }
    this.publish({
      'server-ready': [event],
    })
  }

  getCurrentURL(): string | null {
    return this.lastEvent?.url ?? null
  }
}
