import { describe, expect, test } from 'vitest'
import { createSQLiteDatabase } from '../../../packages/bun-web-sqlite/src/sqlite'
import {
  CryptoHasher,
  hashHex,
  passwordHash,
  passwordVerify,
} from '../../../packages/bun-web-crypto/src/index'

describe('M6 sqlite and crypto baseline', () => {
  test('sqlite memory database supports create/insert/select/serialize', () => {
    const db = createSQLiteDatabase()

    db.exec('CREATE TABLE users (id INTEGER, name TEXT)')
    db.run('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'alice'])
    db.run('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'bob'])

    const row = db.get('SELECT * FROM users WHERE id = ?', [2])
    const rows = db.all('SELECT * FROM users')

    expect(row).toEqual({ id: 2, name: 'bob' })
    expect(rows).toHaveLength(2)
    expect(db.serialize().byteLength).toBeGreaterThan(0)

    db.close()
  })

  test('crypto hasher and password verify work', async () => {
    const hasher = new CryptoHasher('sha256')
    hasher.update('m6')
    const digest = hasher.digest('hex')

    const hex = await hashHex('m6', 'SHA-256')
    const hashedPassword = await passwordHash('secret-m6')

    expect(digest).toHaveLength(64)
    expect(hex).toHaveLength(64)
    expect(await passwordVerify('secret-m6', hashedPassword)).toBe(true)
    expect(await passwordVerify('bad-password', hashedPassword)).toBe(false)
  })
})
