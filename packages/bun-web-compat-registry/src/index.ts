// @mars/web-compat-registry – 公共导出

// 类型
export type {
  CompatLevel,
  CompatEntry,
  ValidationResult,
} from './compat.types'

// 级别工具
export {
  COMPAT_LEVELS,
  isCompatLevel,
  isDegradation,
  compareByLevel,
} from './levels'

// 核心注册表 + 错误类
export {
  CompatRegistry,
  MarsWebUnsupportedError,
} from './registry'

// build-time 扫描器
export { scanDtsContent } from './scanner'
