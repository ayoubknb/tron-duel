const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 60, H = 40, TICK_MS = 75, WIN = 5;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, slots: [null, null], specs: new Set(), score: [0, 0], phase: 'wait', grid: null, bikes: null, loop: null, timeout: null };
    rooms.set(id, r);
  }
  return r;
}
function send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function cast(r, m) {
  const s = JSON.stringify(m);
  for (const ws of [...r.slots, ...r.specs]) if (ws && ws.readyState === 1) ws.send(s);
}
const full = r => r.slots[0] && r.slots[1];
function stop(r) { clearInterval(r.loop); clearTimeout(r.timeout); r.loop = r.timeout = null; }

function newRound(r) {
  stop(r);
  if (!full(r)) { r.phase = 'wait'; r.score = [0, 0]; cast(r, { t: 'wait', score: r.score }); return; }
  r.grid = new Uint8Array(W * H);
  const y = H >> 1;
  r.bikes = [
    { x: 8, y, d: 1, q: [] },
    { x: W - 9, y, d: 3, q: [] },
  ];
  r.bikes.forEach((b, i) => { r.grid[b.y * W + b.x] = i + 1; });
  r.phase = 'count';
  cast(r, { t: 'round', W, H, heads: r.bikes.map(b => [b.x, b.y]), score: r.score });
  r.timeout = setTimeout(() => {
    r.phase = 'play';
    cast(r, { t: 'go' });
    r.loop = setInterval(() => tick(r), TICK_MS);
  }, 3000);
}

function tick(r) {
  const [a, b] = r.bikes;
  for (const k of r.bikes) {
    if (k.q.length) k.d = k.q.shift();
    k.x += DX[k.d]; k.y += DY[k.d];
  }
  const hit = k => k.x < 0 || k.y < 0 || k.x >= W || k.y >= H || r.grid[k.y * W + k.x] !== 0;
  let deadA = hit(a), deadB = hit(b);
  if (a.x === b.x && a.y === b.y) deadA = deadB = true;
  if (!deadA) r.grid[a.y * W + a.x] = 1;
  if (!deadB) r.grid[b.y * W + b.x] = 2;
  cast(r, { t: 'tick', h: [[a.x, a.y], [b.x, b.y]] });
  if (deadA || deadB) {
    stop(r);
    const winner = deadA && deadB ? -1 : deadA ? 1 : 0;
    if (winner >= 0) r.score[winner]++;
    const match = r.score.some(s => s >= WIN);
    r.phase = 'end';
    cast(r, { t: 'end', winner, score: r.score, match, crash: [deadA, deadB] });
    r.timeout = setTimeout(() => { if (match) r.score = [0, 0]; newRound(r); }, match ? 5000 : 2500);
  }
}

wss.on('connection', (ws, req) => {
  const id = (new URL(req.url, 'http://x').searchParams.get('r') || 'main').slice(0, 24);
  const r = getRoom(id);
  const slot = !r.slots[0] ? 0 : !r.slots[1] ? 1 : -1;
  if (slot >= 0) r.slots[slot] = ws; else r.specs.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'hello', you: slot, W, H, score: r.score });
  if (slot >= 0 && full(r) && r.phase === 'wait') newRound(r);
  else if (r.phase === 'wait') send(ws, { t: 'wait', score: r.score });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== 'dir' || slot < 0 || !r.bikes || r.phase === 'end' || r.phase === 'wait') return;
    const d = m.d | 0; if (d < 0 || d > 3) return;
    const k = r.bikes[slot];
    const last = k.q.length ? k.q[k.q.length - 1] : k.d;
    if (d === last || (d + 2) % 4 === last) return;
    if (k.q.length < 3) k.q.push(d);
  });

  ws.on('close', () => {
    if (slot >= 0) {
      r.slots[slot] = null;
      stop(r); r.phase = 'wait'; r.score = [0, 0]; r.bikes = null;
      cast(r, { t: 'wait', score: r.score, left: true });
    } else r.specs.delete(ws);
    if (!r.slots[0] && !r.slots[1] && !r.specs.size) rooms.delete(id);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('Tron Duel sur le port ' + PORT));
