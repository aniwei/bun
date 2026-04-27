import { serializeError } from "./protocol"

import type {
  BridgeRequestOptions,
  Disposable,
  MarsBridgeEndpoint,
  MarsMessage,
  MarsMessageSource,
  MarsMessageTarget,
  MarsResponse,
} from "./protocol"

export interface MarsBridgeTransport {
  postMessage(message: MarsMessage | MarsResponse, transfer?: Transferable[]): void
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MarsMessage | MarsResponse>) => void,
  ): void
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<MarsMessage | MarsResponse>) => void,
  ): void
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
  abortListener?: () => void
}

export interface MarsBridgeEndpointOptions {
  source: MarsMessageSource
  target: MarsMessageTarget
  transport: MarsBridgeTransport
  timeoutMs?: number
  idFactory?: () => string
}

export class DefaultMarsBridgeEndpoint implements MarsBridgeEndpoint {
  readonly #source: MarsMessageSource
  readonly #target: MarsMessageTarget
  readonly #transport: MarsBridgeTransport
  readonly #timeoutMs: number
  readonly #idFactory: () => string
  readonly #pending = new Map<string, PendingRequest>()
  readonly #listeners = new Map<string, Set<(payload: unknown, message: MarsMessage) => void>>()
  readonly #handleMessage = (event: MessageEvent<MarsMessage | MarsResponse>) => {
    const message = event.data

    if ("ok" in message) {
      this.#handleResponse(message)
      return
    }

    this.#handleRequest(message)
  }

  constructor(options: MarsBridgeEndpointOptions) {
    this.#source = options.source
    this.#target = options.target
    this.#transport = options.transport
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#idFactory = options.idFactory ?? createMessageId

    this.#transport.addEventListener("message", this.#handleMessage)
  }

  request<TReq, TRes>(
    type: string,
    payload: TReq,
    options: BridgeRequestOptions = {},
  ): Promise<TRes> {
    const id = this.#idFactory()
    const message: MarsMessage<TReq> = {
      id,
      type,
      source: this.#source,
      target: options.target ?? this.#target,
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
      payload,
    }

    return new Promise<TRes>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#timeoutMs
      const pending: PendingRequest = {
        resolve: value => resolve(value as TRes),
        reject,
      }

      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`MarsBridge request timed out: ${type}`))
        }, timeoutMs)
      }

      if (options.signal) {
        if (options.signal.aborted) {
          reject(options.signal.reason ?? new Error("MarsBridge request aborted"))
          return
        }

        pending.abortListener = () => {
          this.#pending.delete(id)
          reject(options.signal?.reason ?? new Error("MarsBridge request aborted"))
        }

        options.signal.addEventListener("abort", pending.abortListener, { once: true })
      }

      this.#pending.set(id, pending)
      this.#transport.postMessage(message, options.transfer)
    })
  }

  notify<T>(type: string, payload: T): void {
    this.#transport.postMessage({
      id: this.#idFactory(),
      type,
      source: this.#source,
      target: this.#target,
      payload,
    })
  }

  on<T>(
    type: string,
    listener: (payload: T, message: MarsMessage<T>) => void,
  ): Disposable {
    const listeners = this.#listeners.get(type) ?? new Set()
    const wrapped = listener as (payload: unknown, message: MarsMessage) => void

    listeners.add(wrapped)
    this.#listeners.set(type, listeners)

    return {
      dispose: () => {
        listeners.delete(wrapped)
      },
    }
  }

  close(): void {
    this.#transport.removeEventListener("message", this.#handleMessage)

    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error("MarsBridge endpoint closed"))
    }

    this.#pending.clear()
    this.#listeners.clear()
  }

  #handleResponse(response: MarsResponse): void {
    const pending = this.#pending.get(response.id)
    if (!pending) return

    this.#pending.delete(response.id)
    if (pending.timer) clearTimeout(pending.timer)

    if (response.ok) {
      pending.resolve(response.payload)
      return
    }

    pending.reject(response.error ?? new Error("MarsBridge request failed"))
  }

  #handleRequest(message: MarsMessage): void {
    const listeners = this.#listeners.get(message.type)
    if (!listeners?.size) return

    for (const listener of listeners) {
      try {
        listener(message.payload, message)
      } catch (error) {
        this.#transport.postMessage({
          id: message.id,
          ok: false,
          error: serializeError(error),
        })
      }
    }
  }
}

export function createMarsBridgeEndpoint(
  options: MarsBridgeEndpointOptions,
): MarsBridgeEndpoint {
  return new DefaultMarsBridgeEndpoint(options)
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `mars-${Date.now()}-${Math.random().toString(16).slice(2)}`
}