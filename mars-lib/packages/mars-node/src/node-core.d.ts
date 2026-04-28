declare module "node:http" {
  import type {
    IncomingMessage as MarsIncomingMessage,
    NodeHttpServer,
    ServerResponse as MarsServerResponse,
  } from "@mars/node"

  export type IncomingMessage = MarsIncomingMessage
  export type ServerResponse = MarsServerResponse
  export type Server = NodeHttpServer
  export type RequestListener = (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>

  export function createServer(listener: RequestListener): Server
}

declare module "http" {
  export * from "node:http"
}

declare module "node:crypto" {
  export {
    MarsNodeHash,
    MarsNodeHmac,
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    createSign,
    createVerify,
    getCiphers,
    getCurves,
    getHashes,
    hkdf,
    hkdfAsync,
    hkdfSync,
    pbkdf2,
    pbkdf2Async,
    pbkdf2Sync,
    randomBytes,
    randomUUID,
    scrypt,
    scryptSync,
    timingSafeEqual,
  } from "@mars/node"
}

declare module "crypto" {
  export * from "node:crypto"
}