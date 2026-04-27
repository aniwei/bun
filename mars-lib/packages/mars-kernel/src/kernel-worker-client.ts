import { createMarsBridgeEndpoint, createMarsPostMessageBridgeTransport } from "@mars/bridge"

import type { MarsBridgeEndpoint, MarsMessage } from "@mars/bridge"
import type { WorkerConstructor, WorkerLike } from "./process-worker-factory"

export interface KernelWorkerClientOptions {
  scope?: typeof globalThis
  workerURL: string | URL
  workerOptions?: WorkerOptions
  workerConstructor?: WorkerConstructor
  createMessageChannel?: () => MessageChannel
}

export interface KernelWorkerClient {
  readonly workerURL: string | URL
  readonly worker: WorkerLike
  readonly endpoint: MarsBridgeEndpoint
  readonly channel: MessageChannel
  readonly connected: boolean
  close(): void
}

interface WorkerConstructorScope {
  Worker?: WorkerConstructor
}

export function supportsKernelWorkerClient(options: Omit<KernelWorkerClientOptions, "workerURL"> = {}): boolean {
  const scope = options.scope ?? globalThis
  const workerConstructor = options.workerConstructor ?? (scope as WorkerConstructorScope).Worker

  return typeof workerConstructor === "function"
}

export function connectMarsKernelWorker(
  options: KernelWorkerClientOptions,
): KernelWorkerClient {
  const scope = options.scope ?? globalThis
  const workerConstructor = options.workerConstructor ?? (scope as WorkerConstructorScope).Worker
  if (!workerConstructor) throw new Error("Worker is not available in this browser profile")

  const worker = new workerConstructor(options.workerURL, options.workerOptions)
  const channel = options.createMessageChannel?.() ?? new MessageChannel()
  const endpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "kernel",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const message = createKernelConnectMessage(options.workerURL)

  worker.postMessage(message, [channel.port2])

  return {
    workerURL: options.workerURL,
    worker,
    endpoint,
    channel,
    connected: true,
    close: () => {
      endpoint.close()
      channel.port1.close()
      channel.port2.close()
      worker.terminate()
    },
  }
}

function createKernelConnectMessage(workerURL: string | URL): MarsMessage<{ workerURL: string }> {
  return {
    id: `mars-kernel-connect-${Date.now()}`,
    type: "kernel.connect",
    source: "client",
    target: "kernel",
    payload: {
      workerURL: String(workerURL),
    },
  }
}
