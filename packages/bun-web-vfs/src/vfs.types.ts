export interface FileStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtime: Date
  atime: Date
  ctime: Date
}

export interface Dirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type WatchEvent = 'change' | 'rename'
export type WatchListener = (event: WatchEvent, filename: string) => void

export interface WatchHandle {
  close(): void
}
