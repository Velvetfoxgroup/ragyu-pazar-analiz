import { Pool, PoolClient, types } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

// numeric / bigint değerleri string kalsın: para hesaplarında kayan nokta yok.
types.setTypeParser(1700, (v) => v);
types.setTypeParser(20, (v) => v);

export type Db = Pool;
export type Q = Pool | PoolClient;

let pool: Pool | null = null;
export function getPool(url = process.env.DATABASE_URL): Pool {
  if (!pool) {
    if (!url) throw new Error('DATABASE_URL tanımlı değil');
    pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  }
  return pool;
}
export async function closePool() { if (pool) { await pool.end(); pool = null; } }

export async function tx<T>(db: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

export function migrationsDir(): string {
  const candidates = [process.env.MIGRATIONS_DIR, path.resolve(__dirname, '../../../migrations'), path.resolve(process.cwd(), 'migrations')];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('migrations klasörü bulunamadı');
}

export async function migrate(db: Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    await tx(db, async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    applied.push(f); log(`uygulandı: ${f}`);
  }
  return applied;
}

export async function audit(q: Q, a: { orgId: string; actorId?: string | null; actorName?: string | null; action: string; entityType?: string; entityId?: string; details?: unknown }) {
  await q.query(
    'INSERT INTO audit_log(org_id, actor_id, actor_name, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [a.orgId, a.actorId ?? null, a.actorName ?? null, a.action, a.entityType ?? null, a.entityId ?? null, JSON.stringify(a.details ?? {})],
  );
}
