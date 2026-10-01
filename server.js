// Kuis Kelas - server tanpa dependensi. Jalankan: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const games = {};
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const ranked = g => Object.values(g.players).sort((a, b) => b.score - a.score);

function view(g, pid) {
  const q = g.qs[g.i], ps = Object.values(g.players), me = g.players[pid];
  const live = g.phase === 'question' || g.phase === 'reveal';
  return {
    phase: g.phase, i: g.i, total: g.qs.length, n: ps.length,
    answered: ps.filter(p => p.choice != null).length,
    q: live ? { text: q.text, options: q.options, correct: g.phase === 'reveal' ? q.correct : null } : null,
    counts: g.phase === 'reveal' ? q.options.map((_, k) => ps.filter(p => p.choice === k).length) : null,
    ms: g.phase === 'question' ? g.start + q.time * 1000 - Date.now() : 0,
    board: ranked(g).slice(0, 5).map(p => ({ name: p.name, score: p.score })),
    all: g.phase === 'end' ? ranked(g).map(p => ({ name: p.name, score: p.score })) : null,
    you: me && { name: me.name, score: me.score, choice: me.choice, gain: me.gain, rank: ranked(g).indexOf(me) + 1 }
  };
}
const push = g => g.clients.forEach(c => c.res.write('data:' + JSON.stringify(view(g, c.pid)) + '\n\n'));

function reveal(g) {
  if (g.phase !== 'question') return;
  clearTimeout(g.timer); g.phase = 'reveal';
  const q = g.qs[g.i];
  for (const p of Object.values(g.players)) {
    p.gain = 0;
    if (p.choice === q.correct) { p.gain = Math.round(1000 * (1 - (p.at - g.start) / (q.time * 1000) / 2)); p.score += p.gain; }
  }
  push(g);
}
function next(g) {
  if (g.phase === 'question') return reveal(g);
  if (g.phase === 'end') return;
  g.i++;
  if (g.i >= g.qs.length) { g.phase = 'end'; return push(g); }
  g.phase = 'question'; g.start = Date.now();
  for (const p of Object.values(g.players)) { p.choice = null; p.gain = 0; }
  g.timer = setTimeout(() => reveal(g), g.qs[g.i].time * 1000);
  push(g);
}
const body = req => new Promise(r => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 2e5) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } });
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (req.method === 'GET' && u.pathname === '/events') {
    const g = games[u.searchParams.get('code')], pid = u.searchParams.get('pid');
    if (!g || (pid !== g.key && !g.players[pid])) return json({ error: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, pid }; g.clients.add(c);
    res.write('data:' + JSON.stringify(view(g, pid)) + '\n\n');
    const ka = setInterval(() => res.write(':\n\n'), 20000);
    req.on('close', () => { g.clients.delete(c); clearInterval(ka); });
    return;
  }
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await body(req), g = games[b.code];

  if (u.pathname === '/create') {
    const time = Math.min(120, Math.max(5, +b.time || 20));
    const qs = (Array.isArray(b.qs) ? b.qs : []).slice(0, 100).map(q => {
      const o = (q.options || []).slice(0, 4).map(x => String(x).slice(0, 120)), right = o[+q.correct || 0], s = b.shuffle ? shuffle(o) : o;
      return { text: String(q.text || '').slice(0, 300), options: s, correct: s.indexOf(right), time };
    }).filter(q => q.text && q.options.length >= 2 && q.correct >= 0);
    if (!qs.length) return json({ error: 'Soal kosong' }, 400);
    let code; do { code = String(100000 + Math.floor(Math.random() * 900000)); } while (games[code]);
    const key = Math.random().toString(36).slice(2, 12);
    games[code] = { key, qs, i: -1, phase: 'lobby', players: {}, clients: new Set(), born: Date.now() };
    return json({ code, key });
  }
  if (!g) return json({ error: 'Kode tidak ditemukan' }, 404);

  if (u.pathname === '/join') {
    const name = String(b.name || '').trim().slice(0, 20);
    if (!name) return json({ error: 'Isi nama dulu' }, 400);
    const id = Math.random().toString(36).slice(2, 10);
    g.players[id] = { name, score: 0, choice: null, gain: 0 };
    push(g); return json({ id });
  }
  if (u.pathname === '/answer') {
    const p = g.players[b.id];
    if (!p || g.phase !== 'question' || p.choice != null) return json({ ok: false });
    p.choice = +b.k; p.at = Date.now();
    if (Object.values(g.players).every(x => x.choice != null)) reveal(g); else push(g);
    return json({ ok: true });
  }
  if (u.pathname === '/act') {
    if (b.key !== g.key) return json({ error: 'forbidden' }, 403);
    next(g); return json({ ok: true });
  }
  json({ error: 'not found' }, 404);
}).listen(process.env.PORT || 3000, () => console.log('Kuis Kelas berjalan di port ' + (process.env.PORT || 3000)));

setInterval(() => { for (const c in games) if (Date.now() - games[c].born > 6 * 3600e3) delete games[c]; }, 600e3);
