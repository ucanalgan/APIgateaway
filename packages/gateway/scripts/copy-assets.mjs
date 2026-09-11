import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const dest = fileURLToPath(new URL('../dist/db/migrations', import.meta.url));

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
}
