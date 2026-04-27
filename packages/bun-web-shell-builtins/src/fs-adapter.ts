import type { BuiltinFS, DirectoryNode, FSNode } from './types'

function normalize(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  return withLeading.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function split(path: string): string[] {
  return normalize(path)
    .split('/')
    .filter(Boolean)
}

function resolveNode(root: DirectoryNode, path: string): FSNode {
  const parts = split(path)
  let current: FSNode = root

  for (const part of parts) {
    if (current.kind !== 'dir') {
      throw new Error(`Not a directory: ${path}`)
    }
    const next = current.children[part]
    if (!next) {
      throw new Error(`No such file or directory: ${path}`)
    }
    current = next
  }

  return current
}

function walkNode(path: string, node: FSNode, out: string[]): void {
  if (node.kind === 'file') {
    out.push(path)
    return
  }

  for (const [name, child] of Object.entries(node.children)) {
    const childPath = path === '/' ? `/${name}` : `${path}/${name}`
    walkNode(childPath, child, out)
  }
}

export function createInMemoryFS(root: DirectoryNode): BuiltinFS {
  return {
    readFile(path: string): string {
      const node = resolveNode(root, path)
      if (node.kind !== 'file') {
        throw new Error(`Is a directory: ${path}`)
      }
      return node.content
    },
    listDir(path: string): string[] {
      const node = resolveNode(root, path)
      if (node.kind !== 'dir') {
        throw new Error(`Not a directory: ${path}`)
      }
      return Object.keys(node.children).sort()
    },
    isDirectory(path: string): boolean {
      const node = resolveNode(root, path)
      return node.kind === 'dir'
    },
    walk(path: string): string[] {
      const node = resolveNode(root, path)
      const out: string[] = []
      walkNode(normalize(path), node, out)
      return out.sort()
    },
  }
}
