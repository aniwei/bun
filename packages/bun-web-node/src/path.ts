function stripTrailingSeparators(input: string, sep: string): string {
  let value = input
  while (value.length > 1 && value.endsWith(sep)) {
    value = value.slice(0, -1)
  }
  return value
}

function normalizePosix(path: string): string {
  if (path.length === 0) {
    return '.'
  }

  const isAbsolute = path.startsWith('/')
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const stack: string[] = []

  for (const segment of segments) {
    if (segment === '.') {
      continue
    }

    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop()
      } else if (!isAbsolute) {
        stack.push('..')
      }
      continue
    }

    stack.push(segment)
  }

  const normalized = stack.join('/')
  if (isAbsolute) {
    return normalized.length > 0 ? `/${normalized}` : '/'
  }

  return normalized.length > 0 ? normalized : '.'
}

function dirnamePosix(path: string): string {
  if (path.length === 0) {
    return '.'
  }

  const normalized = stripTrailingSeparators(path, '/')
  if (normalized === '/') {
    return '/'
  }

  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) {
    return '.'
  }

  if (lastSlash === 0) {
    return '/'
  }

  return normalized.slice(0, lastSlash)
}

function basenamePosix(path: string, suffix?: string): string {
  if (path.length === 0) {
    return ''
  }

  const normalized = stripTrailingSeparators(path, '/')
  const lastSlash = normalized.lastIndexOf('/')
  let base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)

  if (suffix && base.endsWith(suffix)) {
    base = base.slice(0, -suffix.length)
  }

  return base
}

function extnamePosix(path: string): string {
  const base = basenamePosix(path)
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0) {
    return ''
  }
  return base.slice(lastDot)
}

function resolvePosix(...paths: string[]): string {
  const filtered = paths.filter((item) => item.length > 0)
  let resolved = ''

  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const item = filtered[i]
    resolved = `${item}/${resolved}`
    if (item.startsWith('/')) {
      break
    }
  }

  if (!resolved.startsWith('/')) {
    resolved = `/${resolved}`
  }

  return normalizePosix(resolved)
}

function relativePosix(from: string, to: string): string {
  const fromParts = resolvePosix(from).split('/').filter(Boolean)
  const toParts = resolvePosix(to).split('/').filter(Boolean)

  let shared = 0
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1
  }

  const up = Array.from({ length: fromParts.length - shared }, () => '..')
  const down = toParts.slice(shared)
  const result = [...up, ...down].join('/')
  return result.length > 0 ? result : ''
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function toWin32Path(path: string): string {
  return path.replace(/\//g, '\\')
}

function getWin32DrivePrefix(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    return `${path.slice(0, 2)}\\`
  }
  return ''
}

function normalizeWin32(path: string): string {
  if (path.length === 0) {
    return '.'
  }

  const drive = getWin32DrivePrefix(path)
  const body = drive.length > 0 ? path.slice(3) : path
  const normalizedBody = normalizePosix(toPosixPath(body))
  const winBody = toWin32Path(normalizedBody)

  if (drive.length > 0) {
    return `${drive}${winBody === '.' ? '' : winBody}`.replace(/\\$/, '') || drive
  }

  return winBody
}

function resolveWin32(...paths: string[]): string {
  let drive = ''
  let joined = ''

  for (let i = paths.length - 1; i >= 0; i -= 1) {
    const item = paths[i]
    if (!item) {
      continue
    }

    if (drive.length === 0) {
      const detected = getWin32DrivePrefix(item)
      if (detected.length > 0) {
        drive = detected
      }
    }

    joined = `${item}\\${joined}`
    if (item.startsWith('\\') || getWin32DrivePrefix(item).length > 0) {
      break
    }
  }

  const normalized = normalizeWin32(joined)
  if (getWin32DrivePrefix(normalized).length > 0 || normalized.startsWith('\\')) {
    return normalized
  }

  return drive.length > 0 ? normalizeWin32(`${drive}${normalized}`) : normalizeWin32(`\\${normalized}`)
}

function relativeWin32(from: string, to: string): string {
  const fromResolved = toPosixPath(resolveWin32(from)).toLowerCase()
  const toResolved = toPosixPath(resolveWin32(to)).toLowerCase()

  const fromParts = fromResolved.split('/').filter(Boolean)
  const toParts = toResolved.split('/').filter(Boolean)

  let shared = 0
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1
  }

  const up = Array.from({ length: fromParts.length - shared }, () => '..')
  const down = toParts.slice(shared)
  const result = [...up, ...down].join('\\')
  return result.length > 0 ? result : ''
}

export interface MarsWebPath {
  sep: string
  delimiter: string
  normalize(path: string): string
  join(...paths: string[]): string
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  dirname(path: string): string
  basename(path: string, suffix?: string): string
  extname(path: string): string
  isAbsolute(path: string): boolean
  parse(path: string): { root: string; dir: string; base: string; ext: string; name: string }
  format(obj: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string
  toNamespacedPath(path: string): string
}

function parsePosix(
  p: string,
): { root: string; dir: string; base: string; ext: string; name: string } {
  const root = p.startsWith('/') ? '/' : ''
  const base = basenamePosix(p)
  const ext = extnamePosix(p)
  const name = ext.length > 0 ? base.slice(0, -ext.length) : base
  const dir = dirnamePosix(p)
  return { root, dir, base, ext, name }
}

function formatPosix(obj: {
  root?: string
  dir?: string
  base?: string
  ext?: string
  name?: string
}): string {
  const dir = obj.dir ?? obj.root ?? ''
  const base = obj.base ?? `${obj.name ?? ''}${obj.ext ?? ''}`
  if (!dir) return base
  if (dir.endsWith('/')) return `${dir}${base}`
  return `${dir}/${base}`
}

function parseWin32(
  p: string,
): { root: string; dir: string; base: string; ext: string; name: string } {
  const drive = getWin32DrivePrefix(p)
  const root = drive || (p.startsWith('\\') ? '\\' : '')
  const normalized = toPosixPath(p)
  const base = basenamePosix(normalized)
  const ext = extnamePosix(base)
  const name = ext.length > 0 ? base.slice(0, -ext.length) : base
  const dir = toWin32Path(dirnamePosix(normalized))
  return { root, dir, base, ext, name }
}

function formatWin32(obj: {
  root?: string
  dir?: string
  base?: string
  ext?: string
  name?: string
}): string {
  const dir = obj.dir ?? obj.root ?? ''
  const base = obj.base ?? `${obj.name ?? ''}${obj.ext ?? ''}`
  if (!dir) return base
  if (dir.endsWith('\\') || dir.endsWith('/')) return `${dir}${base}`
  return `${dir}\\${base}`
}

export const posix: MarsWebPath = {
  sep: '/',
  delimiter: ':',
  normalize: normalizePosix,
  join: (...paths: string[]) => normalizePosix(paths.filter(Boolean).join('/')),
  resolve: (...paths: string[]) => resolvePosix(...paths),
  relative: (from: string, to: string) => relativePosix(from, to),
  dirname: (path: string) => dirnamePosix(path),
  basename: (path: string, suffix?: string) => basenamePosix(path, suffix),
  extname: (path: string) => extnamePosix(path),
  isAbsolute: (path: string) => path.startsWith('/'),
  parse: parsePosix,
  format: formatPosix,
  toNamespacedPath: (path: string) => path,
}

export const win32: MarsWebPath = {
  sep: '\\',
  delimiter: ';',
  normalize: normalizeWin32,
  join: (...paths: string[]) => normalizeWin32(paths.filter(Boolean).join('\\')),
  resolve: (...paths: string[]) => resolveWin32(...paths),
  relative: (from: string, to: string) => relativeWin32(from, to),
  dirname: (path: string) => toWin32Path(dirnamePosix(toPosixPath(path))),
  basename: (path: string, suffix?: string) => basenamePosix(toPosixPath(path), suffix),
  extname: (path: string) => extnamePosix(toPosixPath(path)),
  isAbsolute: (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\'),
  parse: parseWin32,
  format: formatWin32,
  toNamespacedPath: (path: string) => path,
}

export const path: MarsWebPath & { posix: MarsWebPath; win32: MarsWebPath } = {
  ...posix,
  posix,
  win32,
}

export default path
