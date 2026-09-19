import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type DbPool = pg.Pool;

export function createDbPool(connectionString: string): DbPool {
  const pool = new pg.Pool({ connectionString });

  // Postgres bir idle bağlantıyı düşürdüğünde (restart, failover, admin
  // terminate) pool 'error' yayar; dinleyici yoksa bu yakalanmamış istisnaya
  // dönüp süreci çökertir. Pool zaten bir sonraki sorguda yeni bağlantı açar —
  // burada yapılacak tek şey çökmemek. Asıl loglama server.ts'te eklenir.
  pool.on('error', () => {});

  return pool;
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
