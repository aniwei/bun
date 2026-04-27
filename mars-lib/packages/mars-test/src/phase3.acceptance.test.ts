import { expect, test } from "bun:test"

import { buildProject } from "@mars/bundler"
import { createMarsRuntime } from "@mars/client"
import { getBunApiCompat } from "@mars/runtime"
import {
  loadPlaygroundFiles,
  loadPlaygroundModuleCases,
  readPlaygroundCaseEntry,
} from "../../../playground/src/node-runtime"

test("Phase 3 Bun.build writes transformed output to MarsVFS", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "app.ts": "export const label: string = __MARS_LABEL__",
      },
    },
  })

  const result = await buildProject({
    vfs: runtime.vfs,
    entrypoints: ["src/app.ts"],
    outdir: "dist",
    define: {
      __MARS_LABEL__: '"phase3"',
    },
  })

  expect(result.success).toBe(true)
  expect(result.outputs.map(output => output.path)).toEqual(["/workspace/dist/app.js"])
  expect(await result.outputs[0].text()).toContain('"phase3"')
  expect(await runtime.vfs.readFile("/workspace/dist/app.js", "utf8")).toContain('"phase3"')

  await runtime.dispose()
})

test("Phase 3 runtime Bun.build facade builds TSX entry", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "main.tsx": "export const view = <main>{'runtime build'}</main>",
      },
    },
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/main.tsx"],
    outfile: "build/main.js",
    format: "iife",
  })
  const output = String(await runtime.vfs.readFile("/workspace/build/main.js", "utf8"))

  expect(result.success).toBe(true)
  expect(result.outputs[0].path).toBe("/workspace/build/main.js")
  expect(output).toContain("(function(){")
  expect(output).toContain("__mars_jsx")
  expect(output).toContain("runtime build")

  await runtime.dispose()
})

test("Phase 3 compatibility matrix tracks Bun.build", () => {
  expect(getBunApiCompat("Bun.build")).toEqual({
    api: "Bun.build",
    status: "partial",
    phase: "M3",
    notes: "Single or multi-entry transpile output can be written to MarsVFS; full dependency bundling and splitting are pending.",
    tests: ["Phase 3 Bun.build writes transformed output to MarsVFS"],
  })
})

test("Phase 3 Bun.build can build vite playground entry", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("vite-react-ts"),
  })

  const result = await runtime.bun.build({
    entrypoints: ["src/App.tsx"],
    outfile: "dist/playground-app.js",
  })
  const output = String(await runtime.vfs.readFile("dist/playground-app.js", "utf8"))

  expect(result.success).toBe(true)
  expect(result.outputs[0].path).toBe("/workspace/dist/playground-app.js")
  expect(output).toContain("Mars Vite React TS")
  expect(output).toContain("__mars_jsx")

  await runtime.dispose()
})

test("Phase 3 playground module cases include Bun.build prework", async () => {
  const cases = await loadPlaygroundModuleCases()
  const buildCase = cases.find(playgroundCase => playgroundCase.id === "phase3-bun-build-vite-entry")

  expect(buildCase?.status).toBe("prework")
  expect(buildCase?.module).toBe("bun-build")
  expect(await readPlaygroundCaseEntry(buildCase?.entry ?? "")).toContain("Mars Vite React TS")
})