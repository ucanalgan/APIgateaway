import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchConfig, type ConfigWatcher } from '../src/config/watch.js';

let dir: string;
let watcher: ConfigWatcher | undefined;

afterEach(() => {
  watcher?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('watchConfig', () => {
  it('calls onReload with the newly parsed config when the file changes', async () => {
    dir = mkdtempSync(join(tmpdir(), `apigate-watch-${randomUUID()}-`));
    const file = join(dir, 'gateway.yaml');
    writeFileSync(file, 'server:\n  port: 8080\nroutes: []\n');

    const reloads: number[] = [];
    watcher = watchConfig(file, {
      onReload: (config) => reloads.push(config.server.port),
      onError: () => {},
      watchFile: true,
    });

    writeFileSync(file, 'server:\n  port: 9090\nroutes: []\n');

    await waitFor(() => reloads.includes(9090));
    expect(reloads).toContain(9090);
  });

  it('reports invalid config via onError instead of throwing', async () => {
    dir = mkdtempSync(join(tmpdir(), `apigate-watch-${randomUUID()}-`));
    const file = join(dir, 'gateway.yaml');
    writeFileSync(file, 'server:\n  port: 8080\nroutes: []\n');

    const errors: unknown[] = [];
    watcher = watchConfig(file, {
      onReload: () => {},
      onError: (err) => errors.push(err),
      watchFile: true,
    });

    writeFileSync(file, 'server:\n  port: "not-a-number"\n');

    // fs.watch can fire more than one 'change' event for a single write on
    // some platforms — the exact count isn't the point, only that invalid
    // content is reported via onError and never thrown/crashes the process.
    await waitFor(() => errors.length > 0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('does not touch the file when watchFile is false', async () => {
    dir = mkdtempSync(join(tmpdir(), `apigate-watch-${randomUUID()}-`));
    const file = join(dir, 'gateway.yaml');
    writeFileSync(file, 'server:\n  port: 8080\nroutes: []\n');

    const reloads: number[] = [];
    watcher = watchConfig(file, {
      onReload: (config) => reloads.push(config.server.port),
      onError: () => {},
      watchFile: false,
    });

    writeFileSync(file, 'server:\n  port: 9090\nroutes: []\n');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(reloads).toHaveLength(0);
  });
});
