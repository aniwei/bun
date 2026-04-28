import { test, expect } from "bun:test"
import { createMarsRuntime, HookRegistry } from "@mars/client"

test("globals.install hook can intercept and modify global context", async () => {
  const hooks = new HookRegistry()
  let hookExecuted = false
  let contextModified = false

  // Register interceptor hook to modify global context
  hooks.on("globals.install", "test-interceptor", (context, output) => {
    hookExecuted = true
    // Can modify runtime features dynamically
    ;(output as any).runtimeFeatures.sql = false
    contextModified = true
  }, 10)

  const runtime = await createMarsRuntime({ hooks, runtimeFeatures: { sql: true } })

  expect(hookExecuted).toBe(true)
  expect(contextModified).toBe(true)
  // Hook modification is effective - sql was disabled by the hook
  expect(runtime.runtimeFeatures.sql).toBe(false)

  await runtime.dispose()
})

test("globals.installed hook observes after global installation", async () => {
  const hooks = new HookRegistry()
  let installedHookFired = false

  hooks.on("globals.installed", "test-observer", async () => {
    installedHookFired = true
  })

  const runtime = await createMarsRuntime({ hooks })

  expect(installedHookFired).toBe(true)

  await runtime.dispose()
})

test("hook errors are isolated and do not break boot", async () => {
  const hooks = new HookRegistry()

  // Register a hook that throws
  hooks.on("globals.install", "bad-hook", () => {
    throw new Error("Intentional hook failure")
  }, 5)

  // Register a good hook that should still execute
  let goodHookRan = false
  hooks.on("globals.install", "good-hook", () => {
    goodHookRan = true
  }, 20)

  // Boot should succeed despite the bad hook
  const runtime = await createMarsRuntime({ hooks })

  expect(goodHookRan).toBe(true)
  expect(runtime.bun.version).toBeDefined()

  await runtime.dispose()
})

test("hook priority order is respected", async () => {
  const hooks = new HookRegistry()
  const executionOrder: string[] = []

  hooks.on("globals.install", "first", () => {
    executionOrder.push("first")
  }, 10)

  hooks.on("globals.install", "second", () => {
    executionOrder.push("second")
  }, 20)

  hooks.on("globals.install", "third", () => {
    executionOrder.push("third")
  }, 15)

  const runtime = await createMarsRuntime({ hooks })

  expect(executionOrder).toEqual(["first", "third", "second"])

  await runtime.dispose()
})
