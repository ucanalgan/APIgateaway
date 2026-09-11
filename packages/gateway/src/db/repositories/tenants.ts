import type { DbPool } from '../client.js';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly planId: string;
  readonly status: 'active' | 'suspended';
}

export async function createTenant(pool: DbPool, input: { name: string; planId: string }): Promise<Tenant> {
  const { rows } = await pool.query<{ id: string; name: string; plan_id: string; status: string }>(
    `INSERT INTO tenants (name, plan_id) VALUES ($1, $2)
     RETURNING id, name, plan_id, status`,
    [input.name, input.planId],
  );

  const row = rows[0];
  if (!row) throw new Error('createTenant: insert returned no row');

  return { id: row.id, name: row.name, planId: row.plan_id, status: row.status as Tenant['status'] };
}
