import { expect, test } from "bun:test"

import { createMarsDevServer } from "@mars/bundler"
import { createMarsRuntime } from "@mars/client"
import { createMarsInstaller, createMemoryPackageCache, createNpmRegistryClient } from "@mars/installer"
import { createModuleLoader } from "@mars/loader"
import { resolve } from "@mars/resolver"
import { createWasmLoader } from "@mars/shared"
import { createTranspiler } from "@mars/transpiler"
import {
  loadPlaygroundFiles,
  loadPlaygroundModuleCases,
  loadPlaygroundPackageCache,
  readPlaygroundCaseEntry,
  readPlaygroundText,
} from "../../../playground/src/node-runtime"

interface ResolverPlaygroundManifest {
  importer: string
  files: Record<string, string>
  expected: Record<string, string | null>
}

function evaluateTransformedModule(
  code: string,
  require: (specifier: string) => unknown = () => ({}),
  dynamicImport: (specifier: string) => Promise<unknown> = async () => ({}),
): Record<string, unknown> {
  const exportsObject: Record<string, unknown> = {}
  const evaluator = new Function(
    "exports",
    "module",
    "require",
    "__mars_dynamic_import",
    `${code}\nreturn exports`,
  )

  evaluator(exportsObject, { exports: exportsObject }, require, dynamicImport)

  return exportsObject
}

test("Phase 2 resolver resolves relative modules with extensions", () => {
  const files = new Map<string, string>([
    ["/workspace/src/index.ts", "import './feature'"],
    ["/workspace/src/feature.ts", "export const value = 1"],
    ["/workspace/src/module.mjs", "export const value = 'esm'"],
    ["/workspace/src/legacy.cjs", "module.exports = 'cjs'"],
  ])
  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  const resolvedPath = resolve("./feature", "/workspace/src/index.ts", {
    fileSystem,
  })

  expect(resolvedPath).toBe("/workspace/src/feature.ts")
  expect(resolve("./module", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/module.mjs",
  )
  expect(resolve("./legacy", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/legacy.cjs",
  )
})

test("Phase 2 resolver honors package exports and imports", () => {
  const files = new Map<string, string>([
    [
      "/workspace/package.json",
      JSON.stringify({ imports: { "#shared": "./src/shared.ts", "#blocked": null, "#conditional-blocked": { browser: null, default: "./src/shared.ts" }, "#fallback": [{ node: "./src/node.ts" }, "./src/shared.ts"], "#external": "demo", "#external-feature": "browser-demo/feature", "#external-fallback": [{ node: "node-only" }, "browser-demo/array"] } }),
    ],
    ["/workspace/src/index.ts", "import '#shared'"],
    ["/workspace/src/shared.ts", "export const shared = true"],
    [
      "/workspace/node_modules/demo/package.json",
      JSON.stringify({ exports: { ".": { browser: "./browser.ts", default: "./index.ts" } } }),
    ],
    ["/workspace/node_modules/demo/browser.ts", "export const target = 'browser'"],
    ["/workspace/node_modules/demo/index.ts", "export const target = 'default'"],
    ["/workspace/node_modules/demo/private.ts", "export const hidden = true"],
    [
      "/workspace/node_modules/browser-demo/package.json",
      JSON.stringify({ exports: { "./feature": { browser: "./feature.browser.ts", default: "./feature.node.ts" }, "./array": [{ node: "./array.node.ts" }, { browser: "./array.browser.ts" }, "./array.default.ts"], "./esm": "./esm", "./cjs": "./legacy" } }),
    ],
    ["/workspace/node_modules/browser-demo/feature.browser.ts", "export const target = 'browser-feature'"],
    ["/workspace/node_modules/browser-demo/feature.node.ts", "export const target = 'node-feature'"],
    ["/workspace/node_modules/browser-demo/array.browser.ts", "export const target = 'browser-array'"],
    ["/workspace/node_modules/browser-demo/array.node.ts", "export const target = 'node-array'"],
    ["/workspace/node_modules/browser-demo/array.default.ts", "export const target = 'default-array'"],
    ["/workspace/node_modules/browser-demo/esm.mjs", "export const target = 'esm'"],
    ["/workspace/node_modules/browser-demo/legacy.cjs", "module.exports = 'cjs'"],
    [
      "/workspace/node_modules/array-root-demo/package.json",
      JSON.stringify({ exports: [{ node: "./node.ts" }, { browser: "./browser.ts" }, "./index.ts"] }),
    ],
    ["/workspace/node_modules/array-root-demo/browser.ts", "export const target = 'browser-array-root'"],
    ["/workspace/node_modules/array-root-demo/index.ts", "export const target = 'default-array-root'"],
    [
      "/workspace/node_modules/conditional-demo/package.json",
      JSON.stringify({ exports: { browser: "./browser.ts", default: "./index.ts" } }),
    ],
    ["/workspace/node_modules/conditional-demo/browser.ts", "export const target = 'browser'"],
    ["/workspace/node_modules/conditional-demo/index.ts", "export const target = 'default'"],
    [
      "/workspace/node_modules/null-target-demo/package.json",
      JSON.stringify({
        exports: {
          "./features/*": "./features/*.ts",
          "./features/private": null,
          "./conditional-blocked": { browser: null, default: "./features/public.ts" },
        },
      }),
    ],
    ["/workspace/node_modules/null-target-demo/features/public.ts", "export const target = 'public'"],
    ["/workspace/node_modules/null-target-demo/features/private.ts", "export const target = 'private'"],
    [
      "/workspace/packages/self-demo/package.json",
      JSON.stringify({
        name: "self-demo",
        exports: {
          ".": "./src/index.ts",
          "./feature": "./src/feature.ts",
          "./blocked": null,
        },
      }),
    ],
    ["/workspace/packages/self-demo/src/index.ts", "export const target = 'self-index'"],
    ["/workspace/packages/self-demo/src/feature.ts", "export const target = 'self-feature'"],
    ["/workspace/packages/self-demo/src/blocked.ts", "export const target = 'self-blocked'"],
    ["/workspace/packages/self-demo/src/consumer.ts", "import 'self-demo'"],
  ])

  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("#shared", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/shared.ts",
  )
  expect(resolve("#blocked", "/workspace/src/index.ts", { fileSystem })).toBe(null)
  expect(resolve("#conditional-blocked", "/workspace/src/index.ts", { fileSystem })).toBe(null)
  expect(resolve("#fallback", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/shared.ts",
  )
  expect(resolve("#external", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/demo/browser.ts",
  )
  expect(resolve("#external-feature", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/feature.browser.ts",
  )
  expect(resolve("#external-fallback", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/array.browser.ts",
  )
  expect(resolve("demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/demo/browser.ts",
  )
  expect(resolve("demo/private", "/workspace/src/index.ts", { fileSystem })).toBe(null)
  expect(resolve("conditional-demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/conditional-demo/browser.ts",
  )
  expect(resolve("browser-demo/array", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/array.browser.ts",
  )
  expect(resolve("browser-demo/esm", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/esm.mjs",
  )
  expect(resolve("browser-demo/cjs", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/legacy.cjs",
  )
  expect(resolve("array-root-demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/array-root-demo/browser.ts",
  )
  expect(resolve("null-target-demo/features/public", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/null-target-demo/features/public.ts",
  )
  expect(resolve("null-target-demo/features/private", "/workspace/src/index.ts", { fileSystem })).toBe(null)
  expect(resolve("null-target-demo/conditional-blocked", "/workspace/src/index.ts", { fileSystem })).toBe(null)
  expect(resolve("self-demo", "/workspace/packages/self-demo/src/consumer.ts", { fileSystem })).toBe(
    "/workspace/packages/self-demo/src/index.ts",
  )
  expect(resolve("self-demo/feature", "/workspace/packages/self-demo/src/consumer.ts", { fileSystem })).toBe(
    "/workspace/packages/self-demo/src/feature.ts",
  )
  expect(resolve("self-demo/blocked", "/workspace/packages/self-demo/src/consumer.ts", { fileSystem })).toBe(null)
})

test("Phase 2 resolver honors package browser field and browser map", () => {
  const files = new Map<string, string>([
    ["/workspace/src/index.ts", ""],
    [
      "/workspace/node_modules/browser-demo/package.json",
      JSON.stringify({
        main: "server.js",
        exports: {
          ".": "./server.js",
          "./module": "./module",
        },
        browser: {
          "./server.js": "./browser.js",
          "./module.mjs": "./module.browser.mjs",
          "./disabled.js": false,
        },
      }),
    ],
    ["/workspace/node_modules/browser-demo/server.js", "module.exports = 'server'"],
    ["/workspace/node_modules/browser-demo/browser.js", "module.exports = 'browser'"],
    ["/workspace/node_modules/browser-demo/module.mjs", "export const target = 'server'"],
    ["/workspace/node_modules/browser-demo/module.browser.mjs", "export const target = 'browser'"],
    ["/workspace/node_modules/browser-demo/disabled.js", "module.exports = 'disabled'"],
  ])
  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("browser-demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/browser.js",
  )
  expect(resolve("browser-demo/module", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/module.browser.mjs",
  )
  expect(resolve("browser-demo/disabled", "/workspace/src/index.ts", { fileSystem })).toBe(null)
})

test("Phase 2 resolver supports package pattern exports and imports", () => {
  const files = new Map<string, string>([
    [
      "/workspace/package.json",
      JSON.stringify({ imports: { "#features/*": "./src/features/*.ts" } }),
    ],
    ["/workspace/src/index.ts", ""],
    ["/workspace/src/features/shared.ts", "export const shared = true"],
    [
      "/workspace/node_modules/demo/package.json",
      JSON.stringify({ exports: { "./features/*": "./src/features/*.ts" } }),
    ],
    ["/workspace/node_modules/demo/src/features/a.ts", "export const a = 1"],
  ])

  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("#features/shared", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/features/shared.ts",
  )
  expect(resolve("demo/features/a", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/demo/src/features/a.ts",
  )
})

test("Phase 2 resolver applies tsconfig paths and baseUrl before node_modules", () => {
  const files = new Map<string, string>([
    ["/workspace/src/index.ts", ""],
    ["/workspace/src/lib/tool.ts", "export const tool = true"],
    ["/workspace/src/shared.ts", "export const shared = true"],
    ["/workspace/node_modules/shared/package.json", JSON.stringify({ main: "index.ts" })],
    ["/workspace/node_modules/shared/index.ts", "export const fromPackage = true"],
  ])

  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("@lib/tool", "/workspace/src/index.ts", {
    fileSystem,
    tsconfigPaths: {
      baseUrl: "/workspace/src",
      paths: {
        "@lib/*": ["lib/*.ts"],
      },
    },
  })).toBe("/workspace/src/lib/tool.ts")

  expect(resolve("shared", "/workspace/src/index.ts", {
    fileSystem,
    tsconfigPaths: {
      baseUrl: "/workspace/src",
    },
  })).toBe("/workspace/src/shared.ts")
})

test("Phase 2 shared wasm loader coalesces initialization", async () => {
  let initCount = 0
  const wasmLoader = createWasmLoader(
    "test-wasm",
    async () => {
      initCount += 1
      await Promise.resolve()
    },
  )

  expect(wasmLoader.ready).toBe(false)

  await Promise.all([
    wasmLoader.load(),
    wasmLoader.load(),
  ])

  expect(initCount).toBe(1)
  expect(wasmLoader.ready).toBe(true)
})

test("Phase 2 shared wasm loader retries after failed initialization", async () => {
  let attempts = 0
  const wasmLoader = createWasmLoader(
    "flaky-wasm",
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error("first failure")
    },
  )

  let failed = false
  try {
    await wasmLoader.load()
  } catch (error) {
    failed = error instanceof Error && error.message === "first failure"
  }

  expect(failed).toBe(true)
  expect(wasmLoader.ready).toBe(false)

  await wasmLoader.load()

  expect(attempts).toBe(2)
  expect(wasmLoader.ready).toBe(true)
})

test("Phase 2 transpiler transforms ts export syntax to executable code", async () => {
  const transpiler = createTranspiler()
  const result = await transpiler.transform({
    path: "/workspace/src/example.ts",
    code: "export const answer: number = 42",
    loader: "ts",
  })

  expect(result.code).toContain("42")
  expect(evaluateTransformedModule(result.code).answer).toBe(42)
  expect(result.imports).toEqual([])
})

test("Phase 2 transpiler lowers static imports and basic JSX", async () => {
  const transpiler = createTranspiler()
  const result = await transpiler.transform({
    path: "/workspace/src/App.tsx",
    code: "import { title as heading } from './title'\nexport const view = <main>{heading}</main>",
    loader: "tsx",
  })

  const moduleNamespace = evaluateTransformedModule(result.code, specifier => {
    expect(specifier).toBe("./title")
    return { title: "Mars JSX" }
  })

  expect(moduleNamespace.view).toEqual({ tag: "main", props: {}, children: ["Mars JSX"] })
  expect(result.imports).toEqual([{ path: "./title", kind: "require" }])
})

test("Phase 2 transpiler executes core playground source", async () => {
  const transpiler = createTranspiler()
  const result = await transpiler.transform({
    path: "/workspace/src/app.tsx",
    code: await readPlaygroundText("core-modules/transpiler/app.tsx"),
    loader: "tsx",
  })

  expect(result.code).toContain("__mars_dynamic_import")
  expect(result.code).toContain("__mars_jsx")
  expect(result.imports).toEqual([
    { path: "./message", kind: "dynamic-import" },
    { path: "./title", kind: "require" },
  ])
})

test("Phase 2 loader imports ts module from MarsVFS", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "value.ts": "export const answer: number = 42",
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = await moduleLoader.import("./value", "/workspace/src/index.ts")

  expect(moduleNamespace).toEqual({ answer: 42 })

  await runtime.dispose()
})

test("Phase 2 loader executes ESM static imports and TSX JSX", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.tsx": "import { title } from './title'\nexport const view = <main>{title}</main>",
        "title.ts": "export const title: string = 'Mars JSX'",
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = await moduleLoader.import("./entry", "/workspace/src/index.tsx")

  expect(moduleNamespace).toEqual({
    view: {
      tag: "main",
      props: {},
      children: ["Mars JSX"],
    },
  })

  await runtime.dispose()
})

test("Phase 2 loader evaluates dynamic imports through module cache", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.ts": "export async function loadTitle() { const mod = await import('./title'); return mod.title }",
        "title.ts": "export const title: string = 'dynamic mars'",
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = await moduleLoader.import("./entry", "/workspace/src/index.ts") as {
    loadTitle(): Promise<string>
  }

  expect(await moduleNamespace.loadTitle()).toBe("dynamic mars")

  await runtime.dispose()
})

test("Phase 2 loader preserves namespaces across cyclic ESM imports", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "a.ts": [
          "import * as b from './b'",
          "export const value = 'a'",
          "export function readB() { return b.value }",
          "export function readBThroughCycle() { return b.readA() }",
        ].join("\n"),
        "b.ts": [
          "import * as a from './a'",
          "export const value = 'b'",
          "export function readA() { return a.value }",
        ].join("\n"),
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = await moduleLoader.import("./a", "/workspace/src/index.ts") as Record<string, () => string>

  expect(moduleNamespace.readB()).toBe("b")
  expect(moduleNamespace.readBThroughCycle()).toBe("a")

  await runtime.dispose()
})

test("Phase 2 loader preserves namespaces across cyclic CommonJS require", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "a.cjs": [
          "exports.value = 'a'",
          "const b = require('./b')",
          "exports.readB = () => b.value",
          "exports.readBThroughCycle = () => b.readA()",
        ].join("\n"),
        "b.cjs": [
          "exports.value = 'b'",
          "const a = require('./a')",
          "exports.readA = () => a.value",
        ].join("\n"),
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = await moduleLoader.import("./a", "/workspace/src/index.ts") as Record<string, () => string>

  expect(moduleNamespace.readB()).toBe("b")
  expect(moduleNamespace.readBThroughCycle()).toBe("a")

  await runtime.dispose()
})

test("Phase 2 loader invalidates cached importers recursively", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.ts": "import { readDep } from './middle'\nexport function read() { return readDep() }",
        "middle.ts": "import { value } from './dep'\nexport function readDep() { return value }",
        "dep.ts": "export const value = 'before'",
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const firstNamespace = await moduleLoader.import("./entry", "/workspace/src/index.ts") as Record<string, () => string>
  expect(firstNamespace.read()).toBe("before")

  await runtime.vfs.writeFile("/workspace/src/dep.ts", "export const value = 'after'")
  moduleLoader.invalidate("/workspace/src/dep.ts")

  const secondNamespace = await moduleLoader.import("./entry", "/workspace/src/index.ts") as Record<string, () => string>
  expect(secondNamespace.read()).toBe("after")

  await runtime.dispose()
})

test("Phase 2 loader evaluates CommonJS require through resolver", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.cjs": "const feature = require('./feature.cjs')\nconst config = require('./config.json')\nmodule.exports = { value: feature.value + config.offset }",
        "feature.cjs": "module.exports = { value: 41 }",
        "config.json": JSON.stringify({ offset: 1 }),
      },
    },
  })

  const moduleLoader = createModuleLoader({ vfs: runtime.vfs })
  const moduleNamespace = moduleLoader.require("./entry.cjs", "/workspace/src/index.cjs")

  expect(moduleNamespace).toEqual({ value: 42 })

  await runtime.dispose()
})

test("Phase 2 core module playground cases execute", async () => {
  const resolverManifest = JSON.parse(
    await readPlaygroundText("core-modules/resolver/browser-map.json"),
  ) as ResolverPlaygroundManifest
  const resolverFiles = new Map(Object.entries(resolverManifest.files))
  const resolverFileSystem = {
    existsSync: (path: string) => resolverFiles.has(path),
    readFileSync: (path: string) => resolverFiles.get(path) ?? null,
  }

  for (const [specifier, expectedPath] of Object.entries(resolverManifest.expected)) {
    expect(resolve(specifier, resolverManifest.importer, { fileSystem: resolverFileSystem })).toBe(
      expectedPath,
    )
  }

  const loaderRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("core-loader"),
    },
  })
  const moduleLoader = createModuleLoader({ vfs: loaderRuntime.vfs })
  const loaderModule = await moduleLoader.import("./entry", "/workspace/src/index.tsx") as {
    view: unknown
    loadMessage(): Promise<string>
    loadCommonJsValue(): number
    loadCyclicValue(): string
  }

  expect(loaderModule.view).toEqual({
    tag: "main",
    props: {},
    children: ["Mars Loader"],
  })
  expect(await loaderModule.loadMessage()).toBe("loader dynamic import:json")
  expect(loaderModule.loadCommonJsValue()).toBe(42)
  expect(loaderModule.loadCyclicValue()).toBe("cycle-b:cycle-a")

  await loaderRuntime.vfs.writeFile("/workspace/src/title.ts", "export const title = 'Mars Loader Updated'")
  moduleLoader.invalidate("/workspace/src/title.ts")
  const updatedLoaderModule = await moduleLoader.import("./entry", "/workspace/src/index.tsx") as {
    view: unknown
  }
  expect(updatedLoaderModule.view).toEqual({
    tag: "main",
    props: {},
    children: ["Mars Loader Updated"],
  })

  await loaderRuntime.dispose()

  const runtime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("core-runtime"),
    },
  })
  const processHandle = await runtime.run("/workspace/src/run-entry.ts")
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("runtime stdout {\"phase\":2}\n")
  expect(stderr).toBe("runtime stderr\n")
  expect(exitCode).toBe(0)

  await runtime.dispose()

  const installerRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("core-installer"),
    },
  })
  const installerLoader = createModuleLoader({ vfs: installerRuntime.vfs })
  const installerModule = await installerLoader.import(
    "./dependencies",
    "/workspace/src/index.ts",
  ) as { dependencies: Record<string, string> }
  const installer = createMarsInstaller({
    vfs: installerRuntime.vfs,
    cache: await loadPlaygroundPackageCache(),
  })
  const installResult = await installer.install({
    cwd: "/workspace",
    dependencies: installerModule.dependencies,
    offline: true,
  })

  expect(installResult.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "react@0.0.0-mars",
    "typescript@0.0.1-mars",
    "vite@0.0.0-mars",
  ])

  await installerRuntime.dispose()

  const bundlerRuntime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("core-bundler"),
  })
  const devServer = createMarsDevServer({ vfs: bundlerRuntime.vfs })
  const config = await devServer.config()

  expect(config.root).toBe("/workspace/app")
  expect(config.define).toEqual({ __MARS_LABEL__: "'\"Core Module Bundler\"'" })
  expect(config.resolve.alias).toEqual({ "@": "/workspace/app/src" })

  const appResponse = await devServer.loadModule("/src/App.tsx")
  expect(appResponse.status).toBe(200)
  expect(appResponse.headers.get("x-mars-module-path")).toBe("/workspace/app/src/App.tsx")
  expect(await appResponse.text()).toContain("Core Module Bundler")

  const aliasResponse = await devServer.loadModule("/@/message.ts")
  expect(aliasResponse.status).toBe(200)
  expect(await aliasResponse.text()).toContain("alias resolved")

  await bundlerRuntime.dispose()
})

test("Phase 2 runtime run executes ts entry through loader pipeline", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "entry.ts": "console.log('run output', { ok: true })\nconsole.error('run error')\nexport const result: number = 7 * 6",
      },
    },
  })

  const processHandle = await runtime.run("/workspace/src/entry.ts")
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  expect(stdout).toBe("run output {\"ok\":true}\n")
  expect(stderr).toBe("run error\n")
  expect(exitCode).toBe(0)

  await runtime.dispose()
})

test("Phase 2 installer writes offline packages into node_modules", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "demo-package",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            files: {
              "index.js": "module.exports = { value: 42 }",
            },
            tarballKey: "demo-package-1.0.0.tgz",
          },
        },
      },
    ],
    tarballs: {
      "demo-package-1.0.0.tgz": "offline tarball bytes",
    },
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "demo-package": "latest",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "demo-package@1.0.0",
  ])
  expect(await runtime.vfs.readFile(
    "/workspace/node_modules/demo-package/index.js",
    "utf8",
  )).toBe("module.exports = { value: 42 }")
  expect(resolve("demo-package", "/workspace/src/index.ts", {
    fileSystem: {
      existsSync: path => runtime.vfs.existsSync(path),
      readFileSync: path => runtime.vfs.existsSync(path)
        ? String(runtime.vfs.readFileSync(path, "utf8"))
        : null,
    },
  })).toBe("/workspace/node_modules/demo-package/index.js")

  await runtime.dispose()
})

test("Phase 2 shell bun install writes offline packages from package.json", async () => {
  const runtime = await createMarsRuntime({
    packageCache: await loadPlaygroundPackageCache(),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    name: "lockfile-golden-app",
    dependencies: {
      vite: "latest",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("vite@0.0.0-mars")
  expect(result.stdout).toContain("react@0.0.0-mars")
  expect(await runtime.vfs.readFile("/workspace/node_modules/vite/index.js", "utf8")).toContain("mars-vite")
  expect(await runtime.vfs.readFile("/workspace/mars-lock.json", "utf8")).toContain("0.0.0-mars")
  const bunLockText = String(await runtime.vfs.readFile("/workspace/bun.lock", "utf8"))
  expect(bunLockText).toContain('"configVersion": 1')
  expect(bunLockText).toContain('"vite": ["vite@0.0.0-mars", "", { "dependencies": { "react": "0.0.0-mars", "typescript": "0.0.1-mars" } }, "vite-0.0.0-mars.tgz"]')
  expect(bunLockText).toContain('"react": ["react@0.0.0-mars", "", {}, "react-0.0.0-mars.tgz"]')
  const bunLock = JSON.parse(bunLockText) as {
    lockfileVersion: number
    configVersion: number
    workspaces: {
      "": {
        name?: string
        dependencies: Record<string, string>
      }
    }
    packages: Record<string, unknown[]>
  }
  expect(bunLock.lockfileVersion).toBe(1)
  expect(bunLock.configVersion).toBe(1)
  expect(bunLock.workspaces[""].name).toBe("lockfile-golden-app")
  expect(bunLock.workspaces[""].dependencies.vite).toBe("latest")
  expect(Array.isArray(bunLock.packages.vite)).toBe(true)
  expect(Array.isArray(bunLock.packages.react)).toBe(true)
  expect(bunLock.packages.vite?.[0]).toBe("vite@0.0.0-mars")
  expect(bunLock.packages.react?.[0]).toBe("react@0.0.0-mars")
  expect(bunLock.packages.vite?.[1]).toBe("")
  expect(bunLock.packages.react?.[1]).toBe("")
  expect(typeof bunLock.packages.vite?.[2]).toBe("object")
  expect(typeof bunLock.packages.react?.[2]).toBe("object")
  expect(Object.keys((bunLock.packages.vite?.[2] as Record<string, unknown>) ?? {})).toEqual(["dependencies"])
  expect(Object.keys((bunLock.packages.react?.[2] as Record<string, unknown>) ?? {})).toEqual([])
  const packageKeys = Object.keys(bunLock.packages)
  expect(packageKeys).toEqual([...packageKeys].sort((left, right) => left.localeCompare(right)))

  await runtime.dispose()
})

test("Phase 2 shell bun install replays locked versions from bun.lock", async () => {
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "locked-demo",
        distTags: { latest: "2.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            files: {
              "index.js": "module.exports = 'locked-demo@1.0.0'",
            },
          },
          "2.0.0": {
            version: "2.0.0",
            files: {
              "index.js": "module.exports = 'locked-demo@2.0.0'",
            },
          },
        },
      },
    ],
  })
  const runtime = await createMarsRuntime({ packageCache })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    dependencies: {
      "locked-demo": "latest",
    },
  }))

  const firstInstall = await runtime.shell.run("bun install")
  expect(firstInstall.code).toBe(0)
  expect(await runtime.vfs.readFile("/workspace/node_modules/locked-demo/index.js", "utf8")).toBe(
    "module.exports = 'locked-demo@2.0.0'",
  )

  await packageCache.setMetadata("locked-demo", {
    name: "locked-demo",
    distTags: { latest: "3.0.0" },
    versions: {
      "1.0.0": {
        version: "1.0.0",
        files: {
          "index.js": "module.exports = 'locked-demo@1.0.0'",
        },
      },
      "2.0.0": {
        version: "2.0.0",
        files: {
          "index.js": "module.exports = 'locked-demo@2.0.0'",
        },
      },
      "3.0.0": {
        version: "3.0.0",
        files: {
          "index.js": "module.exports = 'locked-demo@3.0.0'",
        },
      },
    },
  })

  const replayInstall = await runtime.shell.run("bun install")
  expect(replayInstall.code).toBe(0)
  expect(replayInstall.stdout).toContain("locked-demo@2.0.0")
  expect(await runtime.vfs.readFile("/workspace/node_modules/locked-demo/index.js", "utf8")).toBe(
    "module.exports = 'locked-demo@2.0.0'",
  )

  await runtime.dispose()
})

test("Phase 2 shell bun install replays locked workspace dependency versions from bun.lock", async () => {
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "locked-demo",
        distTags: { latest: "2.0.0" },
        versions: {
          "2.0.0": {
            version: "2.0.0",
            files: {
              "index.js": "module.exports = 'locked-demo@2.0.0'",
            },
          },
        },
      },
    ],
  })
  const runtime = await createMarsRuntime({ packageCache })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    workspaces: ["packages/*"],
    dependencies: {
      "@mars/workspace-app": "workspace:*",
    },
  }))
  await runtime.vfs.mkdir("/workspace/packages/app", { recursive: true })
  await runtime.vfs.writeFile("/workspace/packages/app/package.json", JSON.stringify({
    name: "@mars/workspace-app",
    version: "1.0.0",
    dependencies: {
      "locked-demo": "latest",
    },
    main: "index.js",
  }))
  await runtime.vfs.writeFile(
    "/workspace/packages/app/index.js",
    "module.exports = require('locked-demo')",
  )

  const firstInstall = await runtime.shell.run("bun install")
  expect(firstInstall.code).toBe(0)
  expect(await runtime.vfs.readFile("/workspace/node_modules/locked-demo/index.js", "utf8")).toBe(
    "module.exports = 'locked-demo@2.0.0'",
  )

  await packageCache.setMetadata("locked-demo", {
    name: "locked-demo",
    distTags: { latest: "3.0.0" },
    versions: {
      "2.0.0": {
        version: "2.0.0",
        files: {
          "index.js": "module.exports = 'locked-demo@2.0.0'",
        },
      },
      "3.0.0": {
        version: "3.0.0",
        files: {
          "index.js": "module.exports = 'locked-demo@3.0.0'",
        },
      },
    },
  })

  const replayInstall = await runtime.shell.run("bun install")
  expect(replayInstall.code).toBe(0)
  expect(replayInstall.stdout).toContain("locked-demo@2.0.0")
  expect(await runtime.vfs.readFile("/workspace/node_modules/locked-demo/index.js", "utf8")).toBe(
    "module.exports = 'locked-demo@2.0.0'",
  )
  expect(runtime.vfs.readlinkSync("/workspace/node_modules/@mars/workspace-app")).toBe("/workspace/packages/app")

  await runtime.dispose()
})

test("Phase 2 installer fetches missing packages from registry", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache()
  const fetchedUrls: string[] = []
  const registryClient = createNpmRegistryClient({
    registry: "https://registry.mars.test",
    fetch: async input => {
      const url = String(input)
      fetchedUrls.push(url)
      if (url === "https://registry.mars.test/registry-demo") {
        return Response.json({
          name: "registry-demo",
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": {
              version: "1.2.3",
              dependencies: {},
              files: {
                "index.js": "module.exports = { source: 'registry' }",
              },
              dist: { tarball: "https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz" },
            },
          },
        })
      }
      if (url === "https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz") {
        return new Response("registry tarball bytes")
      }

      return new Response("not found", { status: 404 })
    },
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache, registryClient })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "registry-demo": "latest",
    },
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "registry-demo@1.2.3",
  ])
  expect(fetchedUrls).toEqual([
    "https://registry.mars.test/registry-demo",
    "https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz",
  ])
  expect(await packageCache.getMetadata("registry-demo")).toEqual({
    name: "registry-demo",
    distTags: { latest: "1.2.3" },
    versions: {
      "1.2.3": {
        version: "1.2.3",
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
        peerDependenciesMeta: {},
        scripts: {},
        bin: {},
        files: {
          "index.js": "module.exports = { source: 'registry' }",
        },
        tarballKey: "https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz",
      },
    },
  })
  expect(new TextDecoder().decode(await packageCache.getTarball("https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz") ?? new Uint8Array())).toBe("registry tarball bytes")
  expect(await runtime.vfs.readFile("/workspace/node_modules/registry-demo/index.js", "utf8")).toBe("module.exports = { source: 'registry' }")
  const registryBunLockText = String(await runtime.vfs.readFile("/workspace/bun.lock", "utf8"))
  expect(registryBunLockText).toContain(
    '"registry-demo": ["registry-demo@1.2.3", "", {}, "https://registry.mars.test/registry-demo/-/registry-demo-1.2.3.tgz"]',
  )

  await runtime.dispose()
})

test("Phase 2 installer extracts registry tgz package files", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache()
  const tarballBytes = await gzipBytes(createTarArchive({
    "package/index.js": "module.exports = { extracted: true }",
    "package/lib/message.js": "module.exports = 'from tgz'",
  }))
  const registryClient = createNpmRegistryClient({
    registry: "https://registry.mars.test",
    fetch: async input => {
      const url = String(input)
      if (url === "https://registry.mars.test/tgz-demo") {
        return Response.json({
          name: "tgz-demo",
          "dist-tags": { latest: "2.0.0" },
          versions: {
            "2.0.0": {
              version: "2.0.0",
              dependencies: {},
              dist: { tarball: "https://registry.mars.test/tgz-demo/-/tgz-demo-2.0.0.tgz" },
            },
          },
        })
      }
      if (url === "https://registry.mars.test/tgz-demo/-/tgz-demo-2.0.0.tgz") {
        return new Response(toArrayBuffer(tarballBytes))
      }

      return new Response("not found", { status: 404 })
    },
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache, registryClient })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "tgz-demo": "latest",
    },
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "tgz-demo@2.0.0",
  ])
  expect(await runtime.vfs.readFile("/workspace/node_modules/tgz-demo/index.js", "utf8")).toBe("module.exports = { extracted: true }")
  expect(await runtime.vfs.readFile("/workspace/node_modules/tgz-demo/lib/message.js", "utf8")).toBe("module.exports = 'from tgz'")
  expect((await packageCache.getTarball("https://registry.mars.test/tgz-demo/-/tgz-demo-2.0.0.tgz"))?.byteLength).toBe(tarballBytes.byteLength)

  await runtime.dispose()
})

test("Phase 2 shell bun install can fetch package.json dependencies from registry", async () => {
  const fetchedUrls: string[] = []
  const runtime = await createMarsRuntime({
    packageRegistryClient: createNpmRegistryClient({
      registry: "https://registry.mars.test",
      fetch: async input => {
        const url = String(input)
        fetchedUrls.push(url)
        if (url === "https://registry.mars.test/shell-registry-demo") {
          return Response.json({
            name: "shell-registry-demo",
            "dist-tags": { latest: "0.1.0" },
            versions: {
              "0.1.0": {
                version: "0.1.0",
                files: {
                  "index.js": "module.exports = { shell: true }",
                },
              },
            },
          })
        }

        return new Response("not found", { status: 404 })
      },
    }),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    dependencies: {
      "shell-registry-demo": "latest",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("shell-registry-demo@0.1.0")
  expect(fetchedUrls).toEqual(["https://registry.mars.test/shell-registry-demo"])
  expect(await runtime.vfs.readFile("/workspace/node_modules/shell-registry-demo/index.js", "utf8")).toBe("module.exports = { shell: true }")

  await runtime.dispose()
})

test("Phase 2 installer loads offline cache from playground fixture", async () => {
  const runtime = await createMarsRuntime()
  const installer = createMarsInstaller({
    vfs: runtime.vfs,
    cache: await loadPlaygroundPackageCache(),
  })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      vite: "latest",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "react@0.0.0-mars",
    "typescript@0.0.1-mars",
    "vite@0.0.0-mars",
  ])
  expect(await runtime.vfs.readFile("/workspace/node_modules/vite/index.js", "utf8")).toContain(
    "mars-vite",
  )
  expect(await runtime.vfs.readFile("/workspace/node_modules/typescript/index.js", "utf8")).toContain(
    "0.0.1-mars",
  )
  expect(resolve("react", "/workspace/src/index.ts", {
    fileSystem: {
      existsSync: path => runtime.vfs.existsSync(path),
      readFileSync: path => runtime.vfs.existsSync(path)
        ? String(runtime.vfs.readFileSync(path, "utf8"))
        : null,
    },
  })).toBe("/workspace/node_modules/react/index.js")

  await runtime.dispose()
})

test("Phase 2 dev server loads modules and emits HMR updates", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      src: {
        "App.tsx": "export const title: string = 'Mars App'",
      },
    },
  })
  const devServer = createMarsDevServer({ vfs: runtime.vfs })
  const payloads: unknown[] = []
  const subscription = devServer.hmrChannel().onMessage(payload => {
    payloads.push(payload)
  })

  const viteClientResponse = await devServer.loadModule("/@vite/client")
  expect(viteClientResponse.headers.get("content-type")).toContain("text/javascript")
  expect(await viteClientResponse.text()).toContain("export const hot")

  const moduleResponse = await devServer.loadModule("/src/App.tsx")
  expect(moduleResponse.status).toBe(200)
  expect(moduleResponse.headers.get("x-mars-module-path")).toBe("/workspace/src/App.tsx")
  expect(await moduleResponse.text()).toContain("Mars App")

  const transformed = await devServer.transformRequest("/src/App.tsx")
  expect(transformed?.code).toContain("Mars App")

  const updates = await devServer.handleHMRUpdate("/workspace/src/App.tsx")
  expect(updates[0].path).toBe("/workspace/src/App.tsx")
  expect(payloads.length).toBe(1)

  subscription.dispose()
  await runtime.dispose()
})

test("Phase 2 dev server applies vite config root", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "vite.config.ts": "export default { root: '/workspace/app', server: { hmr: false } }",
      app: {
        src: {
          "App.tsx": "export const title: string = 'Configured Root'",
        },
      },
    },
  })
  const devServer = createMarsDevServer({ vfs: runtime.vfs })

  const config = await devServer.config()
  expect(config.root).toBe("/workspace/app")
  expect(config.server.hmr).toBe(false)

  const moduleResponse = await devServer.loadModule("/src/App.tsx")
  expect(moduleResponse.status).toBe(200)
  expect(moduleResponse.headers.get("x-mars-module-path")).toBe("/workspace/app/src/App.tsx")
  expect(await moduleResponse.text()).toContain("Configured Root")

  await runtime.dispose()
})

test("Phase 2 dev server applies vite alias and define", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: {
      "vite.config.ts": [
        "export default {",
        "  root: '/workspace/app',",
        "  define: { __MARS_LABEL__: '\"Alias Define\"' },",
        "  resolve: { alias: { '@': '/workspace/app/src' } },",
        "}",
      ].join("\n"),
      app: {
        src: {
          "App.tsx": "export const title: string = __MARS_LABEL__",
          "message.ts": "export const message: string = 'from alias'",
        },
      },
    },
  })
  const devServer = createMarsDevServer({ vfs: runtime.vfs })

  const config = await devServer.config()
  expect(config.define).toEqual({ __MARS_LABEL__: "'\"Alias Define\"'" })
  expect(config.resolve.alias).toEqual({ "@": "/workspace/app/src" })

  const appResponse = await devServer.loadModule("/src/App.tsx")
  const appCode = await appResponse.text()
  expect(appCode).toContain("'\"Alias Define\"'")
  expect(appCode).toContain("Object.defineProperty(exports, \"title\"")

  const aliasResponse = await devServer.loadModule("/@/message.ts")
  expect(aliasResponse.status).toBe(200)
  expect(aliasResponse.headers.get("x-mars-module-path")).toBe("/workspace/app/src/message.ts")
  expect(await aliasResponse.text()).toContain("from alias")

  const updates = await devServer.handleHMRUpdate("src/message.ts")
  expect(updates[0].path).toBe("/workspace/app/src/message.ts")

  await runtime.dispose()
})

test("Phase 2 dev server loads vite playground files", async () => {
  const runtime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("vite-react-ts"),
  })
  const devServer = createMarsDevServer({ vfs: runtime.vfs })

  const appResponse = await devServer.loadModule("/src/App.tsx")
  const appCode = await appResponse.text()

  expect(appResponse.status).toBe(200)
  expect(appCode).toContain("Mars Vite React TS")
  expect(appCode).toContain("__mars_jsx")

  await runtime.dispose()
})

test("Phase 2 playground TSX entries render first screen models", async () => {
  const tsxRuntime = await createMarsRuntime({
    initialFiles: {
      src: await loadPlaygroundFiles("tsx"),
    },
  })
  const tsxLoader = createModuleLoader({ vfs: tsxRuntime.vfs })
  const tsxModule = await tsxLoader.import("./app", "/workspace/src/index.tsx") as {
    renderMessage(): unknown
  }

  expect(tsxModule.renderMessage()).toEqual({
    tag: "main",
    props: {},
    children: ["hello from mars tsx"],
  })

  await tsxRuntime.dispose()

  const viteRuntime = await createMarsRuntime({
    initialFiles: await loadPlaygroundFiles("vite-react-ts"),
  })
  const viteLoader = createModuleLoader({ vfs: viteRuntime.vfs })
  const viteModule = await viteLoader.import("./App", "/workspace/src/index.tsx") as {
    render(): unknown
  }

  expect(viteModule.render()).toEqual({
    tag: "main",
    props: {},
    children: ["Mars Vite React TS"],
  })

  await viteRuntime.dispose()
})

test("Phase 2 playground module cases reference real files", async () => {
  const cases = await loadPlaygroundModuleCases()
  const phase2Cases = cases.filter(playgroundCase => playgroundCase.phase === "Phase 2")

  expect(phase2Cases.map(playgroundCase => playgroundCase.id)).toEqual([
    "phase2-resolver-browser-map",
    "phase2-transpiler-core",
    "phase2-loader-core",
    "phase2-runtime-run-core",
    "phase2-installer-core",
    "phase2-installer-registry-fetch",
    "phase2-bundler-core",
    "phase2-tsx-loader",
    "phase2-vite-dev-server",
    "phase2-installer-fixtures",
  ])

  for (const playgroundCase of phase2Cases) {
    const source = await readPlaygroundCaseEntry(playgroundCase.entry)
    expect(source.length > 0).toBe(true)
  }
})

function createTarArchive(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []

  for (const [path, content] of Object.entries(files)) {
    const body = encoder.encode(content)
    const header = new Uint8Array(512)
    writeTarString(header, 0, 100, path)
    writeTarString(header, 100, 8, "0000644")
    writeTarString(header, 108, 8, "0000000")
    writeTarString(header, 116, 8, "0000000")
    writeTarString(header, 124, 12, body.byteLength.toString(8).padStart(11, "0"))
    writeTarString(header, 136, 12, "00000000000")
    header.fill(32, 148, 156)
    header[156] = 48
    writeTarString(header, 257, 6, "ustar")
    writeTarString(header, 263, 2, "00")
    writeTarString(header, 148, 8, checksumTarHeader(header).toString(8).padStart(6, "0"))
    header[154] = 0
    header[155] = 32

    chunks.push(header, body, new Uint8Array(padToTarBlock(body.byteLength)))
  }

  chunks.push(new Uint8Array(1024))
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const archive = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }

  return archive
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).subarray(0, length), offset)
}

function checksumTarHeader(header: Uint8Array): number {
  return header.reduce((total, byte) => total + byte, 0)
}

function padToTarBlock(byteLength: number): number {
  return (512 - byteLength % 512) % 512
}
