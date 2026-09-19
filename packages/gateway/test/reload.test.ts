import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/load.js';
import { buildServer } from '../src/server.js';
import { startUpstream, waitFor, type TestUpstream } from './helpers.js';

// Hot-reload driven the way it really happens: rewrite the config file on
// disk, then deliver SIGHUP (process.emit — Windows has no real signals, but
// the handler is the same one a real SIGHUP invokes).
let app: FastifyInstance | undefined;
let up: TestUpstream | undefined;
let dir: string | undefined;

afterEach(async () => {
  await app?.close();
  await up?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined;
  up = undefined;
  dir = undefined;
});

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config)); // JSON is valid YAML
}

function sighup(): void {
  process.emit('SIGHUP', 'SIGHUP');
}

describe('config hot-reload', () => {
  it('picks up a new route from the rewritten file', async () => {
    up = await startUpstream();
    dir = mkdtempSync(join(tmpdir(), 'apigate-reload-'));
    const path = join(dir, 'gateway.json');
    const route = (id: string) => ({ id, match: { path: `/${id}/*` }, upstream: { targets: [up!.url] } });

    writeConfig(path, { routes: [route('a')] });
    app = await buildServer(loadConfig(path), path);
    expect((await app.inject({ method: 'GET', url: '/b/x' })).statusCode).toBe(404);

    writeConfig(path, { routes: [route('a'), route('b')] });
    sighup();

    await waitFor(async () => (await app!.inject({ method: 'GET', url: '/b/x' })).statusCode === 200);
    expect((await app.inject({ method: 'GET', url: '/a/x' })).statusCode).toBe(200);
  });

  it('drops a removed route', async () => {
    up = await startUpstream();
    dir = mkdtempSync(join(tmpdir(), 'apigate-reload-'));
    const path = join(dir, 'gateway.json');
    const route = (id: string) => ({ id, match: { path: `/${id}/*` }, upstream: { targets: [up!.url] } });

    writeConfig(path, { routes: [route('a'), route('b')] });
    app = await buildServer(loadConfig(path), path);
    expect((await app.inject({ method: 'GET', url: '/b/x' })).statusCode).toBe(200);

    writeConfig(path, { routes: [route('a')] });
    sighup();

    await waitFor(async () => (await app!.inject({ method: 'GET', url: '/b/x' })).statusCode === 404);
  });

  it('rejects a reload that changes an immutable section and keeps serving the old config', async () => {
    up = await startUpstream();
    dir = mkdtempSync(join(tmpdir(), 'apigate-reload-'));
    const path = join(dir, 'gateway.json');
    const route = (id: string) => ({ id, match: { path: `/${id}/*` }, upstream: { targets: [up!.url] } });

    writeConfig(path, { server: { port: 8080 }, routes: [route('a')] });
    app = await buildServer(loadConfig(path), path);

    writeConfig(path, { server: { port: 9999 }, routes: [route('a'), route('b')] }); // port change ⇒ needs a restart
    sighup();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await app.inject({ method: 'GET', url: '/b/x' })).statusCode).toBe(404); // new route NOT applied
    expect((await app.inject({ method: 'GET', url: '/a/x' })).statusCode).toBe(200); // old config intact
  });

  it('survives a syntactically broken config file', async () => {
    up = await startUpstream();
    dir = mkdtempSync(join(tmpdir(), 'apigate-reload-'));
    const path = join(dir, 'gateway.json');

    writeConfig(path, { routes: [{ id: 'a', match: { path: '/a/*' }, upstream: { targets: [up.url] } }] });
    app = await buildServer(loadConfig(path), path);

    writeFileSync(path, '{ this is : not [valid');
    sighup();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await app.inject({ method: 'GET', url: '/a/x' })).statusCode).toBe(200);
  });

  it('rejects a reload that adds an apiKey route without a db block', async () => {
    up = await startUpstream();
    dir = mkdtempSync(join(tmpdir(), 'apigate-reload-'));
    const path = join(dir, 'gateway.json');

    writeConfig(path, { routes: [{ id: 'a', match: { path: '/a/*' }, upstream: { targets: [up.url] } }] });
    app = await buildServer(loadConfig(path), path);

    writeConfig(path, {
      routes: [
        { id: 'a', match: { path: '/a/*' }, upstream: { targets: [up.url] } },
        { id: 'secure', match: { path: '/secure/*' }, upstream: { targets: [up.url] }, auth: { type: 'apiKey' } },
      ],
    });
    sighup();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await app.inject({ method: 'GET', url: '/secure/x' })).statusCode).toBe(404); // never applied
  });
});
