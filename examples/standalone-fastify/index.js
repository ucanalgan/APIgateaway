import Fastify from 'fastify';
import rateLimiter from '@apigate/adapter-fastify';

const app = Fastify();

await app.register(rateLimiter, { limit: 5, windowSec: 60 });

app.get('/', async () => ({ message: 'hello from a bare Fastify app' }));

await app.listen({ port: 3001 });
console.log('standalone-fastify example listening on :3001 (try it 6 times — the 6th is a 429)');
