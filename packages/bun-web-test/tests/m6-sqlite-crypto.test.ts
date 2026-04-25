import { describe, expect, test } from 'vitest'
import {
  createSQLiteDatabase,
  MemorySQLiteDatabase,
  Statement,
  type SQLValue,
  __setWaSQLiteFactory,
  __resetWaSQLiteForTests,
  isWaSQLiteReady,
  initWaSQLiteWasm,
} from '../../../packages/bun-web-sqlite/src/sqlite'
import {
  CryptoHasher,
  bunHash,
  hashHex,
  passwordHash,
  passwordVerify,
} from '../../../packages/bun-web-crypto/src/index'
import { stableSnapshot } from './snapshot-utils'

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

  test('Statement prepare/run/all/get/values/iterate', () => {
    const db = createSQLiteDatabase()
    db.exec('CREATE TABLE items (id INTEGER, label TEXT)')

    const ins = db.prepare<{ id: number; label: string }>('INSERT INTO items (id, label) VALUES (?, ?)')
    const r1 = ins.run(1, 'alpha')
    const r2 = ins.run(2, 'beta')
    const r3 = ins.run(3, 'gamma')

    expect(r1.changes).toBe(1)
    expect(r2.lastInsertRowid).toBe(2)
    expect(r3.lastInsertRowid).toBe(3)

    const sel = db.prepare<{ id: number; label: string }>('SELECT * FROM items')
    const allRows = sel.all()
    expect(allRows).toHaveLength(3)
    expect(allRows[0]).toEqual({ id: 1, label: 'alpha' })

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(2)
    expect(row).toEqual({ id: 2, label: 'beta' })

    const vals = sel.values()
    expect(vals).toHaveLength(3)
    expect(Array.isArray(vals[0])).toBe(true)
    expect(vals[0]).toHaveLength(2)

    const iterated: unknown[] = []
    for (const r of sel.iterate()) {
      iterated.push(r)
    }
    expect(iterated).toHaveLength(3)

    expect(stableSnapshot({ allRows, row, firstValues: vals[0] })).toMatchInlineSnapshot(`
      "{
        \"allRows\": [
          {
            \"id\": 1,
            \"label\": \"alpha\"
          },
          {
            \"id\": 2,
            \"label\": \"beta\"
          },
          {
            \"id\": 3,
            \"label\": \"gamma\"
          }
        ],
        \"firstValues\": [
          1,
          \"alpha\"
        ],
        \"row\": {
          \"id\": 2,
          \"label\": \"beta\"
        }
      }"
    `)
  })

  test('Statement.toString returns the SQL', () => {
    const db = createSQLiteDatabase()
    const sql = 'SELECT * FROM something'
    const stmt = db.prepare(sql)
    expect(stmt.toString()).toBe(sql)
  })

  test('Database.query is alias of prepare', () => {
    const db = createSQLiteDatabase()
    db.exec('CREATE TABLE t (x INTEGER)')
    const stmt = db.query('SELECT * FROM t')
    expect(stmt).toBeInstanceOf(Statement)
  })

  test('Database.transaction wraps fn and tracks inTransaction', () => {
    const db = createSQLiteDatabase()
    db.exec('CREATE TABLE logs (msg TEXT)')

    expect(db.inTransaction).toBe(false)

    const transact = db.transaction((msg: string) => {
      expect(db.inTransaction).toBe(true)
      db.run('INSERT INTO logs (msg) VALUES (?)', [msg])
    })

    transact('hello')
    expect(db.inTransaction).toBe(false)
    expect(db.all('SELECT * FROM logs')).toHaveLength(1)
  })

  test('Database.filename reflects constructor arg', () => {
    const mem = createSQLiteDatabase(':memory:')
    expect(mem.filename).toBe(':memory:')

    const named = MemorySQLiteDatabase.open('/tmp/test.db')
    expect(named.filename).toBe('/tmp/test.db')
  })

  test('Database.deserialize round-trips serialize output', () => {
    const db = createSQLiteDatabase()
    db.exec('CREATE TABLE kv (k TEXT, v TEXT)')
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['foo', 'bar'])

    const bytes = db.serialize()
    const db2 = MemorySQLiteDatabase.deserialize(bytes)
    const row = db2.get('SELECT * FROM kv WHERE k = ?', ['foo'])
    expect(row).toEqual({ k: 'foo', v: 'bar' })
  })

  test('CryptoHasher works for sha256/sha512/sha3/blake3', () => {
    const sha256 = new CryptoHasher('sha256').update('m6').digest('hex')
    const sha512 = new CryptoHasher('sha512').update('m6').digest('hex')
    const sha3256 = new CryptoHasher('sha3-256').update('m6').digest('hex')
    const b3 = new CryptoHasher('blake3').update('m6').digest('hex')

    expect(sha256).toHaveLength(64)
    expect(sha512).toHaveLength(128)
    expect(sha3256).toHaveLength(64)
    expect(b3).toHaveLength(64)

    // same input, different algorithms must differ
    expect(new Set([sha256, sha3256, b3]).size).toBe(3)
  })

  test('CryptoHasher incremental update works', () => {
    const h1 = new CryptoHasher('sha3-256').update('hello').update(' world').digest('hex')
    const h2 = new CryptoHasher('sha3-256').update('hello world').digest('hex')
    expect(h1).toBe(h2)
  })

  test('bunHash surface: blake3 / sha3_256 / keccak256', () => {
    const b3 = bunHash.blake3('bun-web')
    const sha3 = bunHash.sha3_256('bun-web')
    const keccak = bunHash.keccak256('bun-web')

    expect(b3).toBeInstanceOf(Uint8Array)
    expect(b3).toHaveLength(32)
    expect(sha3).toHaveLength(32)
    expect(keccak).toHaveLength(32)
    expect(toHex(b3)).not.toBe(toHex(sha3))
  })

  test('hashHex supports sha3-256', async () => {
    const hex = await hashHex('m6', 'sha3-256')
    expect(hex).toHaveLength(64)
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

  test('passwordHash uses argon2id format ($argon2id$...)', async () => {
    const hash = await passwordHash('hunter2')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[0-9a-f]+\$[0-9a-f]+$/)
    // two separate calls must produce different salts
    const hash2 = await passwordHash('hunter2')
    expect(hash).not.toBe(hash2)
  })

  test('passwordVerify rejects wrong password and malformed hash', async () => {
    const hash = await passwordHash('correct-horse')
    expect(await passwordVerify('wrong-horse', hash)).toBe(false)
    expect(await passwordVerify('correct-horse', 'not-a-real-hash')).toBe(false)
    expect(await passwordVerify('correct-horse', 'pbkdf2$aabb$ccdd')).toBe(false)
  })

  test('WaSQLiteFactory injection: isWaSQLiteReady reflects state', () => {
    expect(isWaSQLiteReady()).toBe(false)
    __setWaSQLiteFactory({ create: (filename, opts) => new MemorySQLiteDatabase(filename, opts) })
    expect(isWaSQLiteReady()).toBe(true)
    __resetWaSQLiteForTests()
    expect(isWaSQLiteReady()).toBe(false)
  })

  test('WaSQLiteFactory injection: createSQLiteDatabase uses injected factory', () => {
    __setWaSQLiteFactory({ create: (filename, opts) => new MemorySQLiteDatabase(filename, opts) })

    const db = createSQLiteDatabase(':memory:')
    db.exec('CREATE TABLE wa (k TEXT, v TEXT)')
    db.run('INSERT INTO wa (k, v) VALUES (?, ?)', ['hello', 'world'])
    expect(db.get('SELECT * FROM wa WHERE k = ?', ['hello'])).toEqual({ k: 'hello', v: 'world' })

    __resetWaSQLiteForTests()
  })

  test('initWaSQLiteWasm throws when no factory registered', async () => {
    __resetWaSQLiteForTests()
    await expect(initWaSQLiteWasm()).rejects.toThrow('wa-sqlite not initialised')
  })

  test('initWaSQLiteWasm is no-op when factory already set', async () => {
    __setWaSQLiteFactory({ create: (f, o) => new MemorySQLiteDatabase(f, o) })
    await expect(initWaSQLiteWasm()).resolves.toBeUndefined()
    __resetWaSQLiteForTests()
  })
})

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
