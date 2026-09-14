import express from 'express';
import { rateLimiter } from '@apigate/adapter-express';

const app = express();

app.use(rateLimiter({ limit: 5, windowSec: 60 }));

app.get('/', (_req, res) => {
  res.json({ message: 'hello from a bare Express app' });
});

app.listen(3000, () => {
  console.log('standalone-express example listening on :3000 (try it 6 times — the 6th is a 429)');
});
