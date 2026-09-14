import type { DbPool } from '../client.js';

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly rateLimit: number;
  readonly windowSec: number;
  readonly burst: number;
  readonly quotaMonthly: number | null;
}

export interface CreatePlanInput {
  readonly name: string;
  readonly rateLimit: number;
  readonly windowSec: number;
  readonly burst: number;
  readonly quotaMonthly?: number;
}

export async function createPlan(pool: DbPool, input: CreatePlanInput): Promise<Plan> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    rate_limit: number;
    window_sec: number;
    burst: number;
    quota_monthly: string | null;
  }>(
    `INSERT INTO plans (name, rate_limit, window_sec, burst, quota_monthly)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, rate_limit, window_sec, burst, quota_monthly`,
    [input.name, input.rateLimit, input.windowSec, input.burst, input.quotaMonthly ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error('createPlan: insert returned no row');

  return {
    id: row.id,
    name: row.name,
    rateLimit: row.rate_limit,
    windowSec: row.window_sec,
    burst: row.burst,
    quotaMonthly: row.quota_monthly === null ? null : Number(row.quota_monthly),
  };
}

export async function listPlans(pool: DbPool): Promise<Plan[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    rate_limit: number;
    window_sec: number;
    burst: number;
    quota_monthly: string | null;
  }>('SELECT id, name, rate_limit, window_sec, burst, quota_monthly FROM plans ORDER BY name');

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rateLimit: row.rate_limit,
    windowSec: row.window_sec,
    burst: row.burst,
    quotaMonthly: row.quota_monthly === null ? null : Number(row.quota_monthly),
  }));
}

export async function findPlanByName(pool: DbPool, name: string): Promise<Plan | null> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    rate_limit: number;
    window_sec: number;
    burst: number;
    quota_monthly: string | null;
  }>('SELECT id, name, rate_limit, window_sec, burst, quota_monthly FROM plans WHERE name = $1', [name]);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    rateLimit: row.rate_limit,
    windowSec: row.window_sec,
    burst: row.burst,
    quotaMonthly: row.quota_monthly === null ? null : Number(row.quota_monthly),
  };
}
