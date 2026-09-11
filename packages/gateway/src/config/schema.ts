import { z } from 'zod';

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const upstreamSchema = z.object({
  targets: z.array(z.string().url()).min(1),
  strategy: z.enum(['roundRobin']).default('roundRobin'),
  healthCheck: z
    .object({
      path: z.string().default('/health'),
      intervalMs: z.number().int().positive().default(10000),
    })
    .optional(),
  timeoutMs: z.number().int().positive().default(5000),
});

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('apiKey') }),
  z.object({
    type: z.literal('jwt'),
    jwksUrl: z.string().url(),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    /** Bu claim'den tenantId okunur; yoksa `sub`'a düşer. Varsayılan: 'tenant_id'. */
    tenantClaim: z.string().optional(),
    /** Boşlukla ayrılmış string ya da dizi olabilir. Varsayılan: 'scope'. */
    scopeClaim: z.string().optional(),
  }),
]);

const rateLimitSchema = z.object({
  algorithm: z
    .enum(['tokenBucket', 'slidingWindowLog', 'slidingWindowCounter', 'fixedWindow', 'leakyBucket'])
    .default('tokenBucket'),
  keyBy: z.array(z.enum(['tenant', 'ip'])).min(1).default(['ip']),
  limit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  burst: z.number().int().positive().optional(),
});

const cacheSchema = z.object({
  enabled: z.boolean().default(false),
  ttlSec: z.number().int().positive().default(60),
  varyBy: z.array(z.string()).default([]),
});

const transformSchema = z.object({
  request: z
    .object({
      setHeaders: z.record(z.string(), z.string()).default({}),
      removeHeaders: z.array(z.string()).default([]),
    })
    .optional(),
});

const retrySchema = z.object({
  attempts: z.number().int().nonnegative().default(0),
  backoffMs: z.number().int().positive().default(100),
});

const circuitBreakerSchema = z.object({
  failureThreshold: z.number().int().positive().default(5),
  resetTimeoutMs: z.number().int().positive().default(30000),
});

const routeSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    path: z.string().min(1),
    methods: z.array(httpMethodSchema).optional(),
  }),
  rewrite: z
    .object({
      stripPrefix: z.string().optional(),
    })
    .optional(),
  upstream: upstreamSchema,
  auth: authSchema.default({ type: 'none' }),
  rateLimit: rateLimitSchema.optional(),
  cache: cacheSchema.optional(),
  transform: transformSchema.optional(),
  retry: retrySchema.optional(),
  circuitBreaker: circuitBreakerSchema.optional(),
});

const serverSchema = z.object({
  port: z.number().int().positive().default(8080),
  trustProxyHops: z.number().int().nonnegative().default(0),
  maxBodyBytes: z.number().int().positive().default(1_048_576),
  maxHeaderCount: z.number().int().positive().default(100),
  requestTimeoutMs: z.number().int().positive().default(30000),
});

const redisSchema = z.object({
  url: z.string().min(1),
  failOpen: z.boolean().default(true),
});

const dbSchema = z.object({
  url: z.string().min(1),
});

export const gatewayConfigSchema = z.object({
  server: serverSchema.default({
    port: 8080,
    trustProxyHops: 0,
    maxBodyBytes: 1_048_576,
    maxHeaderCount: 100,
    requestTimeoutMs: 30000,
  }),
  redis: redisSchema.optional(),
  db: dbSchema.optional(),
  routes: z.array(routeSchema).default([]),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
