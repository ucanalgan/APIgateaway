import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = fileURLToPath(new URL('./packages/core/src', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against `@apigate/core`'s source, not its built `dist/` — so
    // `npm test` works on a fresh clone with no prior `npm run build` (dist has
    // no `.lua` files until `copy-lua.mjs` runs), and core's coverage counts
    // the code gateway tests exercise too.
    alias: [
      { find: /^@apigate\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@apigate\/core\/(ratelimit|auth|breaker|cache)$/, replacement: `${coreSrc}/$1/index.ts` },
    ],
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.ts', 'packages/adapters/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/scripts/**'],
      // A floor, not a target (the suite sits around 95%): a run that drops
      // below it fails. That also makes CI fail loudly if the Redis/Postgres
      // tests ever silently skip — without those services coverage falls to
      // roughly two-thirds.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
