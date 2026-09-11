import type { DbPool } from '../client.js';

export interface UsageRecord {
  readonly tenantId: string;
  readonly routeId: string;
  readonly statusCode: number;
  readonly latencyMs: number;
}

/**
 * Tek multi-row INSERT — istek yolunu yavaşlatmamak için bunu senkron her
 * istekte değil, biriktirilmiş bir buffer'dan periyodik çağır (bkz.
 * gateway/src/usage/buffer.ts).
 */
export async function insertUsageBatch(pool: DbPool, records: readonly UsageRecord[]): Promise<void> {
  if (records.length === 0) return;

  const values: unknown[] = [];
  const rows = records
    .map((record, i) => {
      const base = i * 4;
      values.push(record.tenantId, record.routeId, record.statusCode, record.latencyMs);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    })
    .join(', ');

  await pool.query(
    `INSERT INTO usage_records (tenant_id, route_id, status_code, latency_ms) VALUES ${rows}`,
    values,
  );
}
