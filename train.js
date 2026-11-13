// train.js: uma "ilha" do algoritmo genético rodando em segundo plano (Node >= 18).
//
// Variáveis de ambiente:
//   ISLAND       nome da ilha (ex.: ilha-a, ilha-b…)
//   WORKERS      threads de avaliação (padrão 3)
//   POP HIDDEN MUT   população, camadas ocultas ("16" ou "16,16"), taxa de mutação (0.08)
//   HUB          "dir:/opt/snake-ia/hub"  → esta máquina é a central
//                "ssh:ubuntu@host"        → troca migrantes com a central via SSH (chave restrita)
//   SSH_KEY      chave usada no modo ssh
//   MIGRATE_SEC  intervalo entre migrações (padrão 90)
//   MIGRANTS     quantas cobras mandar/receber por migração (padrão 10)
//   SERVE        porta HTTP (só 127.0.0.1) para a página de acompanhamento (só na central)
// Experimento de fim de jogo (padrões = comportamento original):
//   GAMES=3      partidas normais por cobra (aptidão = média; recorde = melhor partida real)
//   CURRIC=1     + 1 partida começando de uma posição de cobra longa, tirada dos replays dos campeões
//   FIT=endgame  passos valem 0.1 (não premia enrolar), bônus enorme por zerar
//   HUNGER_K=5   limite de fome = 100 + K*tamanho (padrão 3)
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path'), http = require('http');
const { execFile } = require('child_process');
const S = require('./sim.js');

if (!isMainThread) {
  S.setArch(workerData.hidden);
  const bufs = S.makeBufs(), inp = new Float32Array(S.IN);
  const WIN = 2e8;
  const fitNormal = (g, mode) => mode === 'endgame' ? 0.1 * g.steps + 1000 * g.score * g.score + (g.cause === 'ZEROU O JOGO' ? WIN : 0) : S.fitness(g);
  // na partida de fim de jogo só conta o que ela conquistou a partir da posição inicial
  const fitCurric = g => 0.1 * g.steps + 1000 * (g.score * g.score - g.startScore * g.startScore) + (g.cause === 'ZEROU O JOGO' ? WIN : 0);
  parentPort.on('message', ({ seed, genomes, start, games = 1, hk = 3, fitMode = 'classic', snap = null }) => {
    const n = genomes.length, fit = new Float64Array(n), scores = new Float64Array(n), maxScores = new Int32Array(n), seeds = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let f = 0, sum = 0, best = -1, bestSeed = seed;
      for (let k = 0; k < games; k++) {
        const sd = (seed + k * 7919) >>> 0, game = S.playGenome(genomes[i], sd, bufs, inp, hk);
        f += fitNormal(game, fitMode); sum += game.score;
        if (game.score > best) { best = game.score; bestSeed = sd; }
      }
      let parts = games;
      if (snap) { f += fitCurric(S.playGenome(genomes[i], (seed ^ 0x9e3779b9) >>> 0, bufs, inp, hk, snap)); parts++; }
      fit[i] = f / parts; scores[i] = sum / games; maxScores[i] = best; seeds[i] = bestSeed;
    }
    parentPort.postMessage({ start, fit, scores, maxScores, seeds });
  });
} else main();

function main() {
  const E = process.env, DIR = __dirname;
  const ISLAND = (E.ISLAND || require('os').hostname()).toLowerCase();
  const WORKERS = +E.WORKERS || 3, MIGRATE_SEC = +E.MIGRATE_SEC || 90, MIGRANTS = +E.MIGRANTS || 10;
  const HUB = E.HUB || '', SSH_KEY = E.SSH_KEY || path.join(DIR, 'hub_key');
  S.CFG.pop = +E.POP || 500;
  S.CFG.hidden = (E.HIDDEN || '16').split(',').map(Number);
  S.CFG.mutRate = +(E.MUT || 0.08);
  const GAMES = +E.GAMES || 1, CURRIC = E.CURRIC === '1', FIT = E.FIT || 'classic', HK = +E.HUNGER_K || 3;
  const EXP = GAMES > 1 || CURRIC || FIT !== 'classic' || HK !== 3;
  S.CFG.hk = HK;
  const CKPT = path.join(DIR, 'checkpoint.json');
  const log = (...a) => console.log(new Date().toISOString().slice(0, 19), `[${ISLAND}]`, ...a);

  const enc = g => Buffer.from(g.buffer, g.byteOffset, g.byteLength).toString('base64');
  const dec = s => { const b = Buffer.from(s, 'base64'), f = new Float32Array(b.length / 4); new Uint8Array(f.buffer).set(b); return f; };
  const encBest = b => b && { ...b, genome: enc(b.genome) };
  const decBest = b => b && { ...b, genome: dec(b.genome) };
  const thin = (h, max) => { if (h.length <= max) return h; const st = h.length / max, o = []; for (let i = 0; i < max; i++) o.push(h[Math.floor(i * st)]); o[max - 1] = h[h.length - 1]; return o; };
  const writeAtomic = (f, data) => { fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); };

  S.initEvolution();
  const allocScores = () => { S.EV.scores = new Float64Array(S.CFG.pop); S.EV.maxScores = new Int32Array(S.CFG.pop); S.EV.seeds = new Uint32Array(S.CFG.pop); };
  if (EXP) allocScores();
  if (fs.existsSync(CKPT)) {
    try {
      const c = JSON.parse(fs.readFileSync(CKPT, 'utf8'));
      if (c.hidden.join() === S.CFG.hidden.join() && c.pop === S.CFG.pop && c.in === S.IN) {
        S.EV.pop = c.genomes.map(dec); S.EV.gen = c.gen; S.EV.history = c.history;
        S.EV.last = decBest(c.last); S.EV.ever = decBest(c.ever);
        log('retomado do checkpoint, geração', c.gen, '· recorde', S.EV.ever && S.EV.ever.score);
      } else log('checkpoint com arquitetura diferente, começando do zero');
    } catch (e) { log('checkpoint ilegível, começando do zero:', e.message); }
  }

  // ---- avaliação paralela (fila de lotes pequenos para equilibrar carga) ----
  const workers = Array.from({ length: WORKERS }, () => new Worker(__filename, { workerData: { hidden: S.CFG.hidden } }));
  workers.forEach(w => w.on('error', e => { log('worker caiu:', e); process.exit(1); }));
  function evalGeneration() {
    return new Promise(resolve => {
      const P = S.CFG.pop, BATCH = Math.max(5, Math.ceil(P / (WORKERS * 8)));
      let next = 0, done = 0;
      const feed = w => {
        if (next >= P) return;
        const start = next; next = Math.min(P, next + BATCH);
        w.postMessage({ seed: S.EV.seed, start, genomes: S.EV.pop.slice(start, next), games: GAMES, hk: HK, fitMode: FIT, snap: curSnap });
      };
      const curSnap = CURRIC && pool.length ? pool[S.EV.gen % pool.length] : null;
      const onMsg = function ({ start, fit, scores, maxScores, seeds }) {
        S.EV.fit.set(fit, start); done += fit.length;
        if (EXP) { S.EV.scores.set(scores, start); S.EV.maxScores.set(maxScores, start); S.EV.seeds.set(seeds, start); }
        else S.EV.scores.set(scores, start);
        if (done >= P) { workers.forEach(w => w.off('message', w._h)); resolve(); } else feed(this);
      };
      workers.forEach(w => { w._h = onMsg.bind(w); w.on('message', w._h); feed(w); });
    });
  }

  // ---- banco de posições de fim de jogo (para CURRIC) ----
  const pool = []; const pooled = new Set();
  function harvest(src) {
    if (!CURRIC || !src || src.score < 120) return;
    const key = src.seed + ':' + src.score; if (pooled.has(key)) return; pooled.add(key);
    const game = new S.Game(src.seed, src.hk || 3), bufs = S.makeBufs(), inp = new Float32Array(S.IN);
    let next = 100, added = 0;
    while (game.alive) {
      game.sense(inp); game.step(S.forward(src.genome, inp, bufs));
      if (game.alive && game.score >= next && game.score <= src.score - 5) { pool.push(game.snapshot()); next += 25; added++; }
    }
    while (pool.length > 40) pool.shift();
    if (added) log(`banco de fim de jogo: +${added} posições (de uma partida de ${src.score}), total ${pool.length}`);
  }

  // ---- migração entre ilhas ----
  const HUB_DIR = HUB.startsWith('dir:') ? HUB.slice(4) : null;
  const seen = {}; let inbox = [], migrating = false, gpm = 0;
  function payload() {
    return JSON.stringify({
      island: ISLAND, updatedAt: Date.now(), gen: S.EV.gen - 1, gensPerMin: +gpm.toFixed(1),
      pop: S.CFG.pop, hidden: S.CFG.hidden, mut: S.CFG.mutRate, in: S.IN,
      exp: EXP ? { games: GAMES, curric: CURRIC, fit: FIT, hk: HK } : null,
      last: encBest(S.EV.last), ever: encBest(S.EV.ever), history: thin(S.EV.history, 1500),
      migrants: S.EV.pop.slice(0, MIGRANTS).map(enc), // elites ficam no início da população nova
    });
  }
  function receive(lines) {
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o.island || o.island === ISLAND || o.in !== S.IN || String(o.hidden) !== String(S.CFG.hidden)) continue;
      if (seen[o.island] === o.updatedAt) continue; // já importados
      seen[o.island] = o.updatedAt;
      for (const m of o.migrants || []) inbox.push(dec(m));
      if (o.ever && o.ever.score >= 120) { try { harvest({ ...o.ever, genome: dec(o.ever.genome) }); } catch (e) { log('harvest falhou:', e.message); } }
      log(`recebi ${(o.migrants || []).length} migrantes de ${o.island} (geração ${o.gen}, recorde ${o.ever && o.ever.score})`);
    }
  }
  function migrate() {
    if (migrating || !HUB) return;
    migrating = true;
    const data = payload();
    if (HUB_DIR) {
      try {
        writeAtomic(path.join(HUB_DIR, ISLAND + '.json'), data);
        receive(fs.readdirSync(HUB_DIR).filter(f => f.endsWith('.json')).map(f => fs.readFileSync(path.join(HUB_DIR, f), 'utf8')));
      } catch (e) { log('migração falhou:', e.message); }
      migrating = false;
    } else if (HUB.startsWith('ssh:')) {
      const child = execFile('ssh', ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(DIR, 'known_hosts'),
        HUB.slice(4), 'sync ' + ISLAND], { maxBuffer: 64 << 20, timeout: 60000 }, (err, out, errOut) => {
        migrating = false;
        if (err) return log('migração via ssh falhou:', (errOut || err.message).trim().slice(0, 200));
        receive(out.split('\n'));
      });
      child.stdin.end(data);
    }
  }
  function applyInbox() {
    if (!inbox.length) return;
    const P = S.CFG.pop, k = Math.min(inbox.length, Math.floor(P / 10));
    for (let i = 0; i < k; i++) S.EV.pop[P - 1 - i] = inbox[i]; // substitui o fim (filhos comuns), preserva elites
    inbox = [];
  }

  // ---- página de acompanhamento (só na central) ----
  if (E.SERVE && HUB_DIR) {
    const files = { '/': 'index.html', '/index.html': 'index.html', '/sim.js': 'sim.js' };
    http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/state.json') {
        const islands = [];
        for (const f of fs.readdirSync(HUB_DIR).filter(f => f.endsWith('.json'))) {
          try { const o = JSON.parse(fs.readFileSync(path.join(HUB_DIR, f), 'utf8')); delete o.migrants; islands.push(o); } catch {}
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ islands }));
      }
      const f = files[url];
      if (!f) { res.writeHead(404); return res.end('não encontrado'); }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
      fs.createReadStream(path.join(DIR, f)).pipe(res);
    }).listen(+E.SERVE, '127.0.0.1', () => log('página em http://127.0.0.1:' + E.SERVE));
  }

  // ---- laço principal ----
  let lastMig = 0, lastCkpt = Date.now(), lastLog = 0, recent = [];
  function checkpoint() {
    writeAtomic(CKPT, JSON.stringify({
      pop: S.CFG.pop, hidden: S.CFG.hidden, in: S.IN, gen: S.EV.gen, history: S.EV.history,
      last: encBest(S.EV.last), ever: encBest(S.EV.ever), genomes: S.EV.pop.map(enc),
    }));
  }
  const stop = () => { try { checkpoint(); log('checkpoint salvo, saindo'); } catch {} process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);

  log(`iniciando: pop ${S.CFG.pop}, ocultas ${S.CFG.hidden}, mutação ${S.CFG.mutRate}, ${WORKERS} workers, hub ${HUB || '(nenhum)'}` + (EXP ? ` · EXPERIMENTO games=${GAMES} curric=${CURRIC} fit=${FIT} fome=${HK}` : ''));
  if (CURRIC) { harvest(S.EV.ever); harvest(S.EV.last); }
  (async function loop() {
    for (;;) {
      await evalGeneration();
      S.nextGeneration();
      applyInbox();
      const now = Date.now();
      recent.push(now); recent = recent.filter(t => now - t < 60000); gpm = recent.length;
      if (now - lastMig > MIGRATE_SEC * 1000) { lastMig = now; migrate(); harvest(S.EV.last); harvest(S.EV.ever); }
      if (now - lastCkpt > 60000) { lastCkpt = now; checkpoint(); }
      if (now - lastLog > 300000) {
        lastLog = now; const h = S.EV.history[S.EV.history.length - 1];
        log(`geração ${h.gen} · melhor ${h.best} · média ${h.avg.toFixed(1)} · recorde ${S.EV.ever.score} (g${S.EV.ever.gen}) · ${gpm} ger/min`);
      }
      await new Promise(r => setImmediate(r)); // deixa SIGTERM e o servidor HTTP respirarem
    }
  })();
}
