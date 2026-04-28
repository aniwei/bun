import { expect, test } from "bun:test"

import { createMarsRuntime } from "@mars/client"
import { createMarsInstaller, createMemoryPackageCache } from "@mars/installer"
import { resolve } from "@mars/resolver"

test("Phase 2 installer selects highest satisfying semver ranges", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      createVersionedPackage("caret-demo", ["1.1.0", "1.4.0", "2.0.0"]),
      createVersionedPackage("comparator-demo", ["1.0.0", "1.2.0", "1.9.0", "2.0.0"]),
      createVersionedPackage("prerelease-demo", ["0.0.0-alpha.1", "0.0.0-alpha.2", "0.0.0"]),
      createVersionedPackage("tilde-demo", ["1.1.0", "1.1.9", "1.2.0"]),
      createVersionedPackage("wildcard-demo", ["1.0.0", "1.9.0", "2.0.0"]),
      createVersionedPackage("zero-demo", ["0.2.3", "0.2.9", "0.3.0"]),
      createVersionedPackage("prerelease-gated-demo", ["1.2.3", "1.3.0-alpha.1"]),
      createVersionedPackage("prerelease-opt-in-demo", ["1.2.3-alpha.1", "1.2.3-alpha.2", "1.2.4-alpha.1"]),
      createVersionedPackage("build-metadata-demo", ["1.2.3+build.7"]),
      createVersionedPackage("hyphen-demo", ["1.2.3", "1.4.0", "2.0.0", "2.1.0"]),
      createVersionedPackage("partial-comparator-demo", ["1.1.9", "1.2.0", "1.4.0", "2.0.0"]),
      createVersionedPackage("partial-hyphen-demo", ["2.2.9", "2.3.0", "2.3.9", "2.4.0"]),
      createVersionedPackage("partial-caret-demo", ["1.1.9", "1.2.0", "1.9.0", "2.0.0"]),
      createVersionedPackage("partial-tilde-demo", ["1.1.0", "1.2.0", "1.2.9", "1.3.0"]),
      createVersionedPackage("comma-comparator-demo", ["1.1.0", "1.2.0", "1.9.0", "2.0.0"]),
      createVersionedPackage("spaced-comparator-demo", ["1.1.0", "1.2.0", "1.9.0", "2.0.0"]),
      createVersionedPackage("v-prefix-demo", ["1.2.2", "1.2.3", "1.2.4"]),
      createVersionedPackage("or-prerelease-demo", ["1.2.3-alpha.1", "1.2.3", "2.0.0-alpha.1", "2.0.0"]),
      createVersionedPackage("or-prerelease-opt-in-demo", ["1.2.3-alpha.1", "1.2.3", "2.0.0-alpha.1"]),
      createVersionedPackage("zero-patch-caret-demo", ["0.0.3", "0.0.4", "0.1.0"]),
      createVersionedPackage("zero-minor-tilde-demo", ["0.1.1", "0.1.2", "0.1.9", "0.2.0"]),
      createVersionedPackage("v-prefix-partial-demo", ["1.1.9", "1.2.0", "1.2.9", "1.3.0"]),
      createVersionedPackage("v-prefix-partial-caret-demo", ["0.2.0", "0.2.9", "0.3.0"]),
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "caret-demo": "^1.1.0",
      "comparator-demo": ">=1.2.0 <2.0.0",
      "prerelease-demo": "^0.0.0-alpha.1",
      "tilde-demo": "~1.1.0",
      "wildcard-demo": "1.x",
      "zero-demo": "^0.2.3",
      "prerelease-gated-demo": "^1.2.3",
      "prerelease-opt-in-demo": ">=1.2.3-alpha.1 <1.2.4",
      "build-metadata-demo": "=1.2.3+build.7",
      "hyphen-demo": "1.2.3 - 2.0.0",
      "partial-comparator-demo": ">=1.2 <2",
      "partial-hyphen-demo": "2.3 - 2.3",
      "partial-caret-demo": "^1.2",
      "partial-tilde-demo": "~1.2",
      "comma-comparator-demo": ">=1.2.0, <2.0.0",
      "spaced-comparator-demo": ">= 1.2.0 < 2.0.0",
      "or-prerelease-demo": "^1.2.3-alpha.1 || ^2.0.0",
      "or-prerelease-opt-in-demo": "^1.2.3-alpha.1 || >=2.0.0-alpha.1 <2.0.0",
      "v-prefix-demo": "=v1.2.3",
      "zero-patch-caret-demo": "^0.0.3",
      "zero-minor-tilde-demo": "~0.1.2",
      "v-prefix-partial-demo": "v1.2",
      "v-prefix-partial-caret-demo": "^v0.2",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "build-metadata-demo@1.2.3+build.7",
    "caret-demo@1.4.0",
    "comma-comparator-demo@1.9.0",
    "comparator-demo@1.9.0",
    "hyphen-demo@2.0.0",
    "or-prerelease-demo@2.0.0",
    "or-prerelease-opt-in-demo@2.0.0-alpha.1",
    "partial-caret-demo@1.9.0",
    "partial-comparator-demo@1.4.0",
    "partial-hyphen-demo@2.3.9",
    "partial-tilde-demo@1.2.9",
    "prerelease-demo@0.0.0",
    "prerelease-gated-demo@1.2.3",
    "prerelease-opt-in-demo@1.2.3-alpha.2",
    "spaced-comparator-demo@1.9.0",
    "tilde-demo@1.1.9",
    "v-prefix-demo@1.2.3",
    "v-prefix-partial-caret-demo@0.2.9",
    "v-prefix-partial-demo@1.2.9",
    "wildcard-demo@1.9.0",
    "zero-demo@0.2.9",
    "zero-minor-tilde-demo@0.1.9",
    "zero-patch-caret-demo@0.0.3",
  ])
  expect(result.lockfile?.packages).toEqual({
    "caret-demo": "1.4.0",
    "comparator-demo": "1.9.0",
    "prerelease-demo": "0.0.0",
    "tilde-demo": "1.1.9",
    "wildcard-demo": "1.9.0",
    "zero-demo": "0.2.9",
    "prerelease-gated-demo": "1.2.3",
    "prerelease-opt-in-demo": "1.2.3-alpha.2",
    "build-metadata-demo": "1.2.3+build.7",
    "comma-comparator-demo": "1.9.0",
    "hyphen-demo": "2.0.0",
    "or-prerelease-demo": "2.0.0",
    "or-prerelease-opt-in-demo": "2.0.0-alpha.1",
    "partial-caret-demo": "1.9.0",
    "partial-comparator-demo": "1.4.0",
    "partial-hyphen-demo": "2.3.9",
    "partial-tilde-demo": "1.2.9",
    "spaced-comparator-demo": "1.9.0",
    "v-prefix-demo": "1.2.3",
    "v-prefix-partial-caret-demo": "0.2.9",
    "v-prefix-partial-demo": "1.2.9",
    "zero-minor-tilde-demo": "0.1.9",
    "zero-patch-caret-demo": "0.0.3",
  })
  expect(result.lockfile?.root.dependencies["caret-demo"]).toBe("^1.1.0")
  expect(result.lockfile?.entries["hyphen-demo"]?.version).toBe("2.0.0")
  expect(result.lockfile?.entries["hyphen-demo"]?.dependencies).toEqual({})

  await runtime.dispose()
})

test("Phase 2 installer nests incompatible transitive dependency versions", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "framework-a",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dependencies: { shared: "^2.0.0" },
            files: { "index.js": "module.exports = require('shared')" },
          },
        },
      },
      {
        name: "framework-b",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dependencies: { shared: "^1.0.0" },
            files: { "index.js": "module.exports = require('shared')" },
          },
        },
      },
      createVersionedPackage("shared", ["1.5.0", "2.1.0"]),
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "framework-a": "latest",
      "framework-b": "latest",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.installPath ?? pkg.name}@${pkg.version}`).sort()).toEqual([
    "framework-a@1.0.0",
    "framework-b/node_modules/shared@1.5.0",
    "framework-b@1.0.0",
    "shared@2.1.0",
  ])
  expect(await runtime.vfs.readFile("/workspace/node_modules/shared/index.js", "utf8")).toBe(
    'module.exports = {"version":"2.1.0"}',
  )
  expect(await runtime.vfs.readFile("/workspace/node_modules/framework-b/node_modules/shared/index.js", "utf8")).toBe(
    'module.exports = {"version":"1.5.0"}',
  )

  const fileSystem = {
    existsSync: (path: string) => runtime.vfs.existsSync(path),
    readFileSync: (path: string) => runtime.vfs.existsSync(path)
      ? String(runtime.vfs.readFileSync(path, "utf8"))
      : null,
  }
  expect(resolve("shared", "/workspace/node_modules/framework-a/index.js", { fileSystem })).toBe(
    "/workspace/node_modules/shared/index.js",
  )
  expect(resolve("shared", "/workspace/node_modules/framework-b/index.js", { fileSystem })).toBe(
    "/workspace/node_modules/framework-b/node_modules/shared/index.js",
  )

  await runtime.dispose()
})

test("Phase 2 installer rejects unsatisfied semver ranges", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      createVersionedPackage("strict-demo", ["1.0.0", "1.5.0"]),
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  let caughtError: unknown
  try {
    await installer.install({
      cwd: "/workspace",
      dependencies: {
        "strict-demo": ">=2.0.0",
      },
      offline: true,
    })
  } catch (error) {
    caughtError = error
  }

  expect(caughtError instanceof Error ? caughtError.message : String(caughtError)).toContain(
    "No package version satisfies range: >=2.0.0",
  )

  await runtime.dispose()
})

test("Phase 2 installer installs available optional dependencies and skips missing ones", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "required-root",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            optionalDependencies: {
              "transitive-missing": "latest",
              "transitive-optional": "latest",
            },
            files: {
              "index.js": "module.exports = 'required'",
            },
          },
        },
      },
      createVersionedPackage("optional-present", ["1.0.0"]),
      createVersionedPackage("optional-unsatisfied", ["1.0.0"]),
      createVersionedPackage("transitive-optional", ["1.0.0"]),
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "required-root": "latest",
    },
    optionalDependencies: {
      "optional-missing": "latest",
      "optional-present": "latest",
      "optional-unsatisfied": ">=2.0.0",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "optional-present@1.0.0",
    "required-root@1.0.0",
    "transitive-optional@1.0.0",
  ])
  expect(runtime.vfs.existsSync("/workspace/node_modules/optional-missing")).toBe(false)
  expect(runtime.vfs.existsSync("/workspace/node_modules/optional-unsatisfied")).toBe(false)
  expect(await runtime.vfs.readFile(
    "/workspace/node_modules/required-root/package.json",
    "utf8",
  )).toContain("transitive-optional")

  await runtime.dispose()
})

test("Phase 2 shell bun install reads optionalDependencies from package.json", async () => {
  const runtime = await createMarsRuntime({
    packageCache: createMemoryPackageCache({
      metadata: [
        createVersionedPackage("shell-optional", ["1.0.0"]),
      ],
    }),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    optionalDependencies: {
      "shell-optional": "latest",
      "shell-optional-missing": "latest",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("shell-optional@1.0.0")
  expect(runtime.vfs.existsSync("/workspace/node_modules/shell-optional/index.js")).toBe(true)
  expect(runtime.vfs.existsSync("/workspace/node_modules/shell-optional-missing")).toBe(false)

  await runtime.dispose()
})

test("Phase 2 installer installs required peer dependencies and skips missing optional peers", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      createVersionedPackage("react", ["17.0.0", "18.2.0"]),
      {
        name: "react-plugin",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            peerDependencies: {
              "optional-peer-missing": "latest",
              react: "^18.0.0",
            },
            peerDependenciesMeta: {
              "optional-peer-missing": { optional: true },
            },
            files: {
              "index.js": "module.exports = 'plugin'",
            },
          },
        },
      },
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "react-plugin": "latest",
    },
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "react@18.2.0",
    "react-plugin@1.0.0",
  ])
  expect(runtime.vfs.existsSync("/workspace/node_modules/optional-peer-missing")).toBe(false)
  expect(await runtime.vfs.readFile(
    "/workspace/node_modules/react-plugin/package.json",
    "utf8",
  )).toContain("peerDependenciesMeta")

  await runtime.dispose()
})

test("Phase 2 installer rejects incompatible peer dependency ranges", async () => {
  const runtime = await createMarsRuntime()
  const packageCache = createMemoryPackageCache({
    metadata: [
      createVersionedPackage("react", ["17.0.0", "18.2.0"]),
      {
        name: "alpha-react-plugin",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            peerDependencies: {
              react: "^18.0.0",
            },
            files: {
              "index.js": "module.exports = 'plugin'",
            },
          },
        },
      },
    ],
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  let caughtError: unknown
  try {
    await installer.install({
      cwd: "/workspace",
      dependencies: {
        react: "17.0.0",
        "alpha-react-plugin": "latest",
      },
      offline: true,
    })
  } catch (error) {
    caughtError = error
  }

  expect(caughtError instanceof Error ? caughtError.message : String(caughtError)).toContain(
    "Package react@17.0.0 does not satisfy range ^18.0.0 required by alpha-react-plugin@1.0.0",
  )

  await runtime.dispose()
})

test("Phase 2 shell bun install reads peerDependencies from package.json", async () => {
  const runtime = await createMarsRuntime({
    packageCache: createMemoryPackageCache({
      metadata: [
        createVersionedPackage("shell-peer", ["1.0.0", "1.2.0"]),
      ],
    }),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    peerDependencies: {
      "shell-peer": "^1.0.0",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("shell-peer@1.2.0")
  expect(runtime.vfs.existsSync("/workspace/node_modules/shell-peer/index.js")).toBe(true)

  await runtime.dispose()
})

test("Phase 2 installer links local workspace packages and workspace protocol dependencies", async () => {
  const runtime = await createMarsRuntime()
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: createMemoryPackageCache() })

  const result = await installer.install({
    cwd: "/workspace",
    dependencies: {
      "workspace-app": "workspace:*",
    },
    workspaces: [
      {
        name: "workspace-app",
        version: "1.0.0",
        path: "/workspace/packages/app",
        dependencies: {
          "workspace-lib": "workspace:^",
        },
        files: {
          "index.js": "module.exports = require('workspace-lib')",
          "package.json": JSON.stringify({ name: "workspace-app", version: "1.0.0", main: "index.js" }),
        },
      },
      {
        name: "workspace-lib",
        version: "1.2.0",
        path: "/workspace/packages/lib",
        files: {
          "index.js": "module.exports = 'local-lib'",
          "package.json": JSON.stringify({ name: "workspace-lib", version: "1.2.0", main: "index.js" }),
        },
      },
    ],
    offline: true,
  })

  expect(result.packages.map(pkg => `${pkg.name}@${pkg.version}`)).toEqual([
    "workspace-app@1.0.0",
    "workspace-lib@1.2.0",
  ])
  expect(await runtime.vfs.readFile("/workspace/node_modules/workspace-app/index.js", "utf8")).toBe(
    "module.exports = require('workspace-lib')",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/workspace-app").isSymbolicLink()).toBe(true)
  expect(runtime.vfs.readlinkSync("/workspace/node_modules/workspace-app")).toBe("/workspace/packages/app")
  expect(await runtime.vfs.readFile("/workspace/node_modules/workspace-lib/index.js", "utf8")).toBe(
    "module.exports = 'local-lib'",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/workspace-lib").isSymbolicLink()).toBe(true)

  await runtime.dispose()
})

test("Phase 2 shell bun install discovers package.json workspaces", async () => {
  const runtime = await createMarsRuntime({ packageCache: createMemoryPackageCache() })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    workspaces: ["packages/*"],
  }))
  await runtime.vfs.mkdir("/workspace/packages/lib", { recursive: true })
  await runtime.vfs.writeFile("/workspace/packages/lib/package.json", JSON.stringify({
    name: "@mars/workspace-lib",
    version: "2.0.0",
    main: "index.js",
  }))
  await runtime.vfs.writeFile("/workspace/packages/lib/index.js", "module.exports = 'workspace-lib'")
  await runtime.vfs.mkdir("/workspace/packages/app", { recursive: true })
  await runtime.vfs.writeFile("/workspace/packages/app/package.json", JSON.stringify({
    name: "@mars/workspace-app",
    version: "1.0.0",
    dependencies: {
      "@mars/workspace-lib": "workspace:*",
    },
    main: "index.js",
  }))
  await runtime.vfs.writeFile("/workspace/packages/app/index.js", "module.exports = require('@mars/workspace-lib')")

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("@mars/workspace-app@1.0.0")
  expect(result.stdout).toContain("@mars/workspace-lib@2.0.0")
  expect(await runtime.vfs.readFile("/workspace/node_modules/@mars/workspace-app/index.js", "utf8")).toBe(
    "module.exports = require('@mars/workspace-lib')",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/@mars/workspace-app").isSymbolicLink()).toBe(true)
  expect(await runtime.vfs.readFile("/workspace/node_modules/@mars/workspace-lib/index.js", "utf8")).toBe(
    "module.exports = 'workspace-lib'",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/@mars/workspace-lib").isSymbolicLink()).toBe(true)
  expect(runtime.vfs.readlinkSync("/workspace/node_modules/@mars/workspace-lib")).toBe("/workspace/packages/lib")

  const bunLockText = String(await runtime.vfs.readFile("/workspace/bun.lock", "utf8"))
  const bunLock = JSON.parse(bunLockText) as {
    packages: Record<string, unknown[]>
  }
  expect(bunLock.packages["@mars/workspace-app"]?.[0]).toBe("@mars/workspace-app@1.0.0")
  expect((bunLock.packages["@mars/workspace-app"]?.[2] as Record<string, unknown>)?.workspace).toBe("/workspace/packages/app")
  expect((bunLock.packages["@mars/workspace-lib"]?.[2] as Record<string, unknown>)?.workspace).toBe("/workspace/packages/lib")
  expect(bunLockText).toContain(
    '    "@mars/workspace-app": ["@mars/workspace-app@1.0.0", "", { "dependencies": { "@mars/workspace-lib": "2.0.0" }, "workspace": "/workspace/packages/app" }],',
  )
  expect(bunLockText).toContain(
    '    "@mars/workspace-lib": ["@mars/workspace-lib@2.0.0", "", { "workspace": "/workspace/packages/lib" }]',
  )

  await runtime.vfs.writeFile("/workspace/packages/lib/index.js", "module.exports = 'workspace-lib-updated'")
  expect(await runtime.vfs.readFile("/workspace/node_modules/@mars/workspace-lib/index.js", "utf8")).toBe(
    "module.exports = 'workspace-lib-updated'",
  )

  await runtime.dispose()
})

test("Phase 2 shell bun install runs package and root lifecycle scripts", async () => {
  const runtime = await createMarsRuntime({
    packageCache: createMemoryPackageCache({
      metadata: [
        {
          name: "lifecycle-dep",
          distTags: { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              version: "1.0.0",
              scripts: {
                preinstall: "echo dep-preinstall",
                install: "echo dep-install",
                postinstall: "echo dep-postinstall",
              },
              files: {
                "index.js": "module.exports = 'lifecycle'",
              },
            },
          },
        },
      ],
    }),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    dependencies: {
      "lifecycle-dep": "latest",
    },
    scripts: {
      preinstall: "echo root-preinstall",
      install: "echo root-install",
      postinstall: "echo root-postinstall",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("installed lifecycle-dep@1.0.0")
  expect(result.stdout).toContain("dep-preinstall\ndep-install\ndep-postinstall")
  expect(result.stdout).toContain("root-preinstall\nroot-install\nroot-postinstall")
  expect(await runtime.vfs.readFile("/workspace/node_modules/lifecycle-dep/package.json", "utf8")).toContain(
    "dep-postinstall",
  )

  await runtime.dispose()
})

test("Phase 2 shell bun install executes package JS bins from lifecycle scripts", async () => {
  const runtime = await createMarsRuntime({
    packageCache: createMemoryPackageCache({
      metadata: [
        {
          name: "bin-provider",
          distTags: { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              version: "1.0.0",
              bin: {
                "mars-bin-tool": "bin/tool.js",
              },
              files: {
                bin: {
                  "tool.js": `#!/usr/bin/env bun
console.log(
  "js-bin-env",
  process.env.npm_lifecycle_event,
  process.env.npm_package_name,
  process.env.npm_package_version,
  process.env.npm_package_json,
  process.env.npm_package_scripts_postinstall,
  process.env.npm_command,
  process.env.npm_config_global,
  process.env.npm_config_local_prefix,
  process.env.npm_config_prefix,
  process.env.npm_config_user_agent,
  process.argv.at(-1),
)`,
                },
                "index.js": "module.exports = 'bin-provider'",
              },
            },
          },
        },
      ],
    }),
  })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    name: "root-lifecycle-app",
    version: "2.3.4",
    dependencies: {
      "bin-provider": "latest",
    },
    scripts: {
      postinstall: "mars-bin-tool lifecycle-arg",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(0)
  expect(result.stdout).toContain("installed bin-provider@1.0.0")
  expect(result.stdout).toContain(
    "js-bin-env postinstall root-lifecycle-app 2.3.4 /workspace/package.json mars-bin-tool lifecycle-arg install false /workspace /workspace bun/mars lifecycle-arg",
  )
  expect(await runtime.vfs.readFile("/workspace/node_modules/.bin/mars-bin-tool", "utf8")).toBe(
    "bun run /workspace/node_modules/bin-provider/bin/tool.js\n",
  )

  await runtime.dispose()
})

test("Phase 2 shell bun install fails when lifecycle script fails", async () => {
  const runtime = await createMarsRuntime({ packageCache: createMemoryPackageCache() })
  await runtime.vfs.writeFile("/workspace/package.json", JSON.stringify({
    scripts: {
      install: "missing-lifecycle-command",
    },
  }))

  const result = await runtime.shell.run("bun install")

  expect(result.code).toBe(127)
  expect(result.stderr).toContain("missing-lifecycle-command: command not found")
  expect(result.stderr).toContain("root install failed with exit code 127")

  await runtime.dispose()
})

test("Phase 2 installer extracts PAX tar paths and ignores unsafe entries", async () => {
  const runtime = await createMarsRuntime()
  const tarball = createTarArchive([
    {
      path: "package/index.js",
      content: "module.exports = 'safe'",
    },
    {
      path: "PaxHeader",
      content: createPaxLine("path", "package/lib/from-pax.js"),
      typeFlag: "x",
    },
    {
      path: "package/placeholder.js",
      content: "module.exports = 'from-pax'",
    },
    {
      path: "package/bin/safe-link.js",
      content: "",
      typeFlag: "2",
      linkName: "../index.js",
    },
    {
      path: "PaxHeader",
      content: createPaxLine("linkpath", "../lib/from-pax.js"),
      typeFlag: "x",
    },
    {
      path: "package/bin/pax-link.js",
      content: "",
      typeFlag: "2",
      linkName: "ignored.js",
    },
    {
      path: "package/../escape.js",
      content: "module.exports = 'escape'",
    },
    {
      path: "/absolute.js",
      content: "module.exports = 'absolute'",
    },
    {
      path: "package/unsafe-link.js",
      content: "",
      typeFlag: "2",
      linkName: "../escape.js",
    },
  ])
  const packageCache = createMemoryPackageCache({
    metadata: [
      {
        name: "pax-demo",
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            tarballKey: "pax-demo-1.0.0.tgz",
          },
        },
      },
    ],
    tarballs: {
      "pax-demo-1.0.0.tgz": tarball,
    },
  })
  const installer = createMarsInstaller({ vfs: runtime.vfs, cache: packageCache })

  await installer.install({
    cwd: "/workspace",
    dependencies: {
      "pax-demo": "latest",
    },
    offline: true,
  })

  expect(await runtime.vfs.readFile("/workspace/node_modules/pax-demo/index.js", "utf8")).toBe(
    "module.exports = 'safe'",
  )
  expect(await runtime.vfs.readFile("/workspace/node_modules/pax-demo/lib/from-pax.js", "utf8")).toBe(
    "module.exports = 'from-pax'",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/pax-demo/bin/safe-link.js").isSymbolicLink()).toBe(true)
  expect(runtime.vfs.readlinkSync("/workspace/node_modules/pax-demo/bin/safe-link.js")).toBe(
    "/workspace/node_modules/pax-demo/index.js",
  )
  expect(await runtime.vfs.readFile("/workspace/node_modules/pax-demo/bin/safe-link.js", "utf8")).toBe(
    "module.exports = 'safe'",
  )
  expect(runtime.vfs.lstatSync("/workspace/node_modules/pax-demo/bin/pax-link.js").isSymbolicLink()).toBe(true)
  expect(runtime.vfs.readlinkSync("/workspace/node_modules/pax-demo/bin/pax-link.js")).toBe(
    "/workspace/node_modules/pax-demo/lib/from-pax.js",
  )
  expect(runtime.vfs.existsSync("/workspace/node_modules/pax-demo/escape.js")).toBe(false)
  expect(runtime.vfs.existsSync("/workspace/node_modules/pax-demo/absolute.js")).toBe(false)
  expect(runtime.vfs.existsSync("/workspace/node_modules/pax-demo/unsafe-link.js")).toBe(false)

  await runtime.dispose()
})

function createVersionedPackage(name: string, versions: string[]) {
  const latest = versions.at(-1) ?? "0.0.0"

  return {
    name,
    distTags: { latest },
    versions: Object.fromEntries(
      versions.map(version => [
        version,
        {
          version,
          files: {
            "index.js": `module.exports = ${JSON.stringify({ version })}`,
          },
        },
      ]),
    ),
  }
}

interface TarArchiveEntry {
  path: string
  content: string
  typeFlag?: string
  linkName?: string
}

function createTarArchive(entries: TarArchiveEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []

  for (const entry of entries) {
    const body = encoder.encode(entry.content)
    const header = new Uint8Array(512)
    writeTarString(header, 0, 100, entry.path)
    writeTarString(header, 100, 8, "0000644")
    writeTarString(header, 108, 8, "0000000")
    writeTarString(header, 116, 8, "0000000")
    writeTarString(header, 124, 12, body.byteLength.toString(8).padStart(11, "0"))
    writeTarString(header, 136, 12, "00000000000")
    header.fill(32, 148, 156)
    header[156] = (entry.typeFlag ?? "0").charCodeAt(0)
    if (entry.linkName) writeTarString(header, 157, 100, entry.linkName)
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

function createPaxLine(key: string, value: string): string {
  let line = `0 ${key}=${value}\n`
  while (true) {
    const byteLength = new TextEncoder().encode(line).byteLength
    const nextLine = `${byteLength} ${key}=${value}\n`
    if (nextLine === line) return line
    line = nextLine
  }
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