// A minimal D1Database over node:sqlite — real SQL, real UNIQUE constraints,
// zero network. The #321 publishing outage was precisely a constraint-shaped
// bug (an UPDATE colliding with UNIQUE(accounts.handle)), so a hand-rolled
// object mock that doesn't enforce the schema would test nothing; this shim
// loads the real schema.sql and lets SQLite say no exactly where D1 would.
// Only the surface db.ts uses is implemented: prepare().bind().first/all/run
// and batch().
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

interface D1Result {
  results?: unknown[];
  meta?: { changes: number };
}

class MockStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): MockStatement {
    return new MockStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as any[]));
    return (row as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as any[])) as T[] };
  }

  async run(): Promise<D1Result> {
    const r = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { meta: { changes: Number(r.changes) } };
  }
}

export class MockD1 {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    const schema = fs.readFileSync(path.resolve(__dirname, "../schema.sql"), "utf-8");
    // Statement-by-statement with the production adapter's idempotence
    // contract (cloudflare adapter applySchema): a migration ALTER that fails
    // only because it already happened — e.g. "duplicate column name" when the
    // column is also folded into the CREATE — is a skip, not an error. A
    // single exec() would die on exactly the schema the live deploy converges.
    for (const stmt of schema.split(/;\s*(?:\r?\n|$)/)) {
      const sql = stmt.replace(/^\s*--.*$/gm, "").trim();
      if (!sql) continue;
      try { this.db.exec(sql); }
      catch (e) {
        if (!/duplicate column name|already exists/i.test(String(e))) throw e;
      }
    }
  }

  prepare(sql: string): MockStatement {
    return new MockStatement(this.db, sql);
  }

  async batch(stmts: MockStatement[]): Promise<D1Result[]> {
    // D1 batch is transactional; mirror that so a mid-batch constraint
    // failure leaves nothing applied.
    this.db.exec("BEGIN");
    try {
      const out: D1Result[] = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Raw escape hatch for planting fixture rows / inspecting state. */
  raw(sql: string, ...args: unknown[]): unknown[] {
    return this.db.prepare(sql).all(...(args as any[]));
  }
}
