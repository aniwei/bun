import { Buffer, assert, buffer, createNodeHttpModule, events, fs, net, path, querystring, stream, stringDecoder, url, util, zlib } from "@mars/node"
import * as nodeCrypto from "@mars/node"

import type { RuntimeContext } from "./types"

export function createRuntimeNodeCoreModules(context: RuntimeContext): Record<string, unknown> {
  const http = createNodeHttpModule({
    kernel: context.kernel,
    pid: context.pid,
  })

  return {
    assert,
    buffer,
    Buffer,
    events,
    fs,
    http,
    net,
    path,
    querystring,
    stream,
    string_decoder: stringDecoder,
    url,
    util,
    zlib,
    "node:assert": assert,
    "node:buffer": buffer,
    "node:http": http,
    "node:events": events,
    "node:fs": fs,
    "node:net": net,
    "node:path": path,
    "node:querystring": querystring,
    "node:stream": stream,
    "node:string_decoder": stringDecoder,
    "node:url": url,
    "node:util": util,
    "node:zlib": zlib,
    crypto: nodeCrypto,
    "node:crypto": nodeCrypto,
  }
}