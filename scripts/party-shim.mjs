// Local stand-in for the Supabase party backend, used by the Playwright
// smoke (and handy for offline playtesting: `node scripts/party-shim.mjs
// 8788` then load any face with ?api=http://localhost:8788).
//
// It serves js/party-core.js over HTTP with the exact RPC names and error
// messages of supabase/party-SETUP.sql. The SQL file is the authority — it
// was drilled against real Postgres; this shim only needs to be faithful
// enough to exercise the client and the three faces end to end.

import { createServer } from 'node:http';
import { createDb, OPS } from '../js/party-core.js';

export function startShim(port = 0) {
  let db = createDb(Math.floor(Date.now() / 1000) % 2147483646 + 1);
  const server = createServer((req, res) => {
    const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(200, {});
    if (!m || req.method !== 'POST' || !OPS[m[1]]) return send(404, { message: 'not a party rpc' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const { db: next, result } = OPS[m[1]](db, JSON.parse(raw || '{}'), Math.floor(Date.now() / 1000));
        db = next;
        send(200, result ?? {});
      } catch (e) {
        if (e.name === 'PartyError') return send(400, { message: e.code });
        send(500, { message: String(e) });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Standalone: node scripts/party-shim.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startShim(Number(process.argv[2] || 8788));
  console.log(`party shim listening at ${url}`);
}
