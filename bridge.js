// bridge.js — runs in Node for Max inside the device.
//
// Owns the HTTP + WebSocket server. Knows nothing about the Live Object Model;
// it just relays coarse-grained requests to lom.js and streams results back.
// Serving the UI from here is deliberate: the whole app ships as one .amxd
// plus this folder, with no packaging, signing or updater to build.

const Max = require('max-api');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.BSV_PORT) || 17800;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const PALETTE_FILE = path.join(__dirname, 'palette.json');

let lomReady = false;
let nextReqId = 1;
const pending = new Map(); // reqId -> { ws, type, started }

// --- http -------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // The cached palette lives beside the source, not in public/.
  if (rel === '/palette.json') {
    fs.readFile(PALETTE_FILE, (err, buf) => {
      res.writeHead(err ? 404 : 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(err ? '{"count":0,"colors":[]}' : buf);
    });
    return;
  }

  const file = path.join(PUBLIC, path.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
}

wss.on('connection', (ws) => {
  Max.post(`client connected (${wss.clients.size} total)`);
  send(ws, { type: 'status', lomReady });

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'bad json' });
    }
    try {
      await handle(ws, m);
    } catch (e) {
      send(ws, { type: 'error', id: m.id, message: String(e.message || e) });
    }
  });

  ws.on('close', () => Max.post(`client disconnected (${wss.clients.size} left)`));
});

async function handle(ws, m) {
  switch (m.type) {
    case 'snapshot': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const reqId = nextReqId++;
      pending.set(reqId, { ws, type: 'snapshot', clientId: m.id, started: Date.now() });
      Max.outlet('snapshot', reqId);
      break;
    }
    case 'apply': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const ops = Array.isArray(m.ops) ? m.ops : [];
      const reqId = nextReqId++;
      pending.set(reqId, { ws, type: 'apply', clientId: m.id, started: Date.now() });
      await Max.setDict('bsv_ops', { ops });
      Max.outlet('apply', reqId, 'bsv_ops');
      break;
    }
    case 'palette': {
      if (!lomReady) return send(ws, { type: 'error', id: m.id, message: 'LOM not ready' });
      const reqId = nextReqId++;
      pending.set(reqId, { ws, type: 'palette', clientId: m.id, started: Date.now() });
      Max.outlet('palette', reqId);
      break;
    }
    case 'observe':
      Max.outlet('observe', m.on ? 1 : 0);
      break;
    case 'ping':
      send(ws, { type: 'pong', id: m.id });
      break;
    default:
      send(ws, { type: 'error', id: m.id, message: `unknown type: ${m.type}` });
  }
}

// --- messages from lom.js --------------------------------------------

Max.addHandler('ready', () => {
  lomReady = true;
  Max.post('LOM ready');
  broadcast({ type: 'status', lomReady: true });
});

Max.addHandler('snapshot_done', async (reqId, dictName, ms) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const data = await Max.getDict(dictName);
  Max.post(`snapshot: ${data.clipCount} clips in ${ms}ms`);
  const payload = { type: 'snapshot', id: req?.clientId, lomMs: ms, data };
  if (req?.ws) send(req.ws, payload);
  else broadcast(payload);
});

Max.addHandler('apply_progress', (reqId, done, total) => {
  const req = pending.get(reqId);
  send(req?.ws, { type: 'progress', id: req?.clientId, done, total });
});

Max.addHandler('apply_done', async (reqId, dictName, ms) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const result = await Max.getDict(dictName);
  Max.post(`apply: ${result.applied} written, ${result.skipped} skipped, ${ms}ms`);
  send(req?.ws, { type: 'applied', id: req?.clientId, lomMs: ms, ...result });
  broadcast({ type: 'changed', kind: 'applied' });
});

Max.addHandler('palette_done', async (reqId, dictName) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  const p = await Max.getDict(dictName);
  // Cache it: deriving the palette costs a scratch scene, so we only ever
  // want to do it once per Live version.
  try {
    fs.writeFileSync(PALETTE_FILE, JSON.stringify(p, null, 2));
    Max.post(`palette: ${p.count} colors extracted and cached`);
  } catch (e) {
    Max.post(`palette: extracted but could not cache — ${e.message}`);
  }
  send(req?.ws, { type: 'palette', id: req?.clientId, ...p });
  broadcast({ type: 'paletteUpdated' });
});

Max.addHandler('changed', (kind) => broadcast({ type: 'changed', kind }));

Max.addHandler('err', (reqId, message) => {
  const req = pending.get(reqId);
  pending.delete(reqId);
  Max.post(`LOM error: ${message}`);
  send(req?.ws, { type: 'error', id: req?.clientId, message });
});

Max.addHandler('pong', () => {});

// --- dev: live reload -------------------------------------------------
// node.script @watch 1 already restarts this file on change, and v8 autowatch
// reloads lom.js. This closes the last gap: edit anything in public/ and every
// open browser reloads itself.

let reloadTimer = null;
try {
  fs.watch(PUBLIC, { recursive: true }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      Max.post('public/ changed — reloading clients');
      broadcast({ type: 'reload' });
    }, 120); // editors emit several events per save
  });
} catch (e) {
  Max.post(`could not watch public/ — live reload off (${e.message})`);
}

// --- lifecycle --------------------------------------------------------

// Both listeners are required: WebSocketServer re-emits the http server's
// error on itself, and an unhandled 'error' event takes down the whole script.
let reportedError = false;
function onServerError(e) {
  if (reportedError) return; // both listeners fire for the same failure
  reportedError = true;
  if (e.code === 'EADDRINUSE') {
    Max.post(
      `port ${PORT} already in use — another copy of this device is probably loaded. ` +
        `Delete the duplicate, or set BSV_PORT.`,
    );
  } else {
    Max.post(`server error: ${e.message}`);
  }
}
server.on('error', onServerError);
wss.on('error', onServerError);

server.listen(PORT, HOST, () => {
  Max.post(`Session Bridge listening on http://${HOST}:${PORT}`);
  Max.outlet('serving'); // drives the device's status line; routed off before lom.js
  Max.outlet('hello'); // whichever side is late drives the handshake
});

function shutdown() {
  try {
    for (const ws of wss.clients) ws.terminate();
    server.close();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
