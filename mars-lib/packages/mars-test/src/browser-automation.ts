import { createBrowserAutomationProfiles } from "./browser-profiles"

import type { MarsRuntimeCapabilities } from "@mars/kernel"
import type { BrowserAutomationProfileId, BrowserEngine } from "./browser-profiles"

export interface BrowserAutomationRunTarget {
  profileId: BrowserAutomationProfileId
  engine: BrowserEngine
  enabled: boolean
  notes: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface BrowserAutomationRunPlanOptions {
  capabilities?: MarsRuntimeCapabilities
  includeDisabled?: boolean
  command?: string
  baseArgs?: string[]
  env?: Record<string, string>
}

export interface BrowserAutomationExecutionOutput {
  exitCode: number
  stdout?: string
  stderr?: string
}

export interface BrowserAutomationExecutionResult {
  profileId: BrowserAutomationProfileId
  engine: BrowserEngine
  command: string
  args: string[]
  env: Record<string, string>
  exitCode: number
  passed: boolean
  durationMs: number
  stdout: string
  stderr: string
}

export interface BrowserAutomationRunSummary {
  passed: boolean
  results: BrowserAutomationExecutionResult[]
}

export interface BrowserAutomationExecutor {
  execute(target: BrowserAutomationRunTarget): Promise<BrowserAutomationExecutionOutput>
}

export interface RunBrowserAutomationPlanOptions {
  executor: BrowserAutomationExecutor
  targets?: BrowserAutomationRunTarget[]
  plan?: BrowserAutomationRunPlanOptions
  stopOnFailure?: boolean
}

interface BunSpawnSubprocess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
}

interface BunScope {
  Bun?: {
    spawn(options: {
      cmd: string[]
      cwd?: string
      env?: Record<string, string>
      stdout: "pipe"
      stderr: "pipe"
    }): BunSpawnSubprocess
  }
}

export interface BunSpawnBrowserAutomationExecutorOptions {
  scope?: BunScope
  cwd?: string
}

export function createBrowserAutomationRunPlan(
  options: BrowserAutomationRunPlanOptions = {},
): BrowserAutomationRunTarget[] {
  const profiles = createBrowserAutomationProfiles(options.capabilities)
  const command = options.command ?? "playwright"
  const baseArgs = options.baseArgs ?? ["test"]
  const env = options.env ?? {}

  return profiles
    .filter(profile => options.includeDisabled || profile.enabled)
    .map(profile => ({
      profileId: profile.id,
      engine: profile.engine,
      enabled: profile.enabled,
      notes: profile.notes,
      command,
      args: [
        ...baseArgs,
        `--project=${profile.engine}`,
        `--grep=${profile.id}`,
      ],
      env: {
        ...env,
        MARS_BROWSER_PROFILE: profile.id,
      },
    }))
}

export async function runBrowserAutomationPlan(
  options: RunBrowserAutomationPlanOptions,
): Promise<BrowserAutomationRunSummary> {
  const targets = options.targets ?? createBrowserAutomationRunPlan(options.plan)
  const results: BrowserAutomationExecutionResult[] = []

  for (const target of targets) {
    const startedAt = performance.now()
    const output = await options.executor.execute(target)
    const result: BrowserAutomationExecutionResult = {
      profileId: target.profileId,
      engine: target.engine,
      command: target.command,
      args: target.args,
      env: target.env,
      exitCode: output.exitCode,
      passed: output.exitCode === 0,
      durationMs: performance.now() - startedAt,
      stdout: output.stdout ?? "",
      stderr: output.stderr ?? "",
    }

    results.push(result)
    if (!result.passed && options.stopOnFailure) break
  }

  return {
    passed: results.every(result => result.passed),
    results,
  }
}

export function createBunSpawnBrowserAutomationExecutor(
  options: BunSpawnBrowserAutomationExecutorOptions = {},
): BrowserAutomationExecutor {
  const scope = options.scope ?? (globalThis as BunScope)

  return {
    execute: async target => {
      const bun = scope.Bun
      if (!bun) {
        return {
          exitCode: 1,
          stderr: "Bun runtime is not available for browser automation execution",
        }
      }

      const process = bun.spawn({
        cmd: [target.command, ...target.args],
        cwd: options.cwd,
        env: target.env,
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])

      return {
        exitCode,
        stdout,
        stderr,
      }
    },
  }
}