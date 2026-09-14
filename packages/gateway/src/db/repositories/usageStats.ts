import type { DbPool } from '../client.js';

export interface UsageSummary {
  readonly totalRequests: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly avgLatencyMs: number | null;
  readonly p99LatencyMs: number | null;
}

/** `usage_records`'dan son `sinceHours` saatin özeti — tenantId verilirse ona daraltılır. */
export async function getUsageSummary(
  pool: DbPool,
  options: { tenantId?: string; sinceHours?: number } = {},
): Promise<UsageSummary> {
  const sinceHours = options.sinceHours ?? 24;
  const params: unknown[] = [sinceHours];
  const tenantFilter = options.tenantId ? 'AND tenant_id = $2' : '';
  if (options.tenantId) params.push(options.tenantId);

  const { rows } = await pool.query<{
    total: string;
    success: string;
    errors: string;
    avg_latency_ms: string | null;
    p99_latency_ms: string | null;
  }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE status_code >= 200 AND status_code < 400) AS success,
       count(*) FILTER (WHERE status_code >= 400) AS errors,
       avg(latency_ms) AS avg_latency_ms,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99_latency_ms
     FROM usage_records
     WHERE ts > now() - ($1 || ' hours')::interval ${tenantFilter}`,
    params,
  );

  const row = rows[0];
  return {
    totalRequests: Number(row?.total ?? 0),
    successCount: Number(row?.success ?? 0),
    errorCount: Number(row?.errors ?? 0),
    avgLatencyMs: row?.avg_latency_ms !== null && row?.avg_latency_ms !== undefined ? Number(row.avg_latency_ms) : null,
    p99LatencyMs:
      row?.p99_latency_ms !== null && row?.p99_latency_ms !== undefined ? Number(row.p99_latency_ms) : null,
  };
}
