import { expect, test } from "bun:test"

import { createMarsRuntime } from "@mars/client"
import { createModuleLoader } from "@mars/loader"
import {
  createExpressPlaygroundApp,
  expressCreatePath,
  expressRequestBody,
  expressTraceHeader,
  expressTraceHeaderValue,
  expressUsersPath,
} from "../../../playground/express/server"
import {
  createKoaPlaygroundApp,
  koaEchoPath,
  koaProfilePath,
  koaRequestBody,
  koaTraceHeader,
  koaTraceHeaderValue,
} from "../../../playground/koa/server"
import {
  createNodeHttpPlaygroundServer,
  nodeHttpExpectedMethod,
  nodeHttpHeaderName,
  nodeHttpHeaderValue,
  nodeHttpRequestBody,
  nodeHttpRequestPath,
} from "../../../playground/node-http/server"
import {
  loadPlaygroundFiles,
  loadPlaygroundModuleCases,
  readPlaygroundCaseEntry,
} from "../../../playground/src/node-runtime"

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
  const nodeHttpRuntime = await createMarsRuntime()
  const nodeHttpServer = createNodeHttpPlaygroundServer(nodeHttpRuntime.kernel)
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

  const nodeHttpResponse = await nodeHttpRuntime.fetch(`${nodeHttpRuntime.preview(nodeHttpAddress?.port ?? 0)}${nodeHttpRequestPath.slice(1)}`, {
    method: nodeHttpExpectedMethod,
    headers: {
      [nodeHttpHeaderName]: nodeHttpHeaderValue,
    },
    body: nodeHttpRequestBody,
  })
  expect(nodeHttpResponse.status).toBe(201)
  expect(nodeHttpResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(nodeHttpResponse.headers.get("x-mars-handler")).toBe("node-http")
  expect(await nodeHttpResponse.json()).toEqual({
    method: nodeHttpExpectedMethod,
    url: nodeHttpRequestPath,
    header: nodeHttpHeaderValue,
    body: nodeHttpRequestBody,
  })
  expect(requestEvents).toBe(1)

  nodeHttpServer.close()
  expect(closeEvents).toBe(1)
  expect(nodeHttpRuntime.kernel.resolvePort(nodeHttpAddress?.port ?? 0)).toBe(null)
  await nodeHttpRuntime.dispose()

  const expressRuntime = await createMarsRuntime()
  const expressApp = createExpressPlaygroundApp(expressRuntime.kernel)
  const expressServer = expressApp.listen(3001)

  const expressResponse = await expressRuntime.fetch(expressRuntime.preview(3001) + expressUsersPath.slice(1))
  expect(expressResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(expressResponse.headers.get(expressTraceHeader)).toBe(expressTraceHeaderValue)
  expect(await expressResponse.json()).toEqual({
    framework: "express",
    route: "users.index",
    method: "GET",
    active: "1",
    middleware: expressTraceHeaderValue,
  })

  const expressCreateResponse = await expressRuntime.fetch(expressRuntime.preview(3001) + expressCreatePath.slice(1), {
    method: "POST",
    body: expressRequestBody,
  })
  expect(expressCreateResponse.status).toBe(201)
  expect(expressCreateResponse.headers.get(expressTraceHeader)).toBe(expressTraceHeaderValue)
  expect(await expressCreateResponse.json()).toEqual({
    framework: "express",
    route: "users.create",
    method: "POST",
    body: { name: "Ada", role: "admin" },
  })

  expressServer.close()
  expect(expressRuntime.kernel.resolvePort(3001)).toBe(null)
  await expressRuntime.dispose()

  const koaRuntime = await createMarsRuntime()
  const koaApp = createKoaPlaygroundApp(koaRuntime.kernel)
  const koaServer = koaApp.listen(3002)

  const koaResponse = await koaRuntime.fetch(koaRuntime.preview(3002) + koaProfilePath.slice(1))
  expect(koaResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(koaResponse.headers.get(koaTraceHeader)).toBe(koaTraceHeaderValue)
  expect(koaResponse.headers.get("x-mars-koa-after")).toBe("returned")
  expect(await koaResponse.json()).toEqual({
    framework: "koa",
    route: "profile.show",
    name: "mars",
    middleware: koaTraceHeaderValue,
  })

  const koaEchoResponse = await koaRuntime.fetch(koaRuntime.preview(3002) + koaEchoPath.slice(1), {
    method: "POST",
    body: koaRequestBody,
  })
  expect(koaEchoResponse.status).toBe(202)
  expect(koaEchoResponse.headers.get(koaTraceHeader)).toBe(koaTraceHeaderValue)
  expect(koaEchoResponse.headers.get("x-mars-koa-after")).toBe("returned")
  expect(await koaEchoResponse.json()).toEqual({
    framework: "koa",
    route: "echo.create",
    body: koaRequestBody,
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