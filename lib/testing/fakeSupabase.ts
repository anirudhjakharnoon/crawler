/**
 * A minimal, purpose-built in-memory stand-in for the subset of the
 * Supabase JS query builder that `lib/crawl/tick.ts` and `lib/robots.ts`
 * actually use (eq/not/order/limit/select-with-count/maybeSingle/insert/
 * update/upsert, plus `storage.from().upload()`). This is NOT a general
 * Postgrest emulator — just enough to run the integration test in
 * `lib/crawl/tick.test.ts` against real business logic with a mocked
 * network instead of a real Supabase project.
 */

export type Row = Record<string, unknown>;
export type TableName = string;

interface SelectOpts {
  count?: "exact";
  head?: boolean;
}

interface UpsertOpts {
  onConflict?: string;
  ignoreDuplicates?: boolean;
  count?: "exact";
}

type OrderFn = (a: Row, b: Row) => number;
type FilterFn = (row: Row) => boolean;

interface QueryResult {
  data: Row[] | Row | null;
  error: null;
  count?: number;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a > b ? 1 : -1;
}

export class FakeSupabase {
  private store: Record<TableName, Row[]> = {};
  private nextId: Record<TableName, number> = {};
  private primaryKeys: Record<TableName, string>;
  public uploadedFiles = new Map<string, Buffer>();

  constructor(initial: Record<TableName, Row[]>, primaryKeys: Record<TableName, string> = {}) {
    for (const [table, rows] of Object.entries(initial)) {
      this.store[table] = rows.map((r) => ({ ...r }));
      const maxId = Math.max(0, ...rows.map((r) => Number(r.id ?? 0)));
      this.nextId[table] = maxId + 1;
    }
    this.primaryKeys = primaryKeys;
  }

  private rows(table: TableName): Row[] {
    if (!this.store[table]) this.store[table] = [];
    return this.store[table] as Row[];
  }

  private allocateId(table: TableName): number {
    const current = this.nextId[table] ?? 1;
    this.nextId[table] = current + 1;
    return current;
  }

  getTable(table: TableName): Row[] {
    return this.rows(table).map((r) => ({ ...r }));
  }

  from(table: TableName) {
    const filters: FilterFn[] = [];
    const orderFns: OrderFn[] = [];
    let limitN: number | null = null;
    let wantCount = false;
    let headOnly = false;
    let singleMode = false;

    const self = this;

    function runSelect(): QueryResult {
      let matched = self.rows(table).filter((r) => filters.every((f) => f(r)));
      const total = matched.length;
      for (const fn of orderFns) matched = [...matched].sort(fn);
      if (limitN !== null) matched = matched.slice(0, limitN);
      const cloned = matched.map((r) => ({ ...r }));
      if (singleMode) {
        return { data: cloned[0] ?? null, error: null, count: wantCount ? total : undefined };
      }
      return { data: headOnly ? null : cloned, error: null, count: wantCount ? total : undefined };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select(_cols?: string, opts?: SelectOpts) {
        if (opts?.count) wantCount = true;
        if (opts?.head) headOnly = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        if (op === "is" && val === null) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
        }
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        const ascending = opts?.ascending !== false;
        orderFns.push((a, b) => compareValues(a[col], b[col]) * (ascending ? 1 : -1));
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        singleMode = true;
        return runSelect();
      },
      async insert(values: Row | Row[]) {
        const arr = Array.isArray(values) ? values : [values];
        const inserted: Row[] = [];
        for (const v of arr) {
          const pk = self.primaryKeys[table] ?? "id";
          const row: Row = pk === "id" ? { id: self.allocateId(table), ...v } : { ...v };
          self.rows(table).push(row);
          inserted.push(row);
        }
        return { data: inserted, error: null, count: inserted.length };
      },
      async upsert(values: Row | Row[], opts?: UpsertOpts) {
        const arr = Array.isArray(values) ? values : [values];
        const conflictCols = (opts?.onConflict ?? self.primaryKeys[table] ?? "id").split(",");
        let insertedCount = 0;
        for (const v of arr) {
          const idx = self.rows(table).findIndex((r) => conflictCols.every((c) => r[c] === v[c]));
          if (idx >= 0) {
            if (!opts?.ignoreDuplicates) {
              self.rows(table)[idx] = { ...self.rows(table)[idx], ...v };
            }
            continue;
          }
          const pk = self.primaryKeys[table] ?? "id";
          const row: Row = pk === "id" ? { id: self.allocateId(table), ...v } : { ...v };
          self.rows(table).push(row);
          insertedCount++;
        }
        return { data: null, error: null, count: insertedCount };
      },
      update(values: Row) {
        return {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val);
            return this;
          },
          then(resolve: (r: { data: null; error: null }) => void) {
            self.store[table] = self.rows(table).map((r) =>
              filters.every((f) => f(r)) ? { ...r, ...values } : r
            );
            resolve({ data: null, error: null });
          },
        };
      },
      then(resolve: (r: QueryResult) => void) {
        resolve(runSelect());
      },
    };

    return builder;
  }

  get storage() {
    const self = this;
    return {
      from(bucket: string) {
        return {
          async upload(path: string, body: Buffer, _opts?: unknown) {
            self.uploadedFiles.set(`${bucket}/${path}`, body);
            return { data: { path }, error: null };
          },
        };
      },
    };
  }
}
