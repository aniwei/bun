import type { Kernel } from './kernel'
import type {
  KernelModuleRequest,
  KernelModuleResponse,
} from './kernel.types'
import type {
  KernelModuleRequestMessage,
  KernelModuleRequestProtocolHandler,
  KernelModuleResponseMessage,
} from './service-worker-controller'

function normalizeHeaders(headers: KernelModuleResponse['headers']): Array<[string, string]> {
  if (!Array.isArray(headers)) {
    return []
  }

  return headers.filter(
    (entry): entry is [string, string] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string',
  )
}

function toModuleResponseMessage(response: KernelModuleResponse): KernelModuleResponseMessage {
  return {
    type: 'MODULE_RESPONSE',
    requestId: response.requestId,
    status: response.status,
    headers: normalizeHeaders(response.headers),
    contentType: response.contentType,
    buffer: response.buffer,
    error: response.error,
  }
}

function toModuleRequest(payload: KernelModuleRequestMessage): KernelModuleRequest {
  return {
    requestId: payload.requestId,
    pathname: payload.pathname,
    method: payload.method,
    headers: payload.headers,
  }
}

export function createKernelModuleRequestProtocolHandler(kernel: Kernel): KernelModuleRequestProtocolHandler {
  return async request => {
    try {
      const response = await kernel.handleModuleRequest(toModuleRequest(request))
      return toModuleResponseMessage(response)
    } catch (error) {
      return {
        type: 'MODULE_RESPONSE',
        requestId: request.requestId,
        status: 500,
        headers: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
