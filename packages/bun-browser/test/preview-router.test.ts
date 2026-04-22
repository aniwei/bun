/**
 * Phase 3 T3.1 单元测试：预览 URL 解析 + 端口注册表。
 */

import { describe, expect, test } from 'bun:test'
import {
  PREVIEW_PATH_PREFIX,
  PreviewPortRegistry,
  buildPreviewBasePath,
  buildPreviewUrl,
  parsePreviewUrl,
} from '../src/preview-router'

describe('parsePreviewUrl', () => {
  test('常规路径：解析端口 + 转发 URL', () => {
    const r = parsePreviewUrl('https://app.example.com/__bun_preview__/40123/api/hello')
    expect(r).not.toBeNull()
    expect(r!.port).toBe(40123)
    expect(r!.forwardUrl).toBe('http://localhost:40123/api/hello')
    expect(r!.path).toBe('/api/hello')
  })

  test('带 query + hash', () => {
    const r = parsePreviewUrl('https://x/__bun_preview__/41000/users?id=1#top')
    expect(r).not.toBeNull()
    expect(r!.forwardUrl).toBe('http://localhost:41000/users?id=1#top')
    expect(r!.path).toBe('/users?id=1')
  })

  test('端口后无路径：补 /', () => {
    const r = parsePreviewUrl('https://x/__bun_preview__/40001')
    expect(r).not.toBeNull()
    expect(r!.port).toBe(40001)
    expect(r!.forwardUrl).toBe('http://localhost:40001/')
  })

  test('端口后只有 /', () => {
    const r = parsePreviewUrl('https://x/__bun_preview__/40001/')
    expect(r).not.toBeNull()
    expect(r!.forwardUrl).toBe('http://localhost:40001/')
  })

  test('非预览前缀返回 null', () => {
    expect(parsePreviewUrl('https://x/index.html')).toBeNull()
    expect(parsePreviewUrl('https://x/__bun_preview/40123/')).toBeNull()
  })

  test('端口非数字返回 null', () => {
    expect(parsePreviewUrl('https://x/__bun_preview__/abc/')).toBeNull()
  })

  test('端口越界返回 null', () => {
    expect(parsePreviewUrl('https://x/__bun_preview__/0/')).toBeNull()
    expect(parsePreviewUrl('https://x/__bun_preview__/99999/')).toBeNull()
  })

  test('支持传入 URL 对象', () => {
    const r = parsePreviewUrl(new URL('https://x/__bun_preview__/40123/api'))
    expect(r).not.toBeNull()
    expect(r!.port).toBe(40123)
  })
})

describe('buildPreview*', () => {
  test('buildPreviewBasePath', () => {
    expect(buildPreviewBasePath(40123)).toBe('/__bun_preview__/40123/')
  })

  test('buildPreviewBasePath 越界抛错', () => {
    expect(() => buildPreviewBasePath(0)).toThrow()
    expect(() => buildPreviewBasePath(99999)).toThrow()
  })

  test('buildPreviewUrl：origin 带 / 也正确', () => {
    expect(buildPreviewUrl('http://localhost:5173/', 40001, '/api/x')).toBe(
      'http://localhost:5173/__bun_preview__/40001/api/x',
    )
    expect(buildPreviewUrl('http://localhost:5173', 40001)).toBe('http://localhost:5173/__bun_preview__/40001/')
  })

  test('前缀常量对齐', () => {
    expect(PREVIEW_PATH_PREFIX).toBe('/__bun_preview__/')
  })
})

describe('PreviewPortRegistry', () => {
  test('add/remove/list 基本行为', () => {
    const r = new PreviewPortRegistry()
    expect(r.list()).toEqual([])
    r.add(40001)
    r.add(40003)
    r.add(40002)
    r.add(40001) // 去重
    expect(r.list()).toEqual([40001, 40002, 40003])
    expect(r.has(40002)).toBe(true)
    expect(r.remove(40002)).toBe(true)
    expect(r.remove(40002)).toBe(false)
    expect(r.list()).toEqual([40001, 40003])
  })

  test('onChange 在 add/remove 时触发，去重不触发', () => {
    const r = new PreviewPortRegistry()
    const events: number[][] = []
    const off = r.onChange(ps => events.push(ps))
    r.add(40001)
    r.add(40001) // 重复，不触发
    r.add(40002)
    r.remove(40003) // 不存在，不触发
    r.remove(40001)
    off()
    r.add(40010) // 已取消订阅，不应再记录
    expect(events).toEqual([[40001], [40001, 40002], [40002]])
  })
})
