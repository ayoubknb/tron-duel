const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 60, H = 40, TICK_MS = 40, WIN = 5, MAXP = 5, WALL = 9;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const COLORS = ['#36f2ff', '#ff8a2a', '#ff4fd8', '#3dff7a', '#ffe14a', '#9d6bff', '#ff3b4a', '#e8eeff'];
const KINDS = ['turbo', 'frein', 'fantome', 'gomme', 'mur'];
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

// Points de départ : face à face à 2, en cercle (sens horaire) à 3+
function spawnPoints(n) {
  if (n === 2) return [{ x: 8, y: 20, d: 1 }, { x: W - 9, y: 20, d: 3 }];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = Math.round(29.5 + 22 * Math.cos(a)), y = Math.round(19.5 + 14 * Math.sin(a));
    const tx = -Math.sin(a), ty = Math.cos(a);
    const d = Math.abs(tx) >= Math.abs(ty) ? (tx > 0 ? 1 : 3) : (ty > 0 ? 2 : 0);
    pts.push({ x, y, d });
  }
  return pts;
}

function buildMap(map, spawns) {
  const g = new Uint8Array(W * H);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = WALL; };
  const add = (x, y) => { set(x, y); set(W - 1 - x, y); set(x, H - 1 - y); set(W - 1 - x, H - 1 - y); };
  map.build(add);
  // couloir de départ toujours libre devant chaque joueur
  for (const s of spawns) {
    const p = (s.d + 1) % 4;
    for (let st = -1; st <= 10; st++) for (let l = -1; l <= 1; l++) {
      const x = s.x + DX[s.d] * st + DX[p] * l, y = s.y + DY[s.d] * st + DY[p] * l;
      if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = 0;
    }
  }
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
let nextId = 1;

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, conns: [], host: null, phase: 'lobby', match: [], grid: null, bikes: null, items: [],
      loop: null, timeout: null, t: 0, nextItem: 0, bag: [], lastMap: -1, mapName: '', walls: [] };
    rooms.set(id, r);
  }
  return r;
}
function send(c, m) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
function cast(r, m) {
  const s = JSON.stringify(m);
  for (const c of r.conns) if (c.ws.readyState === 1) c.ws.send(s);
}
const joined = r => r.conns.filter(c => c.name);
function lobbyMsg(r) {
  return {
    t: 'lobby', host: r.host ? r.host.id : null, phase: r.phase === 'lobby' ? 'lobby' : 'game',
    players: joined(r).map(c => ({ id: c.id, name: c.name, color: c.color, score: c.score })),
    match: r.match.map(c => c.id),
  };
}
function stop(r) { clearInterval(r.loop); clearTimeout(r.timeout); r.loop = r.timeout = null; }

function pickMap(r) {
  if (!r.bag.length) {
    r.bag = MAPS.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (r.bag[r.bag.length - 1] === r.lastMap) r.bag.unshift(r.bag.pop());
  }
  r.lastMap = r.bag.pop();
  return MAPS[r.lastMap];
}

function roundMsg(r, live) {
  const m = {
    t: 'round', W, H, map: r.mapName, walls: r.walls, ids: r.match.map(c => c.id),
    heads: r.bikes.map(b => [b.x, b.y]), alive: r.bikes.map(b => b.alive),
    scores: r.match.map(c => c.score), items: r.items, live,
  };
  if (live) {
    m.cells = [];
    r.grid.forEach((v, i) => { if (v >= 1 && v <= MAXP) m.cells.push([i, v]); });
  }
  return m;
}

function startMatch(r) {
  r.match = joined(r).slice(0, MAXP);
  r.match.forEach(c => { c.score = 0; });
  r.phase = 'count';
  cast(r, lobbyMsg(r));
  newRound(r);
}

function backToLobby(r) {
  stop(r);
  r.phase = 'lobby'; r.bikes = null; r.items = []; r.match = [];
  cast(r, lobbyMsg(r));
}

function newRound(r) {
  stop(r);
  r.match = r.match.filter(c => c.open);
  if (r.match.length < 2) return backToLobby(r);
  const sp = spawnPoints(r.match.length);
  const map = pickMap(r);
  r.grid = buildMap(map, sp);
  r.walls = [];
  r.grid.forEach((v, i) => { if (v === WALL) r.walls.push(i); });
  r.bikes = sp.map(s => ({ ...s, q: [], acc: 0, fast: 0, slow: 0, ghost: 0, wall: 0, alive: true }));
  r.bikes.forEach((b, i) => { r.grid[b.y * W + b.x] = i + 1; });
  r.items = []; r.t = 0; r.nextItem = T(2000); r.mapName = map.name;
  r.phase = 'count';
  cast(r, roundMsg(r, false));
  r.timeout = setTimeout(() => {
    r.phase = 'play';
    cast(r, { t: 'go' });
    r.loop = setInterval(() => tick(r), TICK_MS);
  }, 3000);
}

function endRound(r, winner) {
  stop(r);
  if (winner >= 0) r.match[winner].score++;
  const match = r.match.some(c => c.score >= WIN);
  r.phase = 'end';
  cast(r, { t: 'end', winner, match, scores: r.match.map(c => c.score) });
  r.timeout = setTimeout(() => (match ? backToLobby(r) : newRound(r)), match ? 5000 : 2500);
}

function spawnItem(r) {
  for (let tries = 0; tries < 60; tries++) {
    const x = 1 + Math.floor(Math.random() * (W - 3)), y = 1 + Math.floor(Math.random() * (H - 3));
    let ok = true;
    for (let dx = 0; dx < 2 && ok; dx++) for (let dy = 0; dy < 2 && ok; dy++) if (r.grid[(y + dy) * W + x + dx] !== 0) ok = false;
    if (!ok) continue;
    if (r.bikes.some(b => b.alive && Math.abs(b.x - x) < 5 && Math.abs(b.y - y) < 5)) continue;
    if (r.items.some(([ix, iy]) => Math.abs(ix - x) < 4 && Math.abs(iy - y) < 4)) continue;
    r.items.push([x, y, KINDS[Math.floor(Math.random() * KINDS.length)]]);
    return true;
  }
  return false;
}

function tick(r) {
  r.t++;
  const bk = r.bikes;
  for (const k of bk) {
    k.moved = false;
    if (!k.alive) continue;
    const f = k.fast > r.t, s = k.slow > r.t;
    const period = f && !s ? 1 : s && !f ? 4 : 2;
    k.acc++;
    if (k.acc >= period) {
      k.moved = true; k.acc = 0;
      if (k.q.length) k.d = k.q.shift();
      k.x += DX[k.d]; k.y += DY[k.d];
    }
  }
  const hit = k => {
    if (!k.moved) return false;
    if (k.x < 0 || k.y < 0 || k.x >= W || k.y >= H) return true;
    const c = r.grid[k.y * W + k.x];
    if (c === WALL) return !(k.wall > r.t);
    return c !== 0 && !(k.ghost > r.t);
  };
  const dead = new Set();
  bk.forEach((k, i) => { if (k.alive && hit(k)) dead.add(i); });
  for (let i = 0; i < bk.length; i++) for (let j = i + 1; j < bk.length; j++) {
    const a = bk[i], b = bk[j];
    if (!a.alive || !b.alive || !(a.moved || b.moved)) continue;
    if (a.x === b.x && a.y === b.y && !(a.ghost > r.t) && !(b.ghost > r.t)) { dead.add(i); dead.add(j); }
  }
  bk.forEach((k, i) => {
    if (k.alive && k.moved && !dead.has(i) && r.grid[k.y * W + k.x] !== WALL) r.grid[k.y * W + k.x] = i + 1;
  });
  if (bk.some(k => k.moved)) cast(r, { t: 'tick', h: bk.map(k => [k.x, k.y]) });
  if (dead.size) {
    dead.forEach(i => { bk[i].alive = false; });
    cast(r, { t: 'crash', p: [...dead] });
  }

  const alive = [];
  bk.forEach((k, i) => { if (k.alive) alive.push(i); });
  if (alive.length <= 1) return endRound(r, alive.length ? alive[0] : -1);

  // ramassage des objets (zone 2x2)
  bk.forEach((k, p) => {
    if (!k.alive || !k.moved) return;
    const idx = r.items.findIndex(([ix, iy]) => k.x - ix >= 0 && k.x - ix <= 1 && k.y - iy >= 0 && k.y - iy <= 1);
    if (idx < 0) return;
    const kind = r.items[idx][2];
    r.items.splice(idx, 1);
    if (kind === 'turbo') k.fast = r.t + T(3000);
    else if (kind === 'frein') bk.forEach((o, j) => { if (j !== p && o.alive) o.slow = r.t + T(3000); });
    else if (kind === 'fantome') k.ghost = r.t + T(2000);
    else if (kind === 'mur') k.wall = r.t + T(3000);
    else if (kind === 'gomme') {
      for (let i = 0; i < r.grid.length; i++) if (r.grid[i] >= 1 && r.grid[i] <= MAXP) r.grid[i] = 0;
      bk.forEach((b, j) => { if (b.alive && r.grid[b.y * W + b.x] !== WALL) r.grid[b.y * W + b.x] = j + 1; });
    }
    cast(r, { t: 'pick', p, k: kind, items: r.items, heads: bk.map(b => [b.x, b.y]) });
  });

  if (r.t >= r.nextItem) {
    r.nextItem = r.t + T(4000);
    if (r.items.length < 2 && spawnItem(r)) cast(r, { t: 'items', items: r.items });
  }
}

wss.on('connection', (ws, req) => {
  const id = (new URL(req.url, 'http://x').searchParams.get('r') || 'main').slice(0, 24);
  const r = getRoom(id);
  const c = { id: nextId++, ws, name: null, color: null, score: 0, open: true };
  r.conns.push(c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(c, { t: 'hello', you: c.id, W, H, colors: COLORS, max: MAXP });
  send(c, lobbyMsg(r));
  if (r.phase !== 'lobby' && r.bikes) send(c, roundMsg(r, true));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      if (c.name) return;
      if (joined(r).length >= MAXP) { send(c, { t: 'full' }); return; }
      const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Pilote';
      const color = COLORS.includes(m.color) ? m.color : null;
      if (!color || joined(r).some(o => o.color === color)) { send(c, { t: 'taken' }); return; }
      c.name = name; c.color = color; c.score = 0;
      if (!r.host) r.host = c;
      cast(r, lobbyMsg(r));
      return;
    }

    if (m.t === 'start') {
      if (r.host === c && r.phase === 'lobby' && joined(r).length >= 2) startMatch(r);
      return;
    }

    if (m.t === 'dir') {
      const idx = r.match.indexOf(c);
      if (idx < 0 || !r.bikes || (r.phase !== 'count' && r.phase !== 'play')) return;
      const k = r.bikes[idx];
      if (!k.alive) return;
      const d = m.d | 0; if (d < 0 || d > 3) return;
      const last = k.q.length ? k.q[k.q.length - 1] : k.d;
      if (d === last || (d + 2) % 4 === last) return;
      if (k.q.length < 3) k.q.push(d);
    }
  });

  ws.on('close', () => {
    c.open = false;
    r.conns = r.conns.filter(o => o !== c);
    if (r.host === c) r.host = joined(r)[0] || null;
    const idx = r.match.indexOf(c);
    if (idx >= 0 && r.bikes && r.bikes[idx].alive && (r.phase === 'count' || r.phase === 'play')) {
      r.bikes[idx].alive = false;
      cast(r, { t: 'crash', p: [idx] });
    }
    if (!r.conns.length) { stop(r); rooms.delete(id); return; }
    cast(r, lobbyMsg(r));
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('Tron Duel sur le port ' + PORT));
