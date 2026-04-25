import type { BuildOptions, BuildResult } from './build'
import type { Plugin as EsbuildPlugin } from 'esbuild-wasm'

export type BuildTarget = 'browser' | 'node' | 'bun'

export interface BuildPluginContext {
  options: BuildOptions
}

export interface BuildPluginAfterContext extends BuildPluginContext {
  result: BuildResult
}

export interface WebBuildPlugin {
  name: string
  target?: BuildTarget
  setup?: EsbuildPlugin['setup']
  beforeBuild?: (context: BuildPluginContext) => void | Promise<void>
  afterBuild?: (context: BuildPluginAfterContext) => void | Promise<void>
}

export interface PluginExecutionPlan {
  esbuildPlugins: EsbuildPlugin[]
  beforeBuildHooks: Array<(context: BuildPluginContext) => void | Promise<void>>
  afterBuildHooks: Array<(context: BuildPluginAfterContext) => void | Promise<void>>
}

function matchesTarget(plugin: WebBuildPlugin, target: BuildTarget | undefined): boolean {
  if (!plugin.target || !target) {
    return true
  }

  return plugin.target === target
}

export function createPluginExecutionPlan(
  plugins: WebBuildPlugin[] | undefined,
  target: BuildTarget | undefined,
): PluginExecutionPlan {
  const esbuildPlugins: EsbuildPlugin[] = []
  const beforeBuildHooks: Array<(context: BuildPluginContext) => void | Promise<void>> = []
  const afterBuildHooks: Array<(context: BuildPluginAfterContext) => void | Promise<void>> = []

  for (const plugin of plugins ?? []) {
    if (!matchesTarget(plugin, target)) {
      continue
    }

    if (plugin.setup) {
      esbuildPlugins.push({
        name: plugin.name,
        setup: plugin.setup,
      })
    }

    if (plugin.beforeBuild) {
      beforeBuildHooks.push(plugin.beforeBuild)
    }

    if (plugin.afterBuild) {
      afterBuildHooks.push(plugin.afterBuild)
    }
  }

  return {
    esbuildPlugins,
    beforeBuildHooks,
    afterBuildHooks,
  }
}