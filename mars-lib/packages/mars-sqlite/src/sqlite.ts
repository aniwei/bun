import { dirname } from "@mars/vfs"

import type { MarsVFS } from "@mars/vfs"

type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlJsDatabase
}

type SqlJsInit = () => Promise<SqlJsModule>

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
  getRowsModified(): number
}

export type MarsSQLValue = string | number | boolean | null
export type MarsSQLRow = Record<string, MarsSQLValue>

export interface MarsSQLiteOptions {
  vfs: MarsVFS
  path?: string
}

export interface MarsSQLRunResult {
  rows: MarsSQLRow[]
  changes: number
}

export interface MarsSQLDatabase {
  readonly path: string
  exec(sql: string, params?: readonly MarsSQLValue[]): Promise<MarsSQLRunResult>
  run(sql: string, params?: readonly MarsSQLValue[]): Promise<MarsSQLRunResult>
  all<T extends MarsSQLRow = MarsSQLRow>(sql: string, params?: readonly MarsSQLValue[]): Promise<T[]>
  get<T extends MarsSQLRow = MarsSQLRow>(sql: string, params?: readonly MarsSQLValue[]): Promise<T | null>
  close(): Promise<void>
}

export interface MarsSQLFacade {
  <T extends MarsSQLRow = MarsSQLRow>(strings: TemplateStringsArray, ...values: MarsSQLValue[]): Promise<T[]>
  readonly db: MarsSQLDatabase
  open(path: string): MarsSQLDatabase
}

export function createMarsSQLiteDatabase(options: MarsSQLiteOptions): MarsSQLDatabase {
  return new LazyWasmMarsSQLiteDatabase(options.vfs, options.path ?? "/workspace/mars.sqlite")
}

export function createMarsSQL(options: MarsSQLiteOptions): MarsSQLFacade {
  const database = createMarsSQLiteDatabase(options)
  const sql = (async <T extends MarsSQLRow = MarsSQLRow>(
    strings: TemplateStringsArray,
    ...values: MarsSQLValue[]
  ): Promise<T[]> => database.all<T>(templateToSQL(strings), values)) as MarsSQLFacade

  Object.defineProperties(sql, {
    db: { value: database, enumerable: true },
    open: {
      value: (path: string) => createMarsSQLiteDatabase({ vfs: options.vfs, path }),
      enumerable: true,
    },
  })

  return sql
}

class LazyWasmMarsSQLiteDatabase implements MarsSQLDatabase {
  readonly path: string
  readonly #vfs: MarsVFS
  #backendPromise: Promise<WasmMarsSQLiteDatabase> | null = null
  #backend: WasmMarsSQLiteDatabase | null = null
  #closed = false

  constructor(vfs: MarsVFS, path: string) {
    this.#vfs = vfs
    this.path = path
  }

  async exec(sql: string, params: readonly MarsSQLValue[] = []): Promise<MarsSQLRunResult> {
    return (await this.#resolveBackend()).exec(sql, params)
  }

  run(sql: string, params: readonly MarsSQLValue[] = []): Promise<MarsSQLRunResult> {
    return this.exec(sql, params)
  }

  async all<T extends MarsSQLRow = MarsSQLRow>(sql: string, params: readonly MarsSQLValue[] = []): Promise<T[]> {
    return (await this.#resolveBackend()).all<T>(sql, params)
  }

  async get<T extends MarsSQLRow = MarsSQLRow>(sql: string, params: readonly MarsSQLValue[] = []): Promise<T | null> {
    return (await this.#resolveBackend()).get<T>(sql, params)
  }

  async close(): Promise<void> {
    if (this.#closed) return

    this.#closed = true
    if (this.#backend) await this.#backend.close()
  }

  async #resolveBackend(): Promise<WasmMarsSQLiteDatabase> {
    if (this.#closed) throw new Error("Mars sqlite database is closed")
    if (this.#backend) return this.#backend

    this.#backendPromise ??= WasmMarsSQLiteDatabase.create(this.#vfs, this.path)
    this.#backend = await this.#backendPromise
    return this.#backend
  }
}

class WasmMarsSQLiteDatabase implements MarsSQLDatabase {
  readonly path: string
  readonly #vfs: MarsVFS
  readonly #db: SqlJsDatabase
  #transactionOpen = false
  #closed = false

  private constructor(vfs: MarsVFS, path: string, db: SqlJsDatabase) {
    this.#vfs = vfs
    this.path = path
    this.#db = db
  }

  static async create(vfs: MarsVFS, path: string): Promise<WasmMarsSQLiteDatabase> {
    const sqlJs = await loadSqlJsModule()
    const bytes = await readDatabaseBytes(vfs, path)
    const db = bytes ? new sqlJs.Database(bytes) : new sqlJs.Database()

    return new WasmMarsSQLiteDatabase(vfs, path, db)
  }

  async exec(sql: string, params: readonly MarsSQLValue[] = []): Promise<MarsSQLRunResult> {
    if (this.#closed) throw new Error("Mars sqlite database is closed")

    const statements = splitStatements(sql)
    let rows: MarsSQLRow[] = []
    let changes = 0

    for (const statement of statements) {
      const normalizedSQL = statement.trim()
      if (!normalizedSQL) continue

      const result = await this.#executeStatement(normalizedSQL, params)
      rows = result.rows
      changes += result.changes
      if (result.shouldPersist) await this.#persist()
    }

    return { rows, changes }
  }

  run(sql: string, params: readonly MarsSQLValue[] = []): Promise<MarsSQLRunResult> {
    return this.exec(sql, params)
  }

  async all<T extends MarsSQLRow = MarsSQLRow>(sql: string, params: readonly MarsSQLValue[] = []): Promise<T[]> {
    return (await this.exec(sql, params)).rows as T[]
  }

  async get<T extends MarsSQLRow = MarsSQLRow>(sql: string, params: readonly MarsSQLValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null
  }

  async close(): Promise<void> {
    if (this.#closed) return

    if (this.#transactionOpen) {
      this.#db.run("rollback")
      this.#transactionOpen = false
    } else {
      await this.#persist()
    }

    this.#db.close()
    this.#closed = true
  }

  async #executeStatement(
    statement: string,
    params: readonly MarsSQLValue[],
  ): Promise<{ rows: MarsSQLRow[]; changes: number; shouldPersist: boolean }> {
    if (/^begin(?:\s+transaction)?$/i.test(statement)) {
      if (this.#transactionOpen) throw new Error("Mars sqlite transaction already started")
      this.#db.run("begin transaction")
      this.#transactionOpen = true
      return { rows: [], changes: 0, shouldPersist: false }
    }

    if (/^commit(?:\s+transaction)?$/i.test(statement)) {
      if (!this.#transactionOpen) throw new Error("Mars sqlite transaction is not active")
      this.#db.run("commit")
      this.#transactionOpen = false
      return { rows: [], changes: 0, shouldPersist: true }
    }

    if (/^(?:rollback|end)(?:\s+transaction)?$/i.test(statement)) {
      if (!this.#transactionOpen) throw new Error("Mars sqlite transaction is not active")
      this.#db.run("rollback")
      this.#transactionOpen = false
      return { rows: [], changes: 0, shouldPersist: false }
    }

    if (/^select\s+/i.test(statement)) {
      const results = this.#db.exec(statement, params as unknown[])
      return { rows: sqlJsResultsToRows(results), changes: 0, shouldPersist: false }
    }

    this.#db.run(statement, params as unknown[])
    return {
      rows: [],
      changes: this.#db.getRowsModified(),
      shouldPersist: !this.#transactionOpen,
    }
  }

  async #persist(): Promise<void> {
    const parentDirectory = dirname(this.path)
    if (!this.#vfs.existsSync(parentDirectory)) await this.#vfs.mkdir(parentDirectory, { recursive: true })
    await this.#vfs.writeFile(this.path, this.#db.export())
  }
}

let sqlJsModulePromise: Promise<SqlJsModule> | null = null

export async function preloadSQLiteWasm(): Promise<void> {
  await loadSqlJsModule()
}

function loadSqlJsModule(): Promise<SqlJsModule> {
  sqlJsModulePromise ??= (async () => {
    const module = await import("sql.js") as { default?: SqlJsInit }
    const init = module.default
    if (!init) throw new Error("sql.js init function is unavailable")

    return init()
  })()

  return sqlJsModulePromise
}

async function readDatabaseBytes(vfs: MarsVFS, path: string): Promise<Uint8Array | null> {
  if (!vfs.existsSync(path)) return null

  const value = await vfs.readFile(path)
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}

function sqlJsResultsToRows(results: Array<{ columns: string[]; values: unknown[][] }>): MarsSQLRow[] {
  const result = results.at(-1)
  if (!result) return []

  return result.values.map(record => {
    const entries = result.columns.map((column, index) => [column, normalizeSqlValue(record[index])])
    return Object.fromEntries(entries) as MarsSQLRow
  })
}

function normalizeSqlValue(value: unknown): MarsSQLValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }

  return value === undefined ? null : String(value)
}

function templateToSQL(strings: TemplateStringsArray): string {
  return strings.reduce((sql, chunk, index) => `${sql}${index === 0 ? "" : "?"}${chunk}`, "")
}

function splitStatements(sql: string): string[] {
  return sql.split(";").map(statement => statement.trim()).filter(Boolean)
}