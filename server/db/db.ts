import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
type Param = SqlValue | boolean | undefined;
export type Row = Record<string, SqlValue>;

function bind(params: Param[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/** Thin wrapper over node:sqlite with a statement cache and transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ':memory:' && !fs.existsSync(file)) {
      // Create the file owner-only before SQLite does; WAL/SHM files inherit this mode.
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...bind(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...bind(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...bind(params)) as T[];
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  private migrate(): void {
    const current = Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
