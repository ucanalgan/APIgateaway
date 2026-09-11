CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,           -- free | pro | enterprise
  rate_limit    INTEGER NOT NULL,               -- requests / window
  window_sec    INTEGER NOT NULL,
  burst         INTEGER NOT NULL,               -- token bucket capacity
  quota_monthly BIGINT                          -- NULL = unlimited
);

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  plan_id     UUID NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,            -- raw key is NEVER stored
  key_prefix   TEXT NOT NULL,                   -- "ag_live_a1b2" — for display
  name         TEXT,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_active_hash_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;

CREATE TABLE usage_records (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  route_id    TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms  INTEGER NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_tenant_ts_idx ON usage_records (tenant_id, ts DESC);
