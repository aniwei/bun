import { expect, test } from "bun:test"

import { createMarsRuntime } from "@mars/client"
import { createModuleLoader } from "@mars/loader"
import { createRuntimeNodeCoreModules } from "@mars/runtime"
import {
  loadPlaygroundFiles,
  loadPlaygroundModuleCases,
  readPlaygroundCaseEntry,
} from "../../../playground/src/node-runtime"

import type { MarsRuntime } from "@mars/client"

interface RuntimeVfsShellPlayground {
  readmePath: string
  readmeText: string
  sourceDir: string
  sourcePath: string
  sourceCode: string
  shellScript: string
  grepFile: string
  grepText: string
}

interface BunFilePlayground {
  filePath: string
  payloadText: string
  expectedBytes: number
}

interface BunServePlayground {
  port: number
  requestPath: string
  responsePrefix: string
}

interface GrepJsonResult {
  matches: Array<{ file: string; line: number; text: string }>
}

interface NodeHttpPlaygroundModule {
  createNodeHttpPlaygroundServer(): { listen(port?: number, callback?: () => void): unknown; address(): { port: number } | null; close(): void; on(event: string, listener: () => void): unknown }
  nodeHttpExpectedMethod: string
  nodeHttpHeaderName: string
  nodeHttpHeaderValue: string
  nodeHttpRequestBody: string
  nodeHttpRequestPath: string
}

interface ExpressPlaygroundModule {
  createExpressPlaygroundApp(): { listen(port?: number, callback?: () => void): { close(): void } }
  expressCreatePath: string
  expressRequestBody: string
  expressTraceHeader: string
  expressTraceHeaderValue: string
  expressUsersPath: string
}

interface KoaPlaygroundModule {
  createKoaPlaygroundApp(): { listen(port?: number, callback?: () => void): { close(): void } }
  koaEchoPath: string
  koaProfilePath: string
  koaRequestBody: string
  koaTraceHeader: string
  koaTraceHeaderValue: string
}

async function importServerPlayground<T>(runtime: MarsRuntime): Promise<T> {
  const moduleLoader = createModuleLoader({
    vfs: runtime.vfs,
    coreModules: createRuntimeNodeCoreModules({
      vfs: runtime.vfs,
      kernel: runtime.kernel,
    }),
  })

  return await moduleLoader.import("./server", "/workspace/src/index.ts") as T
}

test("Phase 1 runtime boots and VFS supports base operations", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("vfs-shell"),
    },
  })
  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const playground = await moduleLoader.import(
    "./runtime-vfs-shell",
    "/workspace/src/index.ts",
  ) as RuntimeVfsShellPlayground

  await runtime.vfs.writeFile(playground.readmePath, playground.readmeText)
  await runtime.vfs.mkdir(playground.sourceDir, { recursive: true })
  await runtime.vfs.writeFile(playground.sourcePath, playground.sourceCode)

  expect(await runtime.vfs.readFile("/workspace/README.md", "utf8")).toBe(playground.readmeText)
  expect(await runtime.vfs.readFile(playground.sourcePath, "utf8")).toBe(playground.sourceCode)
  expect(runtime.vfs.statSync(playground.sourceDir).isDirectory()).toBe(true)
  expect(runtime.vfs.readdirSync("/workspace")).toEqual(["README.md", "src"])

  await runtime.dispose()
})

test("Bun.file and Bun.write read and write through MarsVFS", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("bun-file"),
    },
  })
  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const playground = await moduleLoader.import(
    "./bun-file",
    "/workspace/src/index.ts",
  ) as BunFilePlayground

  const written = await runtime.bun.write(playground.filePath, playground.payloadText)
  const file = runtime.bun.file(playground.filePath)

  expect(written).toBe(playground.expectedBytes)
  expect(file.size).toBe(playground.expectedBytes)
  expect(await file.json()).toEqual({ ok: true, phase: 1 })

  await runtime.dispose()
})

test("Bun.serve registers a virtual port and runtime fetch dispatches to it", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("bun-serve"),
    },
  })
  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const playground = await moduleLoader.import(
    "./bun-serve",
    "/workspace/src/index.ts",
  ) as BunServePlayground

  const server = runtime.bun.serve({
    port: playground.port,
    fetch: request => new Response(`${playground.responsePrefix} ${new URL(request.url).pathname}`),
  })

  const response = await runtime.fetch(runtime.preview(playground.port) + playground.requestPath)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("served /hello")
  expect(runtime.kernel.resolvePort(playground.port)).toBe(1)

  server.stop()
  await runtime.dispose()
})

test("node:http compat creates virtual servers for pure Node HTTP, Express and Koa style handlers", async () => {
  const nodeHttpRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("node-http"),
    },
  })
  const nodeHttpPlayground = await importServerPlayground<NodeHttpPlaygroundModule>(nodeHttpRuntime)
  const nodeHttpServer = nodeHttpPlayground.createNodeHttpPlaygroundServer()
  let requestEvents = 0
  let listeningEvents = 0
  let closeEvents = 0
  let listenCallbackCalled = false
  nodeHttpServer.on("request", () => {
    requestEvents += 1
  })
  nodeHttpServer.on("listening", () => {
    listeningEvents += 1
  })
  nodeHttpServer.on("close", () => {
    closeEvents += 1
  })
  nodeHttpServer.listen(0, () => {
    listenCallbackCalled = true
  })
  const nodeHttpAddress = nodeHttpServer.address()
  expect((nodeHttpAddress?.port ?? 0) > 0).toBe(true)
  expect(listenCallbackCalled).toBe(true)
  expect(listeningEvents).toBe(1)

  const nodeHttpResponse = await nodeHttpRuntime.fetch(`${nodeHttpRuntime.preview(nodeHttpAddress?.port ?? 0)}${nodeHttpPlayground.nodeHttpRequestPath.slice(1)}`, {
    method: nodeHttpPlayground.nodeHttpExpectedMethod,
    headers: {
      [nodeHttpPlayground.nodeHttpHeaderName]: nodeHttpPlayground.nodeHttpHeaderValue,
    },
    body: nodeHttpPlayground.nodeHttpRequestBody,
  })
  expect(nodeHttpResponse.status).toBe(201)
  expect(nodeHttpResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(nodeHttpResponse.headers.get("x-mars-handler")).toBe("node-http")
  expect(await nodeHttpResponse.json()).toEqual({
    method: nodeHttpPlayground.nodeHttpExpectedMethod,
    url: nodeHttpPlayground.nodeHttpRequestPath,
    header: nodeHttpPlayground.nodeHttpHeaderValue,
    body: nodeHttpPlayground.nodeHttpRequestBody,
  })
  expect(requestEvents).toBe(1)

  nodeHttpServer.close()
  expect(closeEvents).toBe(1)
  expect(nodeHttpRuntime.kernel.resolvePort(nodeHttpAddress?.port ?? 0)).toBe(null)
  await nodeHttpRuntime.dispose()

  const expressRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("express"),
    },
  })
  const expressPlayground = await importServerPlayground<ExpressPlaygroundModule>(expressRuntime)
  const expressApp = expressPlayground.createExpressPlaygroundApp()
  const expressServer = expressApp.listen(3001)

  const expressResponse = await expressRuntime.fetch(expressRuntime.preview(3001) + expressPlayground.expressUsersPath.slice(1))
  expect(expressResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(expressResponse.headers.get(expressPlayground.expressTraceHeader)).toBe(expressPlayground.expressTraceHeaderValue)
  expect(await expressResponse.json()).toEqual({
    framework: "express",
    route: "users.index",
    method: "GET",
    active: "1",
    middleware: expressPlayground.expressTraceHeaderValue,
  })

  const expressCreateResponse = await expressRuntime.fetch(expressRuntime.preview(3001) + expressPlayground.expressCreatePath.slice(1), {
    method: "POST",
    body: expressPlayground.expressRequestBody,
  })
  expect(expressCreateResponse.status).toBe(201)
  expect(expressCreateResponse.headers.get(expressPlayground.expressTraceHeader)).toBe(expressPlayground.expressTraceHeaderValue)
  expect(await expressCreateResponse.json()).toEqual({
    framework: "express",
    route: "users.create",
    method: "POST",
    body: { name: "Ada", role: "admin" },
  })

  expressServer.close()
  expect(expressRuntime.kernel.resolvePort(3001)).toBe(null)
  await expressRuntime.dispose()

  const koaRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("koa"),
    },
  })
  const koaPlayground = await importServerPlayground<KoaPlaygroundModule>(koaRuntime)
  const koaApp = koaPlayground.createKoaPlaygroundApp()
  const koaServer = koaApp.listen(3002)

  const koaResponse = await koaRuntime.fetch(koaRuntime.preview(3002) + koaPlayground.koaProfilePath.slice(1))
  expect(koaResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(koaResponse.headers.get(koaPlayground.koaTraceHeader)).toBe(koaPlayground.koaTraceHeaderValue)
  expect(koaResponse.headers.get("x-mars-koa-after")).toBe("returned")
  expect(await koaResponse.json()).toEqual({
    framework: "koa",
    route: "profile.show",
    name: "mars",
    middleware: koaPlayground.koaTraceHeaderValue,
  })

  const koaEchoResponse = await koaRuntime.fetch(koaRuntime.preview(3002) + koaPlayground.koaEchoPath.slice(1), {
    method: "POST",
    body: koaPlayground.koaRequestBody,
  })
  expect(koaEchoResponse.status).toBe(202)
  expect(koaEchoResponse.headers.get(koaPlayground.koaTraceHeader)).toBe(koaPlayground.koaTraceHeaderValue)
  expect(koaEchoResponse.headers.get("x-mars-koa-after")).toBe("returned")
  expect(await koaEchoResponse.json()).toEqual({
    framework: "koa",
    route: "echo.create",
    body: koaPlayground.koaRequestBody,
  })

  koaServer.close()
  expect(koaRuntime.kernel.resolvePort(3002)).toBe(null)
  await koaRuntime.dispose()
})

test("MarsShell runs base filesystem commands and structured grep", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("vfs-shell"),
    },
  })
  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const playground = await moduleLoader.import(
    "./runtime-vfs-shell",
    "/workspace/src/index.ts",
  ) as RuntimeVfsShellPlayground

  await runtime.vfs.writeFile(playground.readmePath, playground.readmeText)
  await runtime.vfs.writeFile("/workspace/notes.txt", `alpha\nbeta\n${playground.readmeText}\n`)

  const result = await runtime.shell.run(playground.shellScript)
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("/workspace")
  expect(result.stdout).toContain(playground.readmePath)
  expect(result.stdout).toContain(playground.readmeText)

  await runtime.shell.run("mkdir -p tmp && cd tmp")
  expect(runtime.shell.cwd()).toBe("/workspace/tmp")
  await runtime.vfs.writeFile(playground.sourcePath, playground.sourceCode)
  expect(await runtime.vfs.readFile("/workspace/src/app.ts", "utf8")).toBe(playground.sourceCode)
  expect(runtime.vfs.existsSync("/workspace/tmp/src/app.ts")).toBe(false)

  await runtime.vfs.writeFile(playground.grepFile, playground.grepText)
  const grepResult = await runtime.shell.run("grep -R hello /workspace")

  expect(grepResult.code).toBe(0)
  expect(grepResult.stdout).toContain(`${playground.grepFile}:1:${playground.grepText}`)
  const grepJson = grepResult.json as GrepJsonResult
  expect(grepJson.matches.some(match => {
    return match.file === "/workspace/notes.txt" && match.line === 3 && match.text === playground.readmeText
  })).toBe(true)
  expect(grepJson.matches.some(match => {
    return match.file === playground.grepFile && match.line === 1 && match.text === playground.grepText
  })).toBe(true)

  await runtime.shell.run(`rm ${playground.grepFile}`)
  expect(runtime.vfs.existsSync(playground.grepFile)).toBe(false)

  await runtime.dispose()
})

test("Phase 1 playground module cases reference real files", async () => {
  const cases = await loadPlaygroundModuleCases()
  const phase1Cases = cases.filter(playgroundCase => playgroundCase.phase === "Phase 1")

  expect(phase1Cases.map(playgroundCase => playgroundCase.id)).toEqual([
    "vfs-shell",
    "bun-file",
    "bun-serve",
    "phase1-node-http-core",
    "phase1-node-http-express",
    "phase1-node-http-koa",
  ])

  for (const playgroundCase of phase1Cases) {
    const source = await readPlaygroundCaseEntry(playgroundCase.entry)
    expect(source.length > 0).toBe(true)
  }
})