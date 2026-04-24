type Row = Record<string, unknown>

type Table = {
  columns: string[]
  rows: Row[]
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ')
}

class MemoryStatement {
  constructor(private readonly db: MemorySQLiteDatabase, private readonly sql: string) {}

  run(...params: unknown[]): { changes: number } {
    return this.db.run(this.sql, params)
  }

  all(...params: unknown[]): Row[] {
    return this.db.all(this.sql, params)
  }

  get(...params: unknown[]): Row | null {
    return this.db.get(this.sql, params)
  }
}

export class MemorySQLiteDatabase {
  private readonly tables = new Map<string, Table>()

  exec(sql: string): void {
    const normalized = normalize(sql)
    const createMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? ([a-zA-Z0-9_]+) \((.+)\)$/i)
    if (!createMatch) {
      return
    }

    const tableName = createMatch[1]
    const columns = createMatch[2]
      .split(',')
      .map(part => part.trim().split(' ')[0])
      .filter(Boolean)

    this.tables.set(tableName, { columns, rows: [] })
  }

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql)
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    const normalized = normalize(sql)
    const insertMatch = normalized.match(
      /^INSERT INTO ([a-zA-Z0-9_]+) \(([^)]+)\) VALUES \(([^)]+)\)$/i,
    )

    if (!insertMatch) {
      return { changes: 0 }
    }

    const table = this.tables.get(insertMatch[1])
    if (!table) {
      throw new Error(`Table not found: ${insertMatch[1]}`)
    }

    const columns = insertMatch[2].split(',').map(column => column.trim())
    const row: Row = {}
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = params[i]
    }

    table.rows.push(row)
    return { changes: 1 }
  }

  all(sql: string, params: unknown[] = []): Row[] {
    const normalized = normalize(sql)
    const selectMatch = normalized.match(/^SELECT \* FROM ([a-zA-Z0-9_]+)(?: WHERE ([a-zA-Z0-9_]+) = \?)?$/i)

    if (!selectMatch) {
      return []
    }

    const table = this.tables.get(selectMatch[1])
    if (!table) {
      return []
    }

    const whereColumn = selectMatch[2]
    if (!whereColumn) {
      return table.rows.map(row => ({ ...row }))
    }

    return table.rows
      .filter(row => row[whereColumn] === params[0])
      .map(row => ({ ...row }))
  }

  get(sql: string, params: unknown[] = []): Row | null {
    return this.all(sql, params)[0] ?? null
  }

  serialize(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([...this.tables.entries()]))
  }

  close(): void {}
}

export type SQLiteDatabase = MemorySQLiteDatabase

export function createSQLiteDatabase(): SQLiteDatabase {
  return new MemorySQLiteDatabase()
}
