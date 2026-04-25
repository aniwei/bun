// ----- types -----------------------------------------------------------------

export type SQLValue = string | number | bigint | null | Uint8Array

export type Row = Record<string, unknown>

type Table = {
  columns: string[]
  rows: Row[]
}

// ----- helpers ---------------------------------------------------------------

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ')
}

// ----- Statement -------------------------------------------------------------

export class Statement<T extends Row = Row> {
  constructor(
    private readonly db: MemorySQLiteDatabase,
    private readonly sql: string,
  ) {}

  run(...params: SQLValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.run(this.sql, params)
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
  }

  all(...params: SQLValue[]): T[] {
    return this.db.all(this.sql, params) as T[]
  }

  get(...params: SQLValue[]): T | null {
    return this.db.get(this.sql, params) as T | null
  }

  values(...params: SQLValue[]): unknown[][] {
    const rows = this.all(...params)
    if (rows.length === 0) return []
    const keys = Object.keys(rows[0])
    return rows.map(row => keys.map(k => row[k]))
  }

  *iterate(...params: SQLValue[]): Generator<T> {
    for (const row of this.all(...params)) {
      yield row
    }
  }

  finalize(): void {
    // no-op for in-memory store; wa-sqlite will free the prepared statement here
  }

  toString(): string {
    return this.sql
  }
}

// ----- Database --------------------------------------------------------------

export interface DatabaseOptions {
  readonly?: boolean
  create?: boolean
  strict?: boolean
}

export class MemorySQLiteDatabase {
  private readonly tables = new Map<string, Table>()
  private _inTransaction = false
  private _lastInsertRowid = 0
  readonly filename: string

  constructor(filename: string = ':memory:', _opts?: DatabaseOptions) {
    this.filename = filename
  }

  static open(filename: string, opts?: DatabaseOptions): MemorySQLiteDatabase {
    return new MemorySQLiteDatabase(filename, opts)
  }

  static deserialize(data: Uint8Array, opts?: DatabaseOptions): MemorySQLiteDatabase {
    const db = new MemorySQLiteDatabase(':memory:', opts)
    try {
      const entries = JSON.parse(new TextDecoder().decode(data)) as [string, Table][]
      for (const [name, table] of entries) {
        db.tables.set(name, table)
      }
    } catch {
      // ignore invalid data
    }
    return db
  }

  get inTransaction(): boolean {
    return this._inTransaction
  }

  exec(sql: string): void {
    const normalized = normalize(sql)
    const createMatch = normalized.match(
      /^CREATE TABLE(?: IF NOT EXISTS)? ([a-zA-Z0-9_]+) \((.+)\)$/i,
    )
    if (!createMatch) return

    const tableName = createMatch[1]
    const columns = createMatch[2]
      .split(',')
      .map(part => part.trim().split(' ')[0])
      .filter(Boolean)

    this.tables.set(tableName, { columns, rows: [] })
  }

  prepare<T extends Row = Row>(sql: string): Statement<T> {
    return new Statement<T>(this, sql)
  }

  query<T extends Row = Row>(sql: string): Statement<T> {
    return this.prepare<T>(sql)
  }

  run(sql: string, params: SQLValue[] = []): { changes: number; lastInsertRowid: number } {
    const normalized = normalize(sql)
    const insertMatch = normalized.match(
      /^INSERT INTO ([a-zA-Z0-9_]+) \(([^)]+)\) VALUES \(([^)]+)\)$/i,
    )

    if (!insertMatch) return { changes: 0, lastInsertRowid: 0 }

    const table = this.tables.get(insertMatch[1])
    if (!table) throw new Error(`Table not found: ${insertMatch[1]}`)

    const columns = insertMatch[2].split(',').map(c => c.trim())
    const row: Row = {}
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = params[i] ?? null
    }
    table.rows.push(row)
    this._lastInsertRowid = table.rows.length
    return { changes: 1, lastInsertRowid: this._lastInsertRowid }
  }

  all(sql: string, params: SQLValue[] = []): Row[] {
    const normalized = normalize(sql)
    const selectMatch = normalized.match(
      /^SELECT \* FROM ([a-zA-Z0-9_]+)(?: WHERE ([a-zA-Z0-9_]+) = \?)?$/i,
    )
    if (!selectMatch) return []

    const table = this.tables.get(selectMatch[1])
    if (!table) return []

    const whereColumn = selectMatch[2]
    if (!whereColumn) return table.rows.map(row => ({ ...row }))

    return table.rows
      .filter(row => row[whereColumn] === params[0])
      .map(row => ({ ...row }))
  }

  get(sql: string, params: SQLValue[] = []): Row | null {
    return this.all(sql, params)[0] ?? null
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]) => {
      this._inTransaction = true
      try {
        const result = fn(...args)
        this._inTransaction = false
        return result
      } catch (err) {
        this._inTransaction = false
        throw err
      }
    }
  }

  serialize(_fileName?: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([...this.tables.entries()]))
  }

  close(_throwOnError?: boolean): void {}
}

export type SQLiteDatabase = MemorySQLiteDatabase

// ----- WaSQLiteFactory backend injection (M6-5 OPFS VFS) --------------------
//
// Follows the same pattern as zlib's FlateBackend / brotliBackend injection.
// In the browser, call initWaSQLiteWasm() to load the real wa-sqlite WASM and
// register it as the factory. In tests, call __setWaSQLiteFactory() to inject
// a MemorySQLiteDatabase-backed shim.

export interface WaSQLiteFactory {
  /** Open (or create) a database at the given path. ':memory:' → in-memory DB. */
  create(filename: string, opts?: DatabaseOptions): MemorySQLiteDatabase
}

let _waSQLiteFactory: WaSQLiteFactory | undefined

export function __setWaSQLiteFactory(factory: WaSQLiteFactory): void {
  _waSQLiteFactory = factory
}

export function __resetWaSQLiteForTests(): void {
  _waSQLiteFactory = undefined
}

/**
 * Initialize the wa-sqlite WASM module and register it as the SQLite backend.
 * In the browser, pass an optional WASM URL to override the default CDN path.
 * In test environments, prefer __setWaSQLiteFactory() with a MemorySQLiteDatabase shim.
 */
export async function initWaSQLiteWasm(_wasmUrl?: string | URL): Promise<void> {
  if (_waSQLiteFactory) return
  // Actual browser wiring (OPFS VFS setup) happens in bun-web-runtime at boot time.
  throw new Error(
    'wa-sqlite not initialised: call __setWaSQLiteFactory() first, ' +
    'or ensure initWaSQLiteWasm() is invoked after the WASM module is loaded.',
  )
}

export function isWaSQLiteReady(): boolean {
  return _waSQLiteFactory !== undefined
}

// ---------------------------------------------------------------------------

export function createSQLiteDatabase(
  filename: string = ':memory:',
  opts?: DatabaseOptions,
): SQLiteDatabase {
  if (_waSQLiteFactory) {
    return _waSQLiteFactory.create(filename, opts)
  }
  return new MemorySQLiteDatabase(filename, opts)
}
