const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html());
});
const wss = new WebSocketServer({ server });
const players = new Map();
let nextId = 1;

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const room = (r, o, except) => { for (const p of players.values()) if (p.room === r && p !== except) send(p.ws, o); };
const pub = p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, hp: p.hp, k: p.k, d: p.d });
const spawn = p => { const a = Math.random() * 6.28; p.x = Math.cos(a) * 20; p.z = Math.sin(a) * 20; p.y = 0; p.hp = 100; };

wss.on('connection', ws => {
  const p = { id: nextId++, ws, room: null, name: 'P', x: 0, y: 0, z: 0, ry: 0, hp: 100, k: 0, d: 0 };
  players.set(p.id, p);
  ws.on('message', m => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.t === 'join') {
      p.room = String(d.room || 'main').slice(0, 20);
      p.name = String(d.name || 'Player').slice(0, 12);
      spawn(p);
      const others = [...players.values()].filter(q => q.room === p.room && q !== p).map(pub);
      send(ws, { t: 'init', me: pub(p), players: others });
      room(p.room, { t: 'new', p: pub(p) }, p);
    } else if (!p.room) return;
    else if (d.t === 'pos') {
      if (p.hp <= 0) return;
      p.x = d.x; p.y = d.y; p.z = d.z; p.ry = d.ry;
      room(p.room, { t: 'pos', id: p.id, x: d.x, y: d.y, z: d.z, ry: d.ry }, p);
    } else if (d.t === 'shoot') {
      room(p.room, { t: 'shoot', id: p.id, from: d.from, to: d.to }, p);
    } else if (d.t === 'hit') {
      const v = players.get(d.id);
      if (!v || v.room !== p.room || v.hp <= 0 || p.hp <= 0) return;
      v.hp -= 25;
      if (v.hp > 0) return send(v.ws, { t: 'hp', hp: v.hp });
      v.hp = 0; v.d++; p.k++;
      const msg = { t: 'kill', killer: p.id, victim: v.id, kn: p.name, vn: v.name, k: p.k, d: v.d };
      room(p.room, msg); 
      setTimeout(() => {
        if (!players.has(v.id)) return;
        spawn(v);
        room(v.room, { t: 'respawn', id: v.id, x: v.x, z: v.z });
      }, 3000);
    }
  });
  ws.on('close', () => { players.delete(p.id); if (p.room) room(p.room, { t: 'left', id: p.id }); });
});

server.listen(process.env.PORT || 3000, () => console.log('running'));
