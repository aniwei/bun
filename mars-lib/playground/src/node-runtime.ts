import { createMemoryPackageCacheFromFixture } from "@mars/installer"

import type { FileTree } from "@mars/vfs"
import type { PackageCache, PackageCacheFixtureManifest } from "@mars/installer"

export type PlaygroundName =
  | "vfs-shell"
  | "bun-file"
  | "bun-serve"
  | "node-http"
  | "express"
  | "koa"
  | "tsx"
  | "vite-react-ts"
  | "core-transpiler"
  | "core-loader"
  | "core-runtime"
  | "core-runtime-bun-run"
  | "core-installer"
  | "core-bundler"

export interface PlaygroundModuleCase {
  id: string
  phase: string
  module: string
  playground: string
  entry: string
  acceptance: string
  status: "covered" | "partial" | "prework" | "planned" | "smoke"
  description: string
}

export async function loadPlaygroundFiles(name: PlaygroundName): Promise<FileTree> {
  if (name === "vfs-shell") {
    return {
      "runtime-vfs-shell.ts": await readPlaygroundText("core-modules/bun/vfs-shell.ts"),
    }
  }

  if (name === "bun-file") {
    return {
      "bun-file.ts": await readPlaygroundText("core-modules/bun/bun-file.ts"),
    }
  }

  if (name === "bun-serve") {
    return {
      "bun-serve.ts": await readPlaygroundText("core-modules/bun/bun-serve.ts"),
    }
  }

  if (name === "node-http") {
    return {
      "server.ts": await readPlaygroundText("node-http/server.ts"),
    }
  }

  if (name === "express") {
    return {
      "server.ts": await readPlaygroundText("express/server.ts"),
    }
  }

  if (name === "koa") {
    return {
      "server.ts": await readPlaygroundText("koa/server.ts"),
    }
  }

  if (name === "tsx") {
    return {
      "app.tsx": await readPlaygroundText("tsx/app.tsx"),
    }
  }

  if (name === "core-transpiler") {
    return {
      "app.tsx": await readPlaygroundText("core-modules/transpiler/app.tsx"),
      "title.ts": await readPlaygroundText("core-modules/transpiler/title.ts"),
      "message.ts": await readPlaygroundText("core-modules/transpiler/message.ts"),
    }
  }

  if (name === "core-loader") {
    return {
      "entry.tsx": await readPlaygroundText("core-modules/loader/entry.tsx"),
      "title.ts": await readPlaygroundText("core-modules/loader/title.ts"),
      "message.ts": await readPlaygroundText("core-modules/loader/message.ts"),
      "cycle-a.ts": await readPlaygroundText("core-modules/loader/cycle-a.ts"),
      "cycle-b.ts": await readPlaygroundText("core-modules/loader/cycle-b.ts"),
      "config.json": await readPlaygroundText("core-modules/loader/config.json"),
      "feature.cjs": await readPlaygroundText("core-modules/loader/feature.cjs"),
    }
  }

  if (name === "core-runtime") {
    return {
      "run-entry.ts": await readPlaygroundText("core-modules/runtime/run-entry.ts"),
    }
  }

  if (name === "core-runtime-bun-run") {
    return {
      "index.ts": await readPlaygroundText("core-modules/runtime/bun-run-index.ts"),
    }
  }

  if (name === "core-installer") {
    return {
      "dependencies.ts": await readPlaygroundText("core-modules/installer/dependencies.ts"),
    }
  }

  if (name === "core-bundler") {
    return {
      "vite.config.ts": await readPlaygroundText("core-modules/bundler/vite.config.ts"),
      app: {
        src: {
          "App.tsx": await readPlaygroundText("core-modules/bundler/src/App.tsx"),
          "message.ts": await readPlaygroundText("core-modules/bundler/src/message.ts"),
        },
      },
    }
  }

  return {
    "package.json": await readPlaygroundText("vite-react-ts/package.json"),
    "index.html": await readPlaygroundText("vite-react-ts/index.html"),
    "vite.config.ts": await readPlaygroundText("vite-react-ts/vite.config.ts"),
    src: {
      "App.tsx": await readPlaygroundText("vite-react-ts/src/App.tsx"),
    },
  }
}

export async function loadPlaygroundModuleCases(): Promise<PlaygroundModuleCase[]> {
  return JSON.parse(await readPlaygroundText("module-cases.json")) as PlaygroundModuleCase[]
}

export async function loadPlaygroundPackageCache(): Promise<PackageCache> {
  const manifest = JSON.parse(
    await readPlaygroundText("fixtures/npm-cache/metadata.json"),
  ) as PackageCacheFixtureManifest
  const tarballs: Record<string, Uint8Array> = {}

  for (const tarballKey of collectFixtureTarballKeys(manifest)) {
    tarballs[tarballKey] = await readPlaygroundBytes(`fixtures/npm-cache/${tarballKey}`)
  }

  return createMemoryPackageCacheFromFixture(manifest, tarballs)
}

function collectFixtureTarballKeys(manifest: PackageCacheFixtureManifest): string[] {
  const keys = new Set<string>()

  for (const fixture of manifest.packages ?? []) {
    const packageName = typeof fixture === "string" ? fixture : fixture.name
    const version = typeof fixture === "string" ? "0.0.0-mars" : fixture.version ?? "0.0.0-mars"
    const tarballKey = typeof fixture === "string"
      ? `${packageName}-${version}.tgz`
      : fixture.tarballKey ?? `${packageName}-${version}.tgz`
    keys.add(tarballKey)
  }

  for (const metadata of manifest.metadata ?? []) {
    for (const version of Object.values(metadata.versions)) {
      if (version.tarballKey) keys.add(version.tarballKey)
    }
  }

  return [...keys].sort()
}

export function readPlaygroundCaseEntry(entry: string): Promise<string> {
  return readPlaygroundText(entry)
}

export function readPlaygroundText(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text()
}

async function readPlaygroundBytes(path: string): Promise<Uint8Array> {
  const file = Bun.file(new URL(`../${path}`, import.meta.url)) as unknown as { arrayBuffer(): Promise<ArrayBuffer> }
  return new Uint8Array(await file.arrayBuffer())
}
