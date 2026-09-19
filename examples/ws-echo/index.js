// A tiny WebSocket upstream for trying the gateway's WebSocket proxying.
//
//   - sends a greeting the moment a client connects (the gateway must not lose it)
//   - echoes every message back, text and binary alike
//   - ends the connection with 4000 "bye" when a client sends the text "close"
//   - answers plain HTTP on /health, and echoes the request it got on any other
//     path, so you can also see what the gateway forwarded (path, query, headers)
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const port = process.env['PORT'] ? Number(process.env['PORT']) : 4100;

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, url: req.url }));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    // What the gateway forwarded on the handshake: handy to see path rewrite,
    // that ?access_token= was stripped, and that the token arrived as a header.
    ws.send(
      JSON.stringify({
        hello: 'from ws-echo',
        url: req.url,
        authorization: req.headers['authorization'] ?? null,
        forwardedFor: req.headers['x-forwarded-for'] ?? null,
      }),
    );

    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'close') {
        ws.close(4000, 'bye');
        return;
      }
      ws.send(data, { binary: isBinary });
    });
  });
});

server.listen(port, () => {
  console.log(`ws-echo listening on :${port}`);
});
