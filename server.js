const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 60, H = 40, TICK_MS = 40, WIN = 5, WALL = 3;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const COLORS = ['#36f2ff', '#ff8a2a', '#ff4fd8', '#3dff7a', '#ffe14a', '#9d6bff', '#ff3b4a', '#e8eeff'];
const KINDS = ['turbo', 'frein', 'fantome', 'gomme'];
const T = ms => Math.round(ms / TICK_MS);

// ---------- Maps (symétriques gauche/droite et haut/bas) ----------
const MAPS = [
  { name: 'Arène', build() {} },
  { name: 'Piliers', build(add) {
    for (let x = 16; x <= 19; x++) for (let y = 9; y <= 12; y++) add(x, y);
  } },
  { name: 'Portes', build(add) {
    for (let y = 0; y <= 19; y++) if (!(y >= 5 && y <= 8) && y < 18) add(29, y);
  } },
  { name: 'Couloirs', build(add) {
    for (let x = 12; x <= 26; x++) { add(x, 10); }
    for (let y = 3; y <= 6; y++) add(22, y);
  } },
  { name: 'Anneau', build(add) {
    for (let x = 20; x <= 27; x++) add(x, 12);
    for (let y = 12; y <= 17; y++) add(20, y);
  } },
  { name: 'Astéroïdes', build(add) {
    for (let n = 0; n < 9; n++) {
      const x = 4 + Math.floor(Math.random() * 24), y = 2 + Math.floor(Math.random() * 15);
      add(x, y); add(x + 1, y); add(x, y + 1); add(x + 1, y + 1);
    }
  } },
];

function buildMap(map) {
  const g = new Uint8Array(W * H);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = WALL; };
  const add = (x, y) => { set(x, y); set(W - 1 - x, y); set(x, H - 1 - y); set(W - 1 - x, H - 1 - y); };
  map.build(add);
  // couloir de départ toujours libre
  for (let y = 17; y <= 22; y++) for (let x = 0; x <= 16; x++) { g[y * W + x] = 0; g[y * W + (W - 1 - x)] = 0; }
  return g;
}

// ---------- Serveur HTTP + WebSocket ----------
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
    r = { id, slots: [null, null], players: [null, null], specs: new Set(), score: [0, 0], phase: 'wait',
      grid: null, bikes: null, items: [], loop: null, timeout: null, t: 0, nextItem: 0, bag: [], lastMap: -1 };
    rooms.set(id, r);
  }
  return r;
}
function send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function cast(r, m) {
  const s = JSON.stringify(m);
  for (const ws of [...r.slots, ...r.specs]) if (ws && ws.readyState === 1) ws.send(s);
}
const ready = r => r.slots[0] && r.slots[1] && r.players[0] && r.players[1];
function stop(r) { clearInterval(r.loop); clearTimeout(r.timeout); r.loop = r.timeout = null; }

function pickMap(r) {
  if (!r.bag.length) {
    r.bag = MAPS.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (r.bag[r.bag.length - 1] === r.lastMap) r.bag.unshift(r.bag.pop());
  }
  r.lastMap = r.bag.pop();
  return MAPS[r.lastMap];
}

function newRound(r) {
  stop(r);
  if (!ready(r)) { r.phase = 'wait'; r.score = [0, 0]; cast(r, { t: 'wait', score: r.score }); return; }
  const map = pickMap(r);
  r.grid = buildMap(map);
  const walls = [];
  r.grid.forEach((v, i) => { if (v === WALL) walls.push(i); });
  const y = H >> 1;
  const mk = (x, d) => ({ x, y, d, q: [], acc: 0, fast: 0, slow: 0, ghost: 0 });
  r.bikes = [mk(8, 1), mk(W - 9, 3)];
  r.bikes.forEach((b, i) => { r.grid[b.y * W + b.x] = i + 1; });
  r.items = []; r.t = 0; r.nextItem = T(2000);
  r.phase = 'count';
  cast(r, { t: 'round', W, H, heads: r.bikes.map(b => [b.x, b.y]), score: r.score, walls, map: map.name, players: r.players });
  r.timeout = setTimeout(() => {
    r.phase = 'play';
    cast(r, { t: 'go' });
    r.loop = setInterval(() => tick(r), TICK_MS);
  }, 3000);
}

function spawnItem(r) {
  for (let tries = 0; tries < 60; tries++) {
    const x = 1 + Math.floor(Math.random() * (W - 3)), y = 1 + Math.floor(Math.random() * (H - 3));
    let ok = true;
    for (let dx = 0; dx < 2 && ok; dx++) for (let dy = 0; dy < 2 && ok; dy++) if (r.grid[(y + dy) * W + x + dx] !== 0) ok = false;
    if (!ok) continue;
    if (r.bikes.some(b => Math.abs(b.x - x) < 5 && Math.abs(b.y - y) < 5)) continue;
    if (r.items.some(([ix, iy]) => Math.abs(ix - x) < 4 && Math.abs(iy - y) < 4)) continue;
    r.items.push([x, y, KINDS[Math.floor(Math.random() * KINDS.length)]]);
    return true;
  }
  return false;
}

function tick(r) {
  r.t++;
  const bikes = r.bikes, [a, b] = bikes;
  for (const k of bikes) {
    const f = k.fast > r.t, s = k.slow > r.t;
    const period = f && !s ? 1 : s && !f ? 4 : 2;
    k.acc++;
    k.moved = k.acc >= period;
    if (k.moved) {
      k.acc = 0;
      if (k.q.length) k.d = k.q.shift();
      k.x += DX[k.d]; k.y += DY[k.d];
    }
  }
  const hit = k => {
    if (!k.moved) return false;
    if (k.x < 0 || k.y < 0 || k.x >= W || k.y >= H) return true;
    const c = r.grid[k.y * W + k.x];
    if (c === WALL) return true;
    return c !== 0 && !(k.ghost > r.t);
  };
  let deadA = hit(a), deadB = hit(b);
  if (a.x === b.x && a.y === b.y && !(a.ghost > r.t) && !(b.ghost > r.t)) deadA = deadB = true;
  if (a.moved && !deadA) r.grid[a.y * W + a.x] = 1;
  if (b.moved && !deadB) r.grid[b.y * W + b.x] = 2;
  if (a.moved || b.moved) cast(r, { t: 'tick', h: [[a.x, a.y], [b.x, b.y]] });

  if (deadA || deadB) {
    stop(r);
    const winner = deadA && deadB ? -1 : deadA ? 1 : 0;
    if (winner >= 0) r.score[winner]++;
    const match = r.score.some(s => s >= WIN);
    r.phase = 'end';
    cast(r, { t: 'end', winner, score: r.score, match, crash: [deadA, deadB] });
    r.timeout = setTimeout(() => { if (match) r.score = [0, 0]; newRound(r); }, match ? 5000 : 2500);
    return;
  }

  // ramassage des objets (zone 2x2)
  bikes.forEach((k, p) => {
    if (!k.moved) return;
    const idx = r.items.findIndex(([ix, iy]) => k.x - ix >= 0 && k.x - ix <= 1 && k.y - iy >= 0 && k.y - iy <= 1);
    if (idx < 0) return;
    const kind = r.items[idx][2];
    r.items.splice(idx, 1);
    const o = bikes[1 - p];
    if (kind === 'turbo') k.fast = r.t + T(3000);
    else if (kind === 'frein') o.slow = r.t + T(3000);
    else if (kind === 'fantome') k.ghost = r.t + T(2000);
    else if (kind === 'gomme') {
      for (let i = 0; i < r.grid.length; i++) if (r.grid[i] === 1 || r.grid[i] === 2) r.grid[i] = 0;
      bikes.forEach((bk, j) => { r.grid[bk.y * W + bk.x] = j + 1; });
    }
    cast(r, { t: 'pick', p, k: kind, items: r.items, heads: bikes.map(bk => [bk.x, bk.y]) });
  });

  if (r.t >= r.nextItem) {
    r.nextItem = r.t + T(4000);
    if (r.items.length < 2 && spawnItem(r)) cast(r, { t: 'items', items: r.items });
  }
}

wss.on('connection', (ws, req) => {
  const id = (new URL(req.url, 'http://x').searchParams.get('r') || 'main').slice(0, 24);
  const r = getRoom(id);
  const slot = !r.slots[0] ? 0 : !r.slots[1] ? 1 : -1;
  if (slot >= 0) { r.slots[slot] = ws; r.players[slot] = null; } else r.specs.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'hello', you: slot, W, H, score: r.score, players: r.players, colors: COLORS });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (slot < 0) return;

    if (m.t === 'join') {
      if (r.phase !== 'wait') return;
      const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Pilote ' + (slot + 1);
      const color = COLORS.includes(m.color) ? m.color : null;
      const other = r.players[1 - slot];
      if (!color || (other && other.color === color)) { send(ws, { t: 'taken' }); return; }
      r.players[slot] = { name, color };
      cast(r, { t: 'lobby', players: r.players });
      if (ready(r)) newRound(r);
      return;
    }

    if (m.t !== 'dir' || !r.bikes || r.phase === 'end' || r.phase === 'wait') return;
    const d = m.d | 0; if (d < 0 || d > 3) return;
    const k = r.bikes[slot];
    const last = k.q.length ? k.q[k.q.length - 1] : k.d;
    if (d === last || (d + 2) % 4 === last) return;
    if (k.q.length < 3) k.q.push(d);
  });

  ws.on('close', () => {
    if (slot >= 0) {
      r.slots[slot] = null; r.players[slot] = null;
      stop(r); r.phase = 'wait'; r.score = [0, 0]; r.bikes = null; r.items = [];
      cast(r, { t: 'lobby', players: r.players });
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
