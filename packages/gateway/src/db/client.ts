import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type DbPool = pg.Pool;

export function createDbPool(connectionString: string): DbPool {
  return new pg.Pool({ connectionString });
}

/**
 * Numaralı .sql dosyalarını sırayla, uygulanmamış olanları tek seferde
 * uygular. Ham SQL — bir migration tool'u kurmak bu projenin öğrenme
 * hedefine katkı sağlamıyor (bkz. PLAN.md "Açık kararlar").
 */
export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = fileURLToPath(new URL('./migrations', import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations WHERE name = $1', [file]);
    if (rows.length > 0) continue;

    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
