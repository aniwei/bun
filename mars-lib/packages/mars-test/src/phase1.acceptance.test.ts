import { expect, test } from "bun:test"

import { createMarsRuntime } from "@mars/client"
import { createModuleLoader } from "@mars/loader"
import { createExpressHelloWorldServer } from "../../../playground/express/server"
import { createKoaHelloWorldServer } from "../../../playground/koa/server"
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

test("node:http compat creates a virtual server for Express and Koa style handlers", async () => {
  const expressRuntime = await createMarsRuntime()
  const expressServer = createExpressHelloWorldServer(expressRuntime.kernel)

  expressServer.listen(3001)

  const expressResponse = await expressRuntime.fetch(expressRuntime.preview(3001) + "users")
  expect(expressResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(await expressResponse.json()).toEqual({ framework: "express", method: "GET", url: "/users" })

  expressServer.close()
  await expressRuntime.dispose()

  const koaRuntime = await createMarsRuntime()
  const koaServer = createKoaHelloWorldServer(koaRuntime.kernel)

  koaServer.listen(3002)

  const koaResponse = await koaRuntime.fetch(koaRuntime.preview(3002))
  expect(koaResponse.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(await koaResponse.json()).toEqual({ framework: "koa", body: "hello mars" })

  koaServer.close()
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
    "phase1-node-http-express",
    "phase1-node-http-koa",
  ])

  for (const playgroundCase of phase1Cases) {
    const source = await readPlaygroundCaseEntry(playgroundCase.entry)
    expect(source.length > 0).toBe(true)
  }
})