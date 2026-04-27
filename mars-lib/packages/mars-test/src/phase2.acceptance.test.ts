import { expect, test } from "bun:test"

import { createMarsDevServer } from "@mars/bundler"
import { createMarsRuntime } from "@mars/client"
import { createMarsInstaller, createMemoryPackageCache } from "@mars/installer"
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
  ])

  const resolvedPath = resolve("./feature", "/workspace/src/index.ts", {
    fileSystem: {
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? null,
    },
  })

  expect(resolvedPath).toBe("/workspace/src/feature.ts")
})

test("Phase 2 resolver honors package exports and imports", () => {
  const files = new Map<string, string>([
    ["/workspace/package.json", JSON.stringify({ imports: { "#shared": "./src/shared.ts" } })],
    ["/workspace/src/index.ts", "import '#shared'"],
    ["/workspace/src/shared.ts", "export const shared = true"],
    [
      "/workspace/node_modules/demo/package.json",
      JSON.stringify({ exports: { ".": { browser: "./browser.ts", default: "./index.ts" } } }),
    ],
    ["/workspace/node_modules/demo/browser.ts", "export const target = 'browser'"],
    ["/workspace/node_modules/demo/index.ts", "export const target = 'default'"],
  ])

  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("#shared", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/src/shared.ts",
  )
  expect(resolve("demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/demo/browser.ts",
  )
})

test("Phase 2 resolver honors package browser field and browser map", () => {
  const files = new Map<string, string>([
    ["/workspace/src/index.ts", ""],
    [
      "/workspace/node_modules/browser-demo/package.json",
      JSON.stringify({
        main: "server.js",
        browser: {
          "./server.js": "./browser.js",
          "./disabled.js": false,
        },
      }),
    ],
    ["/workspace/node_modules/browser-demo/server.js", "module.exports = 'server'"],
    ["/workspace/node_modules/browser-demo/browser.js", "module.exports = 'browser'"],
    ["/workspace/node_modules/browser-demo/disabled.js", "module.exports = 'disabled'"],
  ])
  const fileSystem = {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? null,
  }

  expect(resolve("browser-demo", "/workspace/src/index.ts", { fileSystem })).toBe(
    "/workspace/node_modules/browser-demo/browser.js",
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
  }

  expect(loaderModule.view).toEqual({
    tag: "main",
    props: {},
    children: ["Mars Loader"],
  })
  expect(await loaderModule.loadMessage()).toBe("loader dynamic import:json")
  expect(loaderModule.loadCommonJsValue()).toBe(42)

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
