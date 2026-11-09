const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));
// three.js is served from this server (downloaded once from a CDN and cached), so phones don't depend on a CDN
const THREE_URLS = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js'];
const THREE_FILE = path.join(__dirname, 'three.min.js');
let threeJs = null;
try { threeJs = fs.readFileSync(THREE_FILE); } catch (e) {}
async function loadThree() {
  if (threeJs) return threeJs;
  for (const u of THREE_URLS) {
    try {
      const r = await fetch(u); if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer()); if (b.length < 100000) continue;
      threeJs = b; try { fs.writeFileSync(THREE_FILE, b); } catch (e) {}
      return b;
    } catch (e) { console.log('three.js download failed:', u, e.message); }
  }
  return null;
}
loadThree().then(b => console.log(b ? 'three.js ready' : 'three.js NOT available (clients will use CDN fallback)'));
const server = http.createServer(async (req, res) => {
  if (req.url.split('?')[0] === '/three.min.js') {
    const b = await loadThree();
    if (!b) { res.writeHead(502); return res.end('three.js unavailable'); }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    return res.end(b);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html());
});
const wss = new WebSocketServer({ server });
const players = new Map();
let nextId = 1;
const WEAPONS = 21; // 17 = Confetti Cannon, 18 = Whoopee Mine, 19 = Water Balloon Launcher, 20 = Swapper Gun; // 8 = Duel Gun, 9 = Shield, 10 = Katana, 11 = Spider Web, 12 = Pie Gun, 13 = Boxing Glove, 14 = Rubber Chicken, 15 = BONK Mallet, 16 = Plunger Gun
const rooms = new Map(); // room name -> { dur, endAt, timer, pu, puT }
const DURS = [30, 180, 300]; // seconds, picked by whoever creates the room

// ---- map data (keep in sync with the PU_SPOTS / SPAWNS lists in index.html)
const SPAWNS = [[34,0],[-34,0],[0,34],[0,-34],[34,15],[34,-15],[-34,15],[-34,-15],[15,34],[-15,34],[15,-34],[-15,-34]];
const SPOTS = [[0,4.8,0]]; // ONE power-up at a time: [x, standing height, z] = top of the central spire
// ---- power-ups
// ---- health packs: lie on the ground around the map, heal HEAL_AMT hp, come back after HEAL_RESPAWN ms (keep HP_SPOTS in sync with index.html)
const HP_SPOTS = [[19.5,19.5,2.38],[-19.5,19.5,2.38],[19.5,-19.5,2.38],[-19.5,-19.5,2.38]]; // [x, z, standing height]: one on top of each watch platform
const HEAL_AMT = 40, HEAL_RESPAWN = 20000;
// ---- cannon tubes (keep in sync with CANNONS in index.html) + fart clouds
const CANNON_POS = [[-8,-36],[36,-8],[8,36],[-36,8]];
const FART_SPOTS = [[30,27],[-30,27],[30,-27],[-30,-27]]; // pickups inside the corner compounds (keep in sync with index.html)
const FART_RESPAWN = 25000, CLOUD_MS = 9000, CLOUD_R = 4.5, COUGH_MS = 3500;
let nextCloud = 1;
const KINDS = ['big', 'health', 'speed', 'small', 'jump'];
const BUFF_MS = 40000;     // every power-up lasts 40 s
const PU_RESPAWN = 15000;  // a taken power-up reappears after 15 s

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
function closeRoom(name) {
  const r = rooms.get(name); if (!r) return;
  clearTimeout(r.timer); clearTimeout(r.spT); (r.puT || []).forEach(clearTimeout); (r.hT || []).forEach(clearTimeout); (r.fT || []).forEach(clearTimeout);
  (r.duels || []).forEach(d => { d.over = true; clearTimeout(d.t); });
  rooms.delete(name);
}
function endMatch(name) {
  const r = rooms.get(name); if (!r) return;
  closeRoom(name);
  const list = [...players.values()].filter(p => p.room === name);
  const res = list.map(p => ({ id: p.id, n: p.name, k: p.k, d: p.d })).sort((a, b) => b.k - a.k || a.d - b.d);
  for (const p of list) { send(p.ws, { t: 'end', res }); p.room = null; p.duel = null; } // everyone goes back to the lobby
} // Pistol, SMG, Rifle, Shotgun, Sniper, Spear, Bow, Slipper

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const room = (r, o, except) => { for (const p of players.values()) if (p.room === r && p !== except) send(p.ws, o); };
const pub = p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, hp: p.hp, mx: p.mx, k: p.k, d: p.d,
  bf: Object.entries(p.bf).map(([k, e]) => [k, Math.max(0, e - Date.now())]) });
// spawn on the point farthest from the other living players (random tie-break)
const spawn = p => {
  let best = SPAWNS[0], bd = -1;
  for (const s of SPAWNS) {
    let md = 1e9;
    for (const q of players.values()) if (q !== p && q.room === p.room && q.hp > 0) md = Math.min(md, Math.hypot(q.x - s[0], q.z - s[1]));
    md += Math.random() * 8;
    if (md > bd) { bd = md; best = s; }
  }
  p.x = best[0]; p.z = best[1]; p.y = 0; p.hp = 100; p.mx = 100; p.bf = {};
};
// (re)spawn the power-up of one pedestal after a delay; prefers a kind that is not already lying around
function schedulePU(r, name, i) {
  clearTimeout(r.puT[i]);
  r.puT[i] = setTimeout(() => {
    if (rooms.get(name) !== r) return;
    const used = r.pu.filter(Boolean), free = KINDS.filter(k => !used.includes(k)), pool = free.length ? free : KINDS;
    const k = pool[Math.random() * pool.length | 0];
    r.pu[i] = k; room(name, { t: 'pu+', i, k });
  }, PU_RESPAWN);
}
function giveBuff(p, k) {
  if (k === 'big') delete p.bf.small;      // big and small cancel each other
  if (k === 'small') delete p.bf.big;
  p.bf[k] = Date.now() + BUFF_MS;
  if (k === 'health') { p.mx = 200; p.hp = Math.min(200, p.hp + 100); send(p.ws, { t: 'hp', hp: p.hp, mx: 200, q: 1 }); }
  room(p.room, { t: 'buff', id: p.id, k, ms: BUFF_MS });
}
// ---- DUEL GUN + 2D mini-games
// Every DUEL_EVERY ms the player with the most kills gets the Duel Gun. Shooting it near another player
// (within DUEL_R) sends both into a mini-game. To add a game later: add it to GAMES and give it the
// same start/move/result functions as tic-tac-toe, and add it to MINI in index.html.
const DUEL_R = 9, TURN_MS = 12000, DUEL_EVERY = 60000, DUEL_END_MS = 2500, SPW = 8;
const LN = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const tttResult = b => {
  for (const l of LN) if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return { w: b[l[0]] - 1, line: l };
  return b.every(Boolean) ? { w: 'd', line: null } : null;
};
const GAMES = { ttt: { players: 2 }, race: { players: 2 }, boat: { players: 2 }, hoop: { players: 2 }, flap: { players: 2 }, pen: { players: 2 }, pong: { players: 2 } };
// arcade games: hoop (most baskets in HOOP_MS), flap (same pipes, last bird flying wins), pong (first to PONG_WIN), pen (penalty shootout, server-run turns)
const HOOP_MS = 40000, FLAP_MS = 90000, PONG_MS = 90000, PONG_WIN = 3, PEN_PICK = 7000, PEN_ANIM = 3000;
const GO_MS = 3000, RACE_MS = 90000, LAP_N = 200, MIN_LAP_MS = 8000; // 2D races: 3 s countdown, one lap, 90 s cap (LAP_N must match index.html)
// ---- exclusive weapons: only a duel winner gets one, for XW_MS, lost on death
const SHLD = 9, KAT = 10, WEBW = 11, PIE = 12, XWS = [SHLD, KAT, WEBW], XW_MS = 40000;
const CONF = 17, MINE = 18, BALL = 19, SWP = 20;
const GLIT_MS = 5000, SOAK_MS = 4000, MINE_R = 1.4, MINE_MS = 90000, MINE_DMG = 45, MINE_MAX = 3, SWAP_CD = 1000, SWAP_DMG = 15;
const GLV = 13, PLG = 16, FUNCAP = { 13: 80, 14: 44, 15: 120, 16: 24, 17: 40, 19: 44 }; // funny weapons: max damage per hit (head shots count double on the client)
const STUCK_MS = 7000, SUF_DMG = 6, SUF_TICK = 400; // web: 6 hp every 0.4 s = 15 hp/s, a full 100 hp bar lasts ~6.7 s
function dropXW(p) {
  if (!p.xw) return;
  p.xw = null; p.blk = false;
  if (p.room) {
    room(p.room, { t: 'xw', id: p.id, w: -1 });
    const r = rooms.get(p.room);
    if (r && !r.sp && !r.spAt && !r.duels.size) schedSP(r, p.room, DUEL_EVERY); // next duel gun 1 min after the prize is over
  }
}
function giveXW(p) {
  const w = XWS[Math.random() * XWS.length | 0];
  p.xw = { w, until: Date.now() + XW_MS };
  room(p.room, { t: 'xw', id: p.id, w, ms: XW_MS });
}
function killPlayer(k, v, w) {
  v.hp = 0; v.d++; k.k++; v.deadAt = Date.now(); v.bf = {}; v.mx = 100; v.stuck = null; v.fart = 0; send(v.ws, { t: 'fart', n: 0 }); // buffs and fart charges are lost on death
  dropXW(v);
  const r = rooms.get(v.room); if (r && r.sp === v.id) { setSP(r, v.room, null); schedSP(r, v.room, DUEL_EVERY); } // dead players lose the duel gun
  room(k.room, { t: 'kill', killer: k.id, victim: v.id, kn: k.name, vn: v.name, k: k.k, d: v.d, w });
}
// is the shooter in front of a guarding shield-bearer?
function guarded(v, p) {
  if (!v.blk || !v.xw || v.xw.w !== SHLD) return false;
  const dx = p.x - v.x, dz = p.z - v.z, l = Math.hypot(dx, dz) || 1;
  return (-Math.sin(v.ry) * dx - Math.cos(v.ry) * dz) / l > 0.35; // ~70 degree cone in front
}
const INV_MS = 3000; // invincibility after winning a duel
const spNext = r => r.spAt ? Math.max(0, r.spAt - Date.now()) : 0; // 0 = no countdown running
// schedule the next duel gun in ms (null = none scheduled)
function schedSP(r, name, ms) {
  if (rooms.get(name) !== r) return;
  clearTimeout(r.spT);
  r.spT = ms == null ? null : setTimeout(() => giveSP(name), ms);
  r.spAt = ms == null ? 0 : Date.now() + ms;
  room(name, { t: 'sp', id: 0, on: false, next: spNext(r) });
}

// give the gun to player id (null = take it away from whoever has it); always re-syncs the countdown
function setSP(r, name, id) {
  if (r.sp === id) return room(name, { t: 'sp', id: 0, on: false, next: spNext(r) });
  if (r.sp) room(name, { t: 'sp', id: r.sp, on: false, next: spNext(r) });
  r.sp = id;
  if (id) room(name, { t: 'sp', id, on: true, next: spNext(r) });
}
function giveSP(name) {
  const r = rooms.get(name); if (!r) return;
  const c = [...players.values()].filter(p => p.room === name && p.hp > 0 && !p.duel).sort((a, b) => b.k - a.k || a.d - b.d);
  if (!c.length) return schedSP(r, name, 5000); // nobody can hold it right now, retry shortly
  r.spAt = 0; r.spT = null; // no countdown while someone holds the gun / duels / has the prize
  setSP(r, name, c[0].id);
}
function startDuel(a, b, game) {
  const r = rooms.get(a.room); if (!r) return;
  const du = { game, ps: [a, b], board: Array(9).fill(0), turn: 0, res: null, line: null, t: 0, over: false, r, prog: [0, 0], last: [0, 0], go: Date.now() + GO_MS,
    seed: Math.random() * 2147483647 | 0, sc: [0, 0], lastS: [0, 0], fl: [{ s: 0, a: 1 }, { s: 0, a: 1 }], pen: { n: 0, sc: [0, 0], kk: [0, 0], ch: [null, null], ph: 'wait' } };
  a.duel = b.duel = du; r.duels.add(du);
  setSP(r, a.room, null); // the gun is used up
  room(a.room, { t: 'dstart', ids: [a.id, b.id] });
  du.ps.forEach((p, i) => send(p.ws, { t: 'duel', game, you: i, opp: du.ps[1 - i].name, board: du.board.slice(), turn: 0, res: null, line: null, left: TURN_MS, prog: [0, 0], cd: GO_MS, seed: du.seed }));
  if (game === 'ttt') armDuel(du);
  else if (game !== 'race' && game !== 'boat') arcStart(du);
  else du.t = setTimeout(() => { // nobody finished: the leader wins
    if (du.over || du.res !== null) return;
    raceEnd(du, du.prog[0] > du.prog[1] ? 0 : du.prog[1] > du.prog[0] ? 1 : 'd');
  }, GO_MS + RACE_MS);
}
function armDuel(du) { // too slow? a random cell is played for you
  clearTimeout(du.t);
  du.t = setTimeout(() => {
    if (du.over || du.res !== null) return;
    const free = du.board.map((v, i) => v ? -1 : i).filter(i => i >= 0);
    duelMove(du, du.turn, free[Math.random() * free.length | 0]);
  }, TURN_MS);
}
// Car / Boat Race: every phone drives its own vehicle and sends [x, y, angle, progress] (progress = lap position, 0..LAP_N).
// The server relays it to the opponent and decides the winner: first to LAP_N, but never faster than MIN_LAP_MS.
function raceUpd(du, pi, c) {
  const now = Date.now();
  if (du.over || du.res !== null || now < du.go || !Array.isArray(c) || c.length !== 4 || !c.every(Number.isFinite)) return;
  const tot = Math.min(c[3], du.prog[pi] + 40); // a position report can't jump more than 40 track points
  du.prog[pi] = Math.max(du.prog[pi], tot);
  du.ps[1 - pi] && send(du.ps[1 - pi].ws, { t: 'dpos', s: [c[0], c[1], c[2], tot] });
  if (tot >= LAP_N && now - du.go >= MIN_LAP_MS) raceEnd(du, pi);
}
function raceEnd(du, w) {
  if (du.over || du.res !== null) return;
  du.res = w; clearTimeout(du.t);
  du.ps.forEach(p => send(p.ws, { t: 'dstate', prog: du.prog.slice(), sc: du.sc.slice(), res: w }));
  du.t = setTimeout(() => endDuel(du, w), DUEL_END_MS);
}
// ---- arcade mini-games
const cmpS = s => s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : 'd';
function arcStart(du) {
  const g = du.game;
  if (g === 'pen') du.t = setTimeout(() => penOpen(du), GO_MS);
  else du.t = setTimeout(() => {
    if (du.over || du.res !== null) return;
    if (g === 'flap') flapCheck(du, true); else raceEnd(du, cmpS(du.sc));
  }, GO_MS + (g === 'hoop' ? HOOP_MS + 1500 : g === 'flap' ? FLAP_MS : PONG_MS));
}
function flapCheck(du, force) { // last bird flying wins; a crashed bird only loses once the other has passed its score
  const [a, b] = du.fl; let w = null;
  if (!a.a && !b.a) w = cmpS([a.s, b.s]);
  else if (!a.a && b.s > a.s) w = 1;
  else if (!b.a && a.s > b.s) w = 0;
  else if (force) w = cmpS([a.s, b.s]);
  if (w !== null) { du.sc = [a.s, b.s]; raceEnd(du, w); }
}
function arcUpd(du, pi, c) {
  if (du.over || du.res !== null) return;
  const g = du.game, now = Date.now(), peer = du.ps[1 - pi];
  if (g === 'pen') return penPick(du, pi, c);
  if (now < du.go - 300 || !Array.isArray(c) || !c.every(Number.isFinite)) return;
  const rel = s => peer && send(peer.ws, { t: 'dpos', s });
  if (g === 'hoop') {
    if (c.length !== 1 || now > du.go + HOOP_MS + 1500) return;
    const s = Math.min(c[0] | 0, du.sc[pi] + 1);
    if (s > du.sc[pi] && now - du.lastS[pi] > 600) { du.sc[pi] = s; du.lastS[pi] = now; rel([s]); }
  } else if (g === 'flap') {
    if (c.length !== 3) return;
    const f = du.fl[pi]; if (!f.a) return;
    const mx = Math.floor(Math.max(0, (now - du.go) / 1000 - 1.6) * 0.95) + 1; // pipes can't be passed faster than they scroll
    f.s = Math.max(f.s, Math.min(c[0] | 0, mx, f.s + 1));
    if (!c[1]) f.a = 0;
    du.sc = [du.fl[0].s, du.fl[1].s];
    rel([f.s, f.a, c[2]]);
    flapCheck(du, false);
  } else if (g === 'pong') {
    if (pi === 0 && c.length === 7) { // the host phone simulates the ball and reports the score
      du.sc = [Math.max(du.sc[0], Math.min(c[5] | 0, du.sc[0] + 1)), Math.max(du.sc[1], Math.min(c[6] | 0, du.sc[1] + 1))];
      rel([c[0], c[1], c[2], c[3], c[4], du.sc[0], du.sc[1]]);
      if (du.sc[0] >= PONG_WIN) raceEnd(du, 0); else if (du.sc[1] >= PONG_WIN) raceEnd(du, 1);
    } else if (pi === 1 && c.length === 1) rel([c[0]]);
  }
}
// Penalty shootout: 5 kicks each, then sudden death. Both pick a zone (0-5 = 3 columns x 2 rows) at the same time.
const penWin = (sc, kk) => {
  const [a, b] = sc, [ka, kb] = kk;
  if (ka <= 5 && kb <= 5) { if (a > b + 5 - kb) return 0; if (b > a + 5 - ka) return 1; if (ka === 5 && kb === 5) return a === b ? null : (a > b ? 0 : 1); }
  else if (ka === kb) { if (a !== b) return a > b ? 0 : 1; if (ka >= 10) return 'd'; }
  return null;
};
function penOpen(du) {
  if (du.over || du.res !== null) return;
  const p = du.pen; p.ch = [null, null]; p.ph = 'pick';
  du.ps.forEach(q => send(q.ws, { t: 'dstate', pen: { open: 1, n: p.n, sh: p.n % 2, ms: PEN_PICK, sc: p.sc.slice(), kk: p.kk.slice() } }));
  clearTimeout(du.t); du.t = setTimeout(() => penResolve(du), PEN_PICK + 250);
}
function penPick(du, pi, c) {
  const p = du.pen;
  if (p.ph !== 'pick' || !Number.isInteger(c) || c < 0 || c > 5 || p.ch[pi] !== null) return;
  p.ch[pi] = c;
  if (p.ch[0] !== null && p.ch[1] !== null) penResolve(du);
}
function penResolve(du) {
  const p = du.pen; if (p.ph !== 'pick' || du.over) return;
  p.ph = 'anim'; clearTimeout(du.t);
  const sh = p.n % 2, sz = p.ch[sh] ?? (Math.random() * 6 | 0), kz = p.ch[1 - sh] ?? (Math.random() * 6 | 0);
  const save = sz === kz || (sz % 3 === kz % 3 && Math.random() < 0.35); // exact guess saves; right side wrong height = fingertip chance
  if (!save) p.sc[sh]++;
  p.kk[sh]++;
  const w = penWin(p.sc, p.kk), m = { t: 'dstate', pen: { n: p.n, sh, sz, kz, out: save ? 'save' : 'goal', sc: p.sc.slice(), kk: p.kk.slice() } };
  p.n++;
  if (w !== null) { du.res = w; m.res = w; }
  du.ps.forEach(q => send(q.ws, m));
  du.t = setTimeout(() => { if (w !== null) endDuel(du, w); else penOpen(du); }, w !== null ? PEN_ANIM + DUEL_END_MS : PEN_ANIM);
}
function duelMove(du, pi, c) {
  if (du.game === 'race' || du.game === 'boat') return raceUpd(du, pi, c);
  if (du.game !== 'ttt') return arcUpd(du, pi, c);
  if (du.over || du.res !== null || du.turn !== pi || !Number.isInteger(c) || c < 0 || c > 8 || du.board[c]) return;
  du.board[c] = pi + 1;
  const r = tttResult(du.board);
  if (r) { du.res = r.w; du.line = r.line; } else du.turn = 1 - pi;
  const st = { t: 'dstate', board: du.board.slice(), turn: du.turn, res: du.res, line: du.line, left: TURN_MS };
  du.ps.forEach(p => send(p.ws, st));
  clearTimeout(du.t);
  if (du.res !== null) du.t = setTimeout(() => endDuel(du, du.res), DUEL_END_MS); else armDuel(du);
}
// res: 0 / 1 = index of the winner, 'd' = draw (both live). The loser is eliminated and the winner gets a kill.
function endDuel(du, res) {
  if (du.over) return; du.over = true; clearTimeout(du.t);
  const [a, b] = du.ps;
  du.r.duels.delete(du);
  if (a.duel === du) a.duel = null; if (b.duel === du) b.duel = null;
  const win = res === 'd' ? null : du.ps[res], lose = res === 'd' ? null : du.ps[1 - res];
  room(a.room, { t: 'dend', ids: [a.id, b.id], dead: lose ? lose.id : 0 });
  if (!lose) return schedSP(du.r, a.room, DUEL_EVERY); // draw: no prize, the clock restarts
  killPlayer(win, lose, SPW);
  if (win.hp > 0) { // prize: a random exclusive weapon for 40 s + full health + 3 s invincibility
    giveXW(win);
    win.hp = win.mx; win.inv = Date.now() + INV_MS;
    send(win.ws, { t: 'hp', hp: win.hp, mx: win.mx, q: 1 });
    room(a.room, { t: 'inv', id: win.id, ms: INV_MS });
  } else schedSP(du.r, a.room, DUEL_EVERY);
}

// exclusive weapons expire; webbed players suffocate
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) if (p.room && p.xw && now >= p.xw.until) dropXW(p);
}, 500);
setInterval(() => {
  const now = Date.now();
  for (const v of players.values()) {
    if (!v.stuck || !v.room) continue;
    const by = players.get(v.stuck.by);
    if (v.hp <= 0 || now >= v.stuck.until || !by || by.room !== v.room) { v.stuck = null; room(v.room, { t: 'unstuck', id: v.id }); continue; }
    v.hp -= SUF_DMG;
    if (v.hp <= 0) { killPlayer(by, v, WEBW); continue; }
    send(v.ws, { t: 'hp', hp: v.hp, mx: v.mx, q: 1 });
  }
}, SUF_TICK);

// whoopee mines: step on one (not your own) and get blasted into the air
setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms) {
    if (!r.mines || !r.mines.length) continue;
    r.mines = r.mines.filter(m => {
      if (m.until <= now) { room(name, { t: 'mine-', id: m.id, quiet: 1 }); return false; }
      for (const v of players.values()) {
        if (v.room !== name || v.id === m.by || v.hp <= 0 || v.duel || v.inv > now) continue;
        if (Math.hypot(v.x - m.x, v.z - m.z) > MINE_R || Math.abs(v.y - m.y) > 1.3) continue;
        const a = Math.random() * 6.283, sp = 3 + Math.random() * 3;
        room(name, { t: 'mine-', id: m.id, x: m.x, y: m.y, z: m.z, v: v.id, by: m.by });
        send(v.ws, { t: 'whoop', vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 15 });
        v.hp -= MINE_DMG;
        const k = players.get(m.by);
        if (v.hp <= 0) { if (k && k.room === name) killPlayer(k, v, MINE); else { v.hp = 1; send(v.ws, { t: 'hp', hp: 1, mx: v.mx }); } }
        else send(v.ws, { t: 'hp', hp: v.hp, mx: v.mx });
        return false;
      }
      return true;
    });
  }
}, 120);

// fart clouds: everyone (except the owner) standing in one starts coughing
setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms) {
    if (!r.clouds || !r.clouds.length) continue;
    r.clouds = r.clouds.filter(c => c.until > now);
    for (const v of players.values()) {
      if (v.room !== name || v.hp <= 0 || v.duel || v.coughUntil - now > 1500) continue;
      for (const c of r.clouds) {
        if (c.by === v.id || Math.hypot(v.x - c.x, v.z - c.z) > CLOUD_R || Math.abs(v.y - c.y) > 3.5) continue;
        v.coughUntil = now + COUGH_MS;
        room(name, { t: 'cough', id: v.id, ms: COUGH_MS });
        break;
      }
    }
  }
}, 400);

// expire buffs
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.room) continue;
    for (const k of Object.keys(p.bf)) {
      if (now < p.bf[k]) continue;
      delete p.bf[k]; room(p.room, { t: 'bend', id: p.id, k });
      if (k === 'health') { p.mx = 100; if (p.hp > 100) p.hp = 100; send(p.ws, { t: 'hp', hp: p.hp, mx: 100, q: 1 }); }
    }
  }
}, 500);

wss.on('connection', ws => {
  const p = { id: nextId++, ws, room: null, name: 'P', x: 0, y: 0, z: 0, ry: 0, hp: 100, mx: 100, bf: {}, k: 0, d: 0, deadAt: 0, duel: null, inv: 0, xw: null, blk: false, stuck: null, fart: 0, coughUntil: 0, fxAt: 0, swAt: 0 };
  players.set(p.id, p);
  ws.on('message', m => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.t === 'join') {
      p.room = String(d.room || 'main').slice(0, 20);
      p.name = String(d.name || 'Player').slice(0, 12);
      p.k = 0; p.d = 0; p.fart = 0; p.coughUntil = 0; p.fxAt = 0;
      let r = rooms.get(p.room);
      if (!r) { // first player creates the room and sets the match length
        const dur = DURS.includes(+d.dur) ? +d.dur : 180, name = p.room;
        r = { dur, endAt: Date.now() + dur * 1000 };
        r.timer = setTimeout(() => endMatch(name), dur * 1000);
        const kinds = shuffle(KINDS.slice());
        r.pu = SPOTS.map((_, i) => kinds[i % kinds.length]); // one power-up waiting on the spire
        r.puT = [];
        r.hk = HP_SPOTS.map(() => true); r.hT = [];
        r.fk = FART_SPOTS.map(() => true); r.fT = []; r.clouds = []; r.mines = []; r.mid = 1;
        r.sp = null; r.duels = new Set(); r.spAt = Date.now() + DUEL_EVERY;
        r.spT = setTimeout(() => giveSP(name), DUEL_EVERY);
        rooms.set(name, r);
      }
      spawn(p);
      const others = [...players.values()].filter(q => q.room === p.room && q !== p).map(pub);
      send(ws, { t: 'init', me: pub(p), players: others, left: Math.max(0, r.endAt - Date.now()), dur: r.dur, pu: r.pu, hk: r.hk, fk: r.fk, mn: r.mines.map(m => ({ id: m.id, x: m.x, y: m.y, z: m.z, by: m.by, ms: Math.max(0, m.until - Date.now()) })), cl: r.clouds.map(c => ({ id: c.id, x: c.x, y: c.y, z: c.z, by: c.by, ms: Math.max(0, c.until - Date.now()) })) });
      room(p.room, { t: 'new', p: pub(p) }, p);
      send(ws, { t: 'sp', id: r.sp || 0, on: !!r.sp, next: spNext(r) }); // current gun holder + countdown for the newcomer
    } else if (!p.room) return;
    else if (d.t === 'pos') {
      if (p.hp <= 0 || p.stuck) return; // webbed players stay where the web put them
      p.blk = d.b === 1 && !!p.xw && p.xw.w === SHLD;
      p.x = d.x; p.y = d.y; p.z = d.z; p.ry = d.ry;
      room(p.room, { t: 'pos', id: p.id, x: d.x, y: d.y, z: d.z, ry: d.ry, s: d.s | 0 }, p);
    } else if (d.t === 'shoot') {
      room(p.room, { t: 'shoot', id: p.id, from: d.from, to: d.to }, p);
    } else if (d.t === 'swing') { // boxing glove / rubber chicken / mallet: relay the effect to the room
      const ok = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite), k = d.k | 0;
      if (p.hp <= 0 || p.duel || ![13, 14, 15].includes(k) || !ok(d.from) || !ok(d.to)) return;
      room(p.room, { t: 'swing', id: p.id, k, from: d.from, to: d.to, h: d.h | 0 }, p);
    } else if (d.t === 'arrow') {
      const ok = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
      if (p.hp <= 0 || !ok(d.from) || !ok(d.v)) return;
      let k = [5, 6, 7, SHLD, WEBW, PIE, PLG, BALL].includes(d.k | 0) ? d.k | 0 : 6; // spear, bow, slipper, shield, web, pie
      if ((k === SHLD || k === WEBW) && (!p.xw || p.xw.w !== k)) return; // exclusive weapons need the prize
      room(p.room, { t: 'arrow', id: p.id, from: d.from, v: d.v, k }, p);
    } else if (d.t === 'duel') {
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel || r.sp !== p.id) return; // only the gun holder
      const to = d.to; if (!Array.isArray(to) || to.length !== 3 || !to.every(Number.isFinite)) return;
      const fr = Array.isArray(d.from) && d.from.length === 3 && d.from.every(Number.isFinite) ? d.from : to; // line of fire: from the gun to where the shot landed
      const dx = to[0] - fr[0], dy = to[1] - fr[1], dz = to[2] - fr[2], l2 = dx * dx + dy * dy + dz * dz || 1;
      let v = null, bd = DUEL_R; // anyone within DUEL_R of the line of fire gets picked (nearest wins)
      for (const q of players.values()) {
        if (q === p || q.room !== p.room || q.hp <= 0 || q.duel) continue;
        const px = q.x, py = q.y + 1, pz = q.z, t = Math.max(0, Math.min(1, ((px - fr[0]) * dx + (py - fr[1]) * dy + (pz - fr[2]) * dz) / l2));
        const dd = Math.hypot(px - fr[0] - dx * t, py - fr[1] - dy * t, pz - fr[2] - dz * t);
        if (dd < bd) { bd = dd; v = q; }
      }
      if (!v) return send(ws, { t: 'dmiss' });
      const gk = Object.keys(GAMES); // 'rnd' (or anything unknown) = a random mini-game every time
      startDuel(p, v, GAMES[d.g] ? d.g : gk[Math.random() * gk.length | 0]);
    } else if (d.t === 'dmove') {
      const du = p.duel; if (du) duelMove(du, du.ps.indexOf(p), d.c);
    } else if (d.t === 'pickup') {
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel) return;
      const i = d.i | 0, k = r.pu[i], s = SPOTS[i];
      if (!k || !s) return;
      if (Math.hypot(p.x - s[0], p.z - s[2]) > 3.5 || Math.abs(p.y - s[1]) > 5) return; // must really be up there
      r.pu[i] = null;
      room(p.room, { t: 'pu-', i, by: p.id });
      giveBuff(p, k);
      schedulePU(r, p.room, i);
    } else if (d.t === 'hpick') {
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel) return;
      const i = d.i | 0, s = HP_SPOTS[i];
      if (!s || !r.hk[i] || p.hp >= p.mx) return; // already taken, or you're at full health
      if (Math.hypot(p.x - s[0], p.z - s[1]) > 3.5 || Math.abs(p.y - s[2]) > 2) return; // must really be up there
      r.hk[i] = false;
      p.hp = Math.min(p.mx, p.hp + HEAL_AMT);
      send(ws, { t: 'hp', hp: p.hp, mx: p.mx, q: 1 });
      room(p.room, { t: 'hp-', i, by: p.id });
      const name = p.room;
      r.hT[i] = setTimeout(() => { if (rooms.get(name) !== r) return; r.hk[i] = true; room(name, { t: 'hp+', i }); }, HEAL_RESPAWN);
    } else if (d.t === 'cannon') { // somebody stepped into a cannon: everyone else sees/hears the boom
      const c = CANNON_POS[d.i | 0];
      if (!c || p.hp <= 0 || p.duel || Math.hypot(p.x - c[0], p.z - c[1]) > 5) return;
      room(p.room, { t: 'cannon', id: p.id, i: d.i | 0 }, p);
    } else if (d.t === 'splat') { // landing effect of a cannon flight
      const now = Date.now(), ok = [d.x, d.y, d.z].every(Number.isFinite);
      if (!ok || p.hp <= 0 || now - p.fxAt < 400) return;
      p.fxAt = now;
      room(p.room, { t: 'splat', x: Math.max(-45, Math.min(45, d.x)), y: Math.max(0, Math.min(10, d.y)), z: Math.max(-45, Math.min(45, d.z)) }, p);
    } else if (d.t === 'fpick') {
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel || p.fart) return; // one charge at a time
      const i = d.i | 0, s = FART_SPOTS[i];
      if (!s || !r.fk[i] || Math.hypot(p.x - s[0], p.z - s[1]) > 3.5 || Math.abs(p.y) > 2.5) return;
      r.fk[i] = false; p.fart = 1;
      send(ws, { t: 'fart', n: 1 });
      room(p.room, { t: 'f-', i, by: p.id });
      const name = p.room;
      r.fT[i] = setTimeout(() => { if (rooms.get(name) !== r) return; r.fk[i] = true; room(name, { t: 'f+', i }); }, FART_RESPAWN);
    } else if (d.t === 'fdrop') {
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel || !p.fart) return;
      p.fart = 0;
      const c = { id: nextCloud++, x: p.x, y: p.y, z: p.z, by: p.id, until: Date.now() + CLOUD_MS };
      r.clouds.push(c);
      send(ws, { t: 'fart', n: 0 });
      room(p.room, { t: 'cloud+', id: c.id, x: c.x, y: c.y, z: c.z, ms: CLOUD_MS, by: p.id });
    } else if (d.t === 'mine') { // whoopee cushion mine: hidden trap on the ground
      const r = rooms.get(p.room); if (!r || p.hp <= 0 || p.duel || ![d.x, d.y, d.z].every(Number.isFinite)) return;
      if (Math.hypot(d.x - p.x, d.z - p.z) > 4) return;
      const mine = r.mines.filter(m => m.by === p.id);
      if (mine.length >= MINE_MAX) { r.mines = r.mines.filter(m => m !== mine[0]); room(p.room, { t: 'mine-', id: mine[0].id, quiet: 1 }); }
      const m = { id: r.mid++, x: d.x, y: d.y, z: d.z, by: p.id, until: Date.now() + MINE_MS };
      r.mines.push(m);
      room(p.room, { t: 'mine+', id: m.id, x: m.x, y: m.y, z: m.z, by: p.id, ms: MINE_MS });
    } else if (d.t === 'swap') { // swapper gun: trade places with the player that was hit
      const v = players.get(d.id), now = Date.now();
      if (!v || v === p || v.room !== p.room || p.hp <= 0 || v.hp <= 0 || p.duel || v.duel || p.stuck || v.stuck || now - p.swAt < SWAP_CD || v.inv > now) return;
      if (Math.hypot(v.x - p.x, v.z - p.z) > 100) return;
      p.swAt = now;
      if (guarded(v, p)) { send(v.ws, { t: 'blocked', me: 'v' }); send(p.ws, { t: 'blocked', me: 'a' }); return; } // a raised shield stops it
      const a = [p.x, p.y, p.z], b = [v.x, v.y, v.z];
      p.x = b[0]; p.y = b[1]; p.z = b[2]; v.x = a[0]; v.y = a[1]; v.z = a[2];
      send(p.ws, { t: 'tp', x: b[0], y: b[1], z: b[2], w: v.name }); send(v.ws, { t: 'tp', x: a[0], y: a[1], z: a[2], w: p.name });
      room(p.room, { t: 'swapfx', a, b });
      v.hp -= v.bf.big ? SWAP_DMG * 0.6 : SWAP_DMG; // swapping hurts a little
      if (v.hp <= 0) killPlayer(p, v, SWP); else send(v.ws, { t: 'hp', hp: v.hp, mx: v.mx });
    } else if (d.t === 'respawn') {
      // the player picks a weapon on the respawn panel and presses Respawn
      if (p.hp > 0 || Date.now() - p.deadAt < 2500) return;
      spawn(p);
      room(p.room, { t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z });
    } else if (d.t === 'hit') {
      const v = players.get(d.id);
      if (!v || v.room !== p.room || v.hp <= 0 || p.hp <= 0 || v.duel || p.duel) return; // nobody can be shot during a duel
      if (v.inv > Date.now()) return; // just won a duel: invincible
      const wi = Math.max(0, Math.min(WEAPONS - 1, d.w | 0));
      if (XWS.includes(wi) && (!p.xw || p.xw.w !== wi)) return; // can't fake an exclusive weapon
      if (wi === WEBW) return; // webs do their damage through suffocation, see 'web'
      if (wi === MINE || wi === SWP) return; // mines hurt through the mine tick, the swapper does no damage
      let dmg = Math.min(200, Math.max(1, +d.dmg || 25));
      if (wi === PIE) dmg = Math.min(dmg, 8); // a pie only splats
      if (FUNCAP[wi]) dmg = Math.min(dmg, FUNCAP[wi]);
      const gd = guarded(v, p);
      if (gd) { // shield up and facing the shooter: 95% of the damage is absorbed
        send(v.ws, { t: 'blocked', me: 'v' }); send(p.ws, { t: 'blocked', me: 'a' });
        dmg *= 0.05;
      } else if (wi === KAT || wi === SHLD) dmg = 9999; // katana and thrown shield: one hit kills, even a giant
      else if (v.bf.big) dmg *= 0.6; // giants take 40% less damage
      v.hp -= dmg;
      if (wi === PIE && !gd && v.hp > 0) room(p.room, { t: 'pied', id: v.id, ms: 5000 }); // cream in the face for everyone to see
      if (wi === PLG && !gd && v.hp > 0) room(p.room, { t: 'plunged', id: v.id, ms: 2500 }); // plunger stuck on the face
      if (wi === CONF && !gd && v.hp > 0) room(p.room, { t: 'glit', id: v.id, ms: GLIT_MS }); // glitter: everybody sees where the victim is
      if (wi === BALL && !gd && v.hp > 0) room(p.room, { t: 'soak', id: v.id, ms: SOAK_MS }); // soaked: slower + wet footprints
      if (wi === GLV && !gd && v.hp > 0) { // boxing glove: launch the victim away from the puncher (giants resist, tiny players fly further)
        const dx = v.x - p.x, dz = v.z - p.z, l = Math.hypot(dx, dz) || 1, m = (v.bf.big ? 0.6 : v.bf.small ? 1.3 : 1) * 17 / l;
        send(v.ws, { t: 'kb', vx: dx * m, vz: dz * m, vy: 6.5 });
      }
      if (v.hp > 0) return send(v.ws, { t: 'hp', hp: v.hp, mx: v.mx });
      killPlayer(p, v, wi);
    } else if (d.t === 'web') {
      // the web-thrower's client says: player d.id was hit and sticks to the wall at d.p
      const v = players.get(d.id), ok = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
      if (!p.xw || p.xw.w !== WEBW || p.hp <= 0 || p.duel || !v || v === p || v.room !== p.room || v.hp <= 0 || v.duel || v.stuck || v.inv > Date.now()) return;
      if (!ok(d.p, 3) || !ok(d.n, 2) || !ok(d.w, 3) || Math.hypot(v.x - d.p[0], v.z - d.p[2]) > 22) return;
      if (guarded(v, p)) { send(v.ws, { t: 'blocked', me: 'v' }); send(p.ws, { t: 'blocked', me: 'a' }); return; } // a raised shield stops webs
      v.x = d.p[0]; v.z = d.p[2];
      v.stuck = { until: Date.now() + STUCK_MS, by: p.id };
      room(p.room, { t: 'stuck', id: v.id, p: [v.x, v.y, v.z], n: d.n, w: d.w, ms: STUCK_MS });
    }
  });
  ws.on('close', () => {
    p.stuck = null; dropXW(p);
    { const mr = rooms.get(p.room); if (mr && mr.mines) mr.mines = mr.mines.filter(m => { if (m.by !== p.id) return true; room(p.room, { t: 'mine-', id: m.id, quiet: 1 }); return false; }); } // a leaving player takes their mines along
    if (p.duel) endDuel(p.duel, p.duel.ps.indexOf(p) === 0 ? 1 : 0); // leaving mid-duel = forfeit
    const rr = rooms.get(p.room); if (rr && rr.sp === p.id) { setSP(rr, p.room, null); schedSP(rr, p.room, DUEL_EVERY); }
    players.delete(p.id);
    if (p.room && ![...players.values()].some(q => q.room === p.room)) closeRoom(p.room);
    if (p.room) room(p.room, { t: 'left', id: p.id }); });
});

server.listen(process.env.PORT || 3000, () => console.log('running'));
