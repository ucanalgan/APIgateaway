import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { DbPool } from '../db/client.js';
import { createPlan, listPlans } from '../db/repositories/plans.js';
import { createTenant, listTenants, findTenantById, setTenantStatus } from '../db/repositories/tenants.js';
import { createApiKey, listApiKeysForTenant, revokeApiKey } from '../db/repositories/apiKeys.js';
import { getUsageSummary } from '../db/repositories/usageStats.js';
import { apiKeyCacheKey } from '../auth/index.js';
import { requireAdminToken } from './auth.js';

export interface AdminDeps {
  readonly db: DbPool;
  readonly redis?: Redis;
}

const createPlanSchema = z.object({
  name: z.string().min(1),
  rateLimit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  burst: z.number().int().positive(),
  quotaMonthly: z.number().int().positive().optional(),
});

const createTenantSchema = z.object({
  name: z.string().min(1),
  planId: z.string().uuid(),
});

const createKeySchema = z.object({
  name: z.string().min(1).optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * `/admin/*` — proxy pipeline'dan tamamen ayrı, gerçek bir CRUD API. JSON
 * body parser'ı ve auth hook'u sadece bu plugin scope'unda geçerli (Fastify
 * encapsulation) — gateway'in geri kalanı hâlâ body'yi stream olarak proxy'liyor.
 */
export async function registerAdminRoutes(app: FastifyInstance, token: string, deps: AdminDeps): Promise<void> {
  await app.register(
    async (admin) => {
      admin.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        try {
          done(null, body === '' ? {} : JSON.parse(body as string));
        } catch {
          done(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }), undefined);
        }
      });

      // Tüm hata gövdeleri aynı şekilde (error/message/requestId) — ve beklenmedik
      // hatalarda (örn. bir DB hatası) ham mesaj istemciye sızmasın.
      admin.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
        const status = err.statusCode ?? 500;

        if (status >= 500) {
          request.log.error({ err }, 'admin request failed');
          return reply.code(500).send({
            error: 'internal_error',
            message: 'Internal server error.',
            requestId: request.id,
          });
        }

        return reply.code(status).send({ error: 'invalid_request', message: err.message, requestId: request.id });
      });

      admin.addHook('onRequest', requireAdminToken(token));

      admin.post('/plans', async (request, reply) => {
        const parsed = createPlanSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, request, parsed.error);

        const { quotaMonthly, ...rest } = parsed.data;
        const plan = await createPlan(deps.db, { ...rest, ...(quotaMonthly !== undefined ? { quotaMonthly } : {}) });
        return reply.code(201).send(plan);
      });

      admin.get('/plans', async () => listPlans(deps.db));

      admin.post('/tenants', async (request, reply) => {
        const parsed = createTenantSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, request, parsed.error);

        const tenant = await createTenant(deps.db, parsed.data);
        return reply.code(201).send(tenant);
      });

      admin.get('/tenants', async () => listTenants(deps.db));

      admin.post<{ Params: { tenantId: string }; Body: unknown }>(
        '/tenants/:tenantId/suspend',
        async (request, reply) => {
          const tenant = await setTenantStatus(deps.db, request.params.tenantId, 'suspended');
          if (!tenant) return reply.code(404).send(notFound(request, 'tenant'));
          return tenant;
        },
      );

      admin.post<{ Params: { tenantId: string } }>('/tenants/:tenantId/activate', async (request, reply) => {
        const tenant = await setTenantStatus(deps.db, request.params.tenantId, 'active');
        if (!tenant) return reply.code(404).send(notFound(request, 'tenant'));
        return tenant;
      });

      admin.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/keys', async (request, reply) => {
        const tenant = await findTenantById(deps.db, request.params.tenantId);
        if (!tenant) return reply.code(404).send(notFound(request, 'tenant'));
        return listApiKeysForTenant(deps.db, request.params.tenantId);
      });

      admin.post<{ Params: { tenantId: string }; Body: unknown }>(
        '/tenants/:tenantId/keys',
        async (request, reply) => {
          const tenant = await findTenantById(deps.db, request.params.tenantId);
          if (!tenant) return reply.code(404).send(notFound(request, 'tenant'));

          const parsed = createKeySchema.safeParse(request.body);
          if (!parsed.success) return sendValidationError(reply, request, parsed.error);

          const key = await createApiKey(deps.db, {
            tenantId: request.params.tenantId,
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.scopes !== undefined ? { scopes: parsed.data.scopes } : {}),
            ...(parsed.data.expiresAt !== undefined ? { expiresAt: new Date(parsed.data.expiresAt) } : {}),
          });

          // Ham key sadece burada, bu bir kerelik yanıtta döner — hiçbir yerde saklanmaz/loglanmaz.
          return reply.code(201).send(key);
        },
      );

      admin.delete<{ Params: { keyId: string } }>('/keys/:keyId', async (request, reply) => {
        const revoked = await revokeApiKey(deps.db, request.params.keyId);
        if (!revoked) return reply.code(404).send(notFound(request, 'key'));

        // Sadece DB'de revoke etmek yetmez — cache TTL dolana kadar key hâlâ
        // geçerli görünür (bkz. gateway/src/auth/index.ts).
        if (deps.redis) await deps.redis.del(apiKeyCacheKey(revoked.hash));

        return reply.code(204).send();
      });

      admin.get<{ Querystring: { tenantId?: string; sinceHours?: string } }>('/usage', async (request) => {
        return getUsageSummary(deps.db, {
          ...(request.query.tenantId !== undefined ? { tenantId: request.query.tenantId } : {}),
          ...(request.query.sinceHours !== undefined ? { sinceHours: Number(request.query.sinceHours) } : {}),
        });
      });
    },
    { prefix: '/admin' },
  );
}

function notFound(request: { id: string }, what: string): { error: string; message: string; requestId: string } {
  return { error: 'not_found', message: `No ${what} matches that id.`, requestId: request.id };
}

function sendValidationError(
  reply: import('fastify').FastifyReply,
  request: { id: string },
  error: z.ZodError,
): import('fastify').FastifyReply {
  return reply.code(400).send({
    error: 'invalid_request',
    message: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    requestId: request.id,
  });
}
