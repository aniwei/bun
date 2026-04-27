import { describe, expect, test } from 'vitest'

import {
  downloadTarball,
  extractTarball,
  verifyIntegrity,
} from '../../../packages/bun-web-installer/src/tarball'

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number): void {
  const octal = value.toString(8).padStart(width - 1, '0')
  writeAscii(target, offset, octal)
  target[offset + width - 1] = 0
}

function createTar(entries: Array<{ path: string; data?: string; type?: 'file' | 'directory' }>): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    const isDir = entry.type === 'directory'
    const content = isDir ? new Uint8Array() : new TextEncoder().encode(entry.data ?? '')
    const header = new Uint8Array(512)

    const normalizedPath = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
    writeAscii(header, 0, normalizedPath)
    writeOctal(header, 100, 8, isDir ? 0o755 : 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, content.length)
    writeOctal(header, 136, 12, 0)
    header[156] = isDir ? '5'.charCodeAt(0) : '0'.charCodeAt(0)
    writeAscii(header, 257, 'ustar\0')
    writeAscii(header, 263, '00')

    for (let i = 148; i < 156; i++) {
      header[i] = 0x20
    }

    let checksum = 0
    for (let i = 0; i < header.length; i++) {
      checksum += header[i]
    }
    const checksumText = checksum.toString(8).padStart(6, '0')
    writeAscii(header, 148, checksumText)
    header[154] = 0
    header[155] = 0x20

    blocks.push(header)

    if (content.length > 0) {
      blocks.push(content)
      const remainder = content.length % 512
      if (remainder !== 0) {
        blocks.push(new Uint8Array(512 - remainder))
      }
    }
  }

  blocks.push(new Uint8Array(512), new Uint8Array(512))

  const total = blocks.reduce((sum, item) => sum + item.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

function toStrictUint8Array(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength)
  out.set(input)
  return out
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const compression = new CompressionStream('gzip')
  const writer = compression.writable.getWriter()
  await writer.write(toStrictUint8Array(data))
  await writer.close()
  return new Uint8Array(await new Response(compression.readable).arrayBuffer())
}

async function toSRI(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-512', toStrictUint8Array(data))
  return `sha512-${Buffer.from(digest).toString('base64')}`
}

describe('bun-web M3 installer tarball', () => {
  test('downloadTarball downloads bytes and validates integrity', async () => {
    const tar = createTar([{ path: 'package/package.json', data: '{"name":"demo"}' }])
    const tgz = await gzip(tar)
    const integrity = await toSRI(tgz)

    const downloaded = await downloadTarball('https://registry.example.com/demo/-/demo-1.0.0.tgz', {
      integrity,
      fetchFn: async () => new Response(toStrictUint8Array(tgz), { status: 200 }),
    })

    expect(downloaded).toEqual(tgz)
  })

  test('downloadTarball throws when response is non-ok', async () => {
    await expect(
      downloadTarball('https://registry.example.com/demo/-/demo-1.0.0.tgz', {
        fetchFn: async () => new Response('not found', { status: 404, statusText: 'Not Found' }),
      }),
    ).rejects.toThrow('Failed to download tarball: 404 Not Found')
  })

  test('verifyIntegrity throws on mismatch', async () => {
    const data = new TextEncoder().encode('hello')
    await expect(verifyIntegrity(data, 'sha512-invalid')).rejects.toThrow('Integrity mismatch for sha512')
  })

  test('extractTarball extracts gzip tar entries', async () => {
    const tar = createTar([
      { path: 'package/', type: 'directory' },
      { path: 'package/index.js', data: 'console.log("ok")' },
      { path: 'package/package.json', data: '{"name":"demo"}' },
    ])
    const tgz = await gzip(tar)

    const extracted = await extractTarball(tgz)

    const pkgJson = extracted.get('package/package.json')
    const indexJs = extracted.get('package/index.js')
    const pkgDir = extracted.get('package')

    expect(pkgDir?.type).toBe('directory')
    expect(new TextDecoder().decode(pkgJson?.data)).toBe('{"name":"demo"}')
    expect(new TextDecoder().decode(indexJs?.data)).toBe('console.log("ok")')
  })
})