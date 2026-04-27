import { createBunFile } from "./bun-file"
import { bunBuild } from "./bun-build"
import { bunServe } from "./bun-serve"
import { bunWrite } from "./bun-write"

import type { MarsBun, RuntimeContext } from "./types"

export function createMarsBun(context: RuntimeContext): MarsBun {
  return {
    version: "0.0.0-mars-m1",
    env: context.env ?? {},
    file: (path, options) => createBunFile(context, path, options),
    write: (destination, input) => bunWrite(context, destination, input),
    serve: options => bunServe(context, options),
    build: options => bunBuild(context, options),
    fetch: (input, init) => globalThis.fetch(input, init),
  }
}

export function installBunGlobal(context: RuntimeContext): MarsBun {
  const marsBun = createMarsBun(context)
  const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun")

  if (!bunDescriptor) {
    Object.defineProperty(globalThis, "Bun", {
      configurable: true,
      writable: true,
      value: marsBun,
    })
  } else if (bunDescriptor.writable) {
    Object.assign(globalThis, { Bun: marsBun })
  }

  if (!("process" in globalThis)) {
    Object.defineProperty(globalThis, "process", {
      configurable: true,
      writable: true,
      value: {
        env: marsBun.env,
        cwd: () => context.vfs.cwd(),
      },
    })
  }

  return marsBun
}