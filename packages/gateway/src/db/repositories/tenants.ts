import type { DbPool } from '../client.js';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly planId: string;
  readonly status: 'active' | 'suspended';
}

function mapRow(row: { id: string; name: string; plan_id: string; status: string }): Tenant {
  return { id: row.id, name: row.name, planId: row.plan_id, status: row.status as Tenant['status'] };
}

export async function createTenant(pool: DbPool, input: { name: string; planId: string }): Promise<Tenant> {
  const { rows } = await pool.query<{ id: string; name: string; plan_id: string; status: string }>(
    `INSERT INTO tenants (name, plan_id) VALUES ($1, $2)
     RETURNING id, name, plan_id, status`,
    [input.name, input.planId],
  );

  const row = rows[0];
  if (!row) throw new Error('createTenant: insert returned no row');

  return mapRow(row);
}

export async function listTenants(pool: DbPool): Promise<Tenant[]> {
  const { rows } = await pool.query<{ id: string; name: string; plan_id: string; status: string }>(
    'SELECT id, name, plan_id, status FROM tenants ORDER BY created_at DESC',
  );
  return rows.map(mapRow);
}

export async function findTenantById(pool: DbPool, id: string): Promise<Tenant | null> {
  const { rows } = await pool.query<{ id: string; name: string; plan_id: string; status: string }>(
    'SELECT id, name, plan_id, status FROM tenants WHERE id = $1',
    [id],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function setTenantStatus(pool: DbPool, id: string, status: Tenant['status']): Promise<Tenant | null> {
  const { rows } = await pool.query<{ id: string; name: string; plan_id: string; status: string }>(
    'UPDATE tenants SET status = $2 WHERE id = $1 RETURNING id, name, plan_id, status',
    [id, status],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}
