import type { HookSpec } from './hooks.types'

export type HookPreset = 'none' | 'minimal' | 'default'

export function getPresetHooks(preset: HookPreset): HookSpec[] {
  // 'none' と 'minimal' はデフォルト追加なし；'default' はシステムフック追加予定
  switch (preset) {
    case 'none':
    case 'minimal':
      return []
    case 'default':
      // 将来可在此注入平台默认 hook（如：kernel 启动日志、process spawn 追踪）
      return []
    default: {
      const _exhaust: never = preset
      return []
    }
  }
}
