import { dirname } from "@mars/vfs"

import type { MarsVFS } from "@mars/vfs"

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

interface StoredDatabase {
  tables: Record<string, StoredTable>
}

interface StoredTable {
  columns: string[]
  rows: MarsSQLRow[]
  nextRowId: number
}

export function createMarsSQLiteDatabase(options: MarsSQLiteOptions): MarsSQLDatabase {
  return new DefaultMarsSQLiteDatabase(options.vfs, options.path ?? "/workspace/mars.sqlite.json")
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

class DefaultMarsSQLiteDatabase implements MarsSQLDatabase {
  readonly path: string
  readonly #vfs: MarsVFS
  #state: StoredDatabase | null = null

  constructor(vfs: MarsVFS, path: string) {
    this.#vfs = vfs
    this.path = path
  }

  async exec(sql: string, params: readonly MarsSQLValue[] = []): Promise<MarsSQLRunResult> {
    const statements = splitStatements(sql)
    let changes = 0
    let rows: MarsSQLRow[] = []

    for (const statement of statements) {
      const result = await this.#executeStatement(statement, params)
      changes += result.changes
      rows = result.rows
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
    if (this.#state) await this.#persist()
  }

  async #executeStatement(sql: string, params: readonly MarsSQLValue[]): Promise<MarsSQLRunResult> {
    const normalizedSQL = sql.trim()
    if (!normalizedSQL) return { rows: [], changes: 0 }
    if (/^create\s+table\s+/i.test(normalizedSQL)) return this.#createTable(normalizedSQL)
    if (/^insert\s+into\s+/i.test(normalizedSQL)) return this.#insert(normalizedSQL, params)
    if (/^select\s+/i.test(normalizedSQL)) return this.#select(normalizedSQL, params)
    if (/^update\s+/i.test(normalizedSQL)) return this.#update(normalizedSQL, params)
    if (/^delete\s+from\s+/i.test(normalizedSQL)) return this.#delete(normalizedSQL, params)

    throw new Error(`Unsupported Mars sqlite statement: ${normalizedSQL}`)
  }

  async #createTable(sql: string): Promise<MarsSQLRunResult> {
    const match = sql.match(/^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w]*)\s*\((.+)\)$/i)
    if (!match) throw new Error(`Unsupported CREATE TABLE statement: ${sql}`)

    const state = await this.#load()
    const tableName = match[1]
    const columns = splitCommaList(match[2]).map(column => column.trim().split(/\s+/)[0]).filter(Boolean)
    if (!state.tables[tableName]) state.tables[tableName] = { columns, rows: [], nextRowId: 1 }
    await this.#persist()

    return { rows: [], changes: 0 }
  }

  async #insert(sql: string, params: readonly MarsSQLValue[]): Promise<MarsSQLRunResult> {
    const match = sql.match(/^insert\s+into\s+([a-zA-Z_][\w]*)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)$/i)
    if (!match) throw new Error(`Unsupported INSERT statement: ${sql}`)

    const table = await this.#requireTable(match[1])
    const columns = splitCommaList(match[2]).map(column => column.trim())
    const values = splitCommaList(match[3]).map((value, index) => readSQLValue(value, params, index))
    const row: MarsSQLRow = {}

    for (let index = 0; index < columns.length; index += 1) row[columns[index]] = values[index] ?? null
    if (table.columns.includes("id") && row.id === undefined) {
      row.id = table.nextRowId
      table.nextRowId += 1
    }

    table.rows.push(row)
    await this.#persist()

    return { rows: [], changes: 1 }
  }

  async #select(sql: string, params: readonly MarsSQLValue[]): Promise<MarsSQLRunResult> {
    const match = sql.match(/^select\s+(.+)\s+from\s+([a-zA-Z_][\w]*)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+([a-zA-Z_][\w]*)(?:\s+(asc|desc))?)?$/i)
    if (!match) throw new Error(`Unsupported SELECT statement: ${sql}`)

    const table = await this.#requireTable(match[2])
    const rows = filterRows(table.rows, match[3], params)
    return { rows: selectFields(sortRows(rows, match[4], match[5]), match[1].trim()), changes: 0 }
  }

  async #update(sql: string, params: readonly MarsSQLValue[]): Promise<MarsSQLRunResult> {
    const match = sql.match(/^update\s+([a-zA-Z_][\w]*)\s+set\s+(.+?)(?:\s+where\s+(.+))?$/i)
    if (!match) throw new Error(`Unsupported UPDATE statement: ${sql}`)

    const table = await this.#requireTable(match[1])
    const assignments = splitCommaList(match[2]).map(item => item.match(/^([a-zA-Z_][\w]*)\s*=\s*(.+)$/))
    if (assignments.some(assignment => !assignment)) throw new Error(`Unsupported UPDATE assignment: ${sql}`)

    let changes = 0
    for (const row of filterRows(table.rows, match[3], params, assignments.length)) {
      assignments.forEach((assignment, index) => {
        if (assignment) row[assignment[1]] = readSQLValue(assignment[2], params, index)
      })
      changes += 1
    }

    if (changes) await this.#persist()
    return { rows: [], changes }
  }

  async #delete(sql: string, params: readonly MarsSQLValue[]): Promise<MarsSQLRunResult> {
    const match = sql.match(/^delete\s+from\s+([a-zA-Z_][\w]*)(?:\s+where\s+(.+))?$/i)
    if (!match) throw new Error(`Unsupported DELETE statement: ${sql}`)

    const table = await this.#requireTable(match[1])
    const before = table.rows.length
    const rowsToDelete = new Set(filterRows(table.rows, match[2], params))
    table.rows = table.rows.filter(row => !rowsToDelete.has(row))
    const changes = before - table.rows.length

    if (changes) await this.#persist()
    return { rows: [], changes }
  }

  async #requireTable(name: string): Promise<StoredTable> {
    const table = (await this.#load()).tables[name]
    if (!table) throw new Error(`Mars sqlite table does not exist: ${name}`)

    return table
  }

  async #load(): Promise<StoredDatabase> {
    if (this.#state) return this.#state
    if (!this.#vfs.existsSync(this.path)) {
      this.#state = { tables: {} }
      return this.#state
    }

    this.#state = JSON.parse(String(await this.#vfs.readFile(this.path, "utf8"))) as StoredDatabase
    return this.#state
  }

  async #persist(): Promise<void> {
    const state = await this.#load()
    const parentDirectory = dirname(this.path)
    if (!this.#vfs.existsSync(parentDirectory)) await this.#vfs.mkdir(parentDirectory, { recursive: true })
    await this.#vfs.writeFile(this.path, JSON.stringify(state, null, 2))
  }
}

function templateToSQL(strings: TemplateStringsArray): string {
  return strings.reduce((sql, chunk, index) => `${sql}${index === 0 ? "" : "?"}${chunk}`, "")
}

function splitStatements(sql: string): string[] {
  return sql.split(";").map(statement => statement.trim()).filter(Boolean)
}

function splitCommaList(input: string): string[] {
  return input.split(",").map(item => item.trim()).filter(Boolean)
}

function readSQLValue(input: string, params: readonly MarsSQLValue[], index: number): MarsSQLValue {
  const value = input.trim()
  if (value === "?") return params[index] ?? null
  if (/^null$/i.test(value)) return null
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1)

  return value
}

function filterRows(rows: MarsSQLRow[], whereClause: string | undefined, params: readonly MarsSQLValue[], paramOffset = 0): MarsSQLRow[] {
  if (!whereClause) return [...rows]

  const match = whereClause.trim().match(/^([a-zA-Z_][\w]*)\s*=\s*(.+)$/)
  if (!match) throw new Error(`Unsupported WHERE clause: ${whereClause}`)

  const value = readSQLValue(match[2], params, paramOffset)
  return rows.filter(row => row[match[1]] === value)
}

function sortRows(rows: MarsSQLRow[], column: string | undefined, direction: string | undefined): MarsSQLRow[] {
  if (!column) return rows

  const multiplier = direction?.toLowerCase() === "desc" ? -1 : 1
  return [...rows].sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? "")) * multiplier)
}

function selectFields(rows: MarsSQLRow[], fields: string): MarsSQLRow[] {
  const countMatch = fields.match(/^count\(\*\)(?:\s+as\s+([a-zA-Z_][\w]*))?$/i)
  if (countMatch) return [{ [countMatch[1] ?? "count(*)"]: rows.length }]
  if (fields === "*") return rows.map(row => ({ ...row }))

  const columns = splitCommaList(fields).map(field => field.replace(/\s+as\s+.+$/i, "").trim())
  return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null])))
}