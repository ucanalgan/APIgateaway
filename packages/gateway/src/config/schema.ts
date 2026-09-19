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
  /** Başlık gelene kadar ve (aşağıdaki `bodyTimeoutMs` yoksa) gövde parçaları arasında beklenen azami süre. */
  timeoutMs: z.number().int().positive().default(5000),
  /**
   * İki gövde parçası arasında beklenen azami süre — verilmezse `timeoutMs`.
   * `0` = sınırsız: SSE gibi uzun süre sessiz kalabilen akışlar için (aksi halde
   * `timeoutMs` kadar sessizlikte akış ortasında kesilir).
   */
  bodyTimeoutMs: z.number().int().nonnegative().optional(),
});

const rateLimitAlgorithmSchema = z.enum([
  'tokenBucket',
  'slidingWindowLog',
  'slidingWindowCounter',
  'fixedWindow',
  'leakyBucket',
]);

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

const globalRateLimitSchema = z.object({
  limit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  burst: z.number().int().positive().optional(),
});

const rateLimitSchema = z
  .object({
    algorithm: rateLimitAlgorithmSchema.default('tokenBucket'),
    keyBy: z.array(z.enum(['tenant', 'ip', 'global'])).min(1).default(['ip']),
    limit: z.number().int().positive(),
    windowSec: z.number().int().positive(),
    burst: z.number().int().positive().optional(),
    /**
     * `keyBy: [global]` için ayrı policy — route'un toplam upstream
     * kapasitesini korur, tek bir tenant/IP'nin kotasından bağımsız (bkz.
     * PLAN.md §5: üç key tipi aynı anda uygulanabilir, herhangi biri
     * reddederse istek reddedilir). Kasıtlı olarak `limit`/`windowSec`'i
     * miras almıyor — global kapasite neredeyse her zaman tek bir
     * çağıranın kotasından farklı bir sayıdır.
     */
    global: globalRateLimitSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.keyBy.includes('global') && !value.global) {
      ctx.addIssue({
        code: 'custom',
        message: 'keyBy includes "global" but no "global" policy (limit/windowSec) is configured.',
        path: ['global'],
      });
    }
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

const corsSchema = z.object({
  enabled: z.boolean().default(false),
  /** `'*'` joker; aksi halde `Origin` header'ı listede birebir olmalı. */
  origins: z.array(z.string().min(1)).min(1).default(['*']),
  methods: z
    .array(httpMethodSchema)
    .min(1)
    .default(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  allowedHeaders: z.array(z.string().min(1)).default(['Content-Type', 'Authorization']),
  exposedHeaders: z.array(z.string().min(1)).default([]),
  /** `true` ise `Access-Control-Allow-Origin` asla `*` olmaz (spec) — origin birebir yansıtılır. */
  credentials: z.boolean().default(false),
  maxAgeSec: z.number().int().nonnegative().default(600),
});

const websocketSchema = z.object({
  /** Açık değilse route'a gelen WebSocket el sıkışması reddedilir (opt-in). */
  enabled: z.boolean().default(false),
  /** Verilirse yalnızca bu `Origin`'lerden gelen el sıkışmalar kabul edilir; `'*'` = hepsi. */
  origins: z.array(z.string().min(1)).min(1).optional(),
  /**
   * `?access_token=` ile token kabul eder — tarayıcıdaki `new WebSocket()`
   * `Authorization` başlığı gönderemez. Token loglardan maskelenir ve upstream'e
   * URL'de iletilmez (başlık olarak iletilir). URL'ler proxy/CDN loglarında
   * dolaşabildiği için varsayılan kapalı.
   */
  queryToken: z.boolean().default(false),
  /** Bu route için bu gateway instance'ındaki azami eşzamanlı bağlantı. */
  maxConnections: z.number().int().positive().default(1000),
  /** Tek bir mesajın azami boyutu (iki yönde de) — aşılırsa bağlantı 1009 ile kapanır. */
  maxMessageBytes: z.number().int().positive().default(1_048_576),
  /** Yavaş bir tarafa birikmiş azami gönderilmemiş bayt — aşılırsa bağlantı 1013 ile kapanır. */
  maxBufferedBytes: z.number().int().positive().default(4_194_304),
  /** Her iki tarafa ping aralığı; pong gelmeyen taraf ölü sayılıp bağlantı kesilir. `0` = kapalı. */
  pingIntervalMs: z.number().int().nonnegative().default(30_000),
  /** Bu süre boyunca hiçbir yönde mesaj akmazsa bağlantı 1001 ile kapanır. `0` = kapalı. */
  idleTimeoutMs: z.number().int().nonnegative().default(0),
  /**
   * İstemciden upstream'e mesaj başına limit — bağlantı BAŞINA sayılır (aşılırsa
   * bağlantı 1008 ile kapanır). El sıkışma limiti ayrıca route'un `rateLimit`'idir.
   */
  messageRateLimit: z
    .object({
      algorithm: rateLimitAlgorithmSchema.default('tokenBucket'),
      limit: z.number().int().positive(),
      windowSec: z.number().int().positive(),
      burst: z.number().int().positive().optional(),
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

// Hostname ya da `*.` ile başlayan tek seviyeli joker; port/şema içermez
// (istekteki port zaten eşleşmeden önce atılır).
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const routeSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    path: z.string().min(1),
    methods: z.array(httpMethodSchema).optional(),
    /**
     * Sadece bu hostname'e eşleşir (büyük/küçük harf ve port fark etmez);
     * `*.example.com` her alt alan adını kapsar ama `example.com`'un kendisini
     * değil. Verilmezse route her host'a cevap verir.
     */
    host: z
      .string()
      .regex(HOST_PATTERN, 'must be a hostname like "api.example.com" or "*.example.com" — no port, no scheme')
      .optional(),
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
  cors: corsSchema.optional(),
  websocket: websocketSchema.optional(),
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
  /** Config dosyası değişince otomatik hot-reload dener. SIGHUP her zaman dener, bundan bağımsız. */
  watch: z.boolean().default(false),
});

const redisSchema = z.object({
  url: z.string().min(1),
  failOpen: z.boolean().default(true),
});

const dbSchema = z.object({
  url: z.string().min(1),
});

const adminSchema = z.object({
  /** `/admin/*` için tek operatör secret'ı — `Authorization: Bearer <token>`, sabit zamanlı karşılaştırma. */
  token: z.string().min(1),
});

export const gatewayConfigSchema = z.object({
  server: serverSchema.default({
    port: 8080,
    trustProxyHops: 0,
    maxBodyBytes: 1_048_576,
    maxHeaderCount: 100,
    requestTimeoutMs: 30000,
    watch: false,
  }),
  redis: redisSchema.optional(),
  db: dbSchema.optional(),
  admin: adminSchema.optional(),
  routes: z.array(routeSchema).default([]),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
