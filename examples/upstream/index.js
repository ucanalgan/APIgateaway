import { createServer } from 'node:http';

const port = process.env['PORT'] ? Number(process.env['PORT']) : 4000;

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, url: req.url }));
});

server.listen(port, () => {
  console.log(`fake upstream listening on :${port}`);
});
