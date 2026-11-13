// ==SIM== (núcleo da simulação: sem DOM)
const N = 20, CELLS = N * N;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // cima, direita, baixo, esquerda
const IN = 17, OUT = 3;
const FF_MARK = new Uint32Array(CELLS), FF_Q = new Int16Array(CELLS); let ffStamp = 0;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gauss(){let u=0;while(!u)u=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*Math.random())}
const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

// raios relativos à direção: frente, esquerda, direita, diag-esq, diag-dir
const RAYS = [0,1,2,3].map(d => {
  const L = (d + 3) & 3, R = (d + 1) & 3;
  return [[DX[d],DY[d]],[DX[L],DY[L]],[DX[R],DY[R]],[DX[d]+DX[L],DY[d]+DY[L]],[DX[d]+DX[R],DY[d]+DY[R]]];
});

class Game {
  // hk = fome por tamanho (limite = 100 + hk*len). snap = {cells (cabeça primeiro), dir, score}: começa no meio de um jogo
  constructor(seed, hk = 3, snap = null){
    this.rng = mulberry32(seed); this.hk = hk;
    this.occ = new Uint8Array(CELLS);
    this.buf = new Int16Array(CELLS);
    this.len = 0; this.headPtr = -1; this.dir = 0;
    if (snap) { for (let i = snap.cells.length - 1; i >= 0; i--) this.push(snap.cells[i]); this.dir = snap.dir; }
    else { const c = N >> 1; for (let k = 2; k >= 0; k--) this.push(c + (c + k) * N); }
    this.score = this.startScore = snap ? snap.score : 0;
    this.steps = 0; this.hunger = 0; this.alive = true; this.cause = '';
    this.placeFood();
  }
  snapshot(){ const cells = []; for (let i = 0; i < this.len; i++) cells.push(this.cell(i)); return { cells, dir: this.dir, score: this.score }; }
  push(c){ this.headPtr = (this.headPtr + 1) % CELLS; this.buf[this.headPtr] = c; this.occ[c] = 1; this.len++; }
  head(){ return this.buf[this.headPtr]; }
  cell(i){ return this.buf[(this.headPtr - i + CELLS) % CELLS]; } // i=0 cabeça
  tail(){ return this.cell(this.len - 1); }
  placeFood(){
    let k = Math.floor(this.rng() * (CELLS - this.len));
    for (let c = 0; c < CELLS; c++) if (!this.occ[c]) { if (k === 0) { this.food = c; return; } k--; }
    this.food = -1;
  }
  hungerLimit(){ return 100 + this.hk * this.len; }
  step(action){
    if (action === 1) this.dir = (this.dir + 3) & 3; else if (action === 2) this.dir = (this.dir + 1) & 3;
    const h = this.head(), x = h % N + DX[this.dir], y = ((h / N) | 0) + DY[this.dir];
    this.steps++; this.hunger++;
    if (x < 0 || y < 0 || x >= N || y >= N) { this.alive = false; this.cause = 'bateu na parede'; return; }
    const nc = x + y * N, ate = nc === this.food;
    if (!ate) { this.occ[this.tail()] = 0; this.len--; }
    if (this.occ[nc]) { this.alive = false; this.cause = 'bateu no próprio corpo'; if (!ate) { this.len++; this.occ[this.tail()] = 1; } return; }
    this.push(nc);
    if (ate) {
      this.score++; this.hunger = 0; this.placeFood();
      if (this.food < 0) { this.alive = false; this.cause = 'ZEROU O JOGO'; return; }
    }
    if (this.hunger > this.hungerLimit()) { this.alive = false; this.cause = 'morreu de fome'; }
    if (this.steps > 2e6) { this.alive = false; this.cause = 'limite de passos'; } // trava de segurança
  }
  sense(o){
    const h = this.head(), hx = h % N, hy = (h / N) | 0, d = this.dir, rays = RAYS[d];
    for (let r = 0; r < 5; r++) {
      const vx = rays[r][0], vy = rays[r][1];
      let x = hx, y = hy, dist = 0, food = 0;
      for (;;) {
        x += vx; y += vy; dist++;
        if (x < 0 || y < 0 || x >= N || y >= N) break;
        const c = x + y * N;
        if (c === this.food) food = 1;
        if (this.occ[c]) break;
      }
      o[r] = 1 / dist; o[5 + r] = food;
    }
    const ax = DX[d], ay = DY[d], R = (d + 1) & 3, rx = DX[R], ry = DY[R];
    const fdx = this.food % N - hx, fdy = ((this.food / N) | 0) - hy;
    o[10] = (fdx * ax + fdy * ay) / N; o[11] = (fdx * rx + fdy * ry) / N;
    const t = this.tail(), tdx = t % N - hx, tdy = ((t / N) | 0) - hy;
    o[12] = (tdx * ax + tdy * ay) / N; o[13] = (tdx * rx + tdy * ry) / N;
    // espaço livre alcançável se ela for para frente / esquerda / direita (flood fill)
    const L = (d + 3) & 3, free = CELLS - this.len + 1;
    o[14] = this.space(hx + ax, hy + ay, t) / free;
    o[15] = this.space(hx + DX[L], hy + DY[L], t) / free;
    o[16] = this.space(hx + rx, hy + ry, t) / free;
  }
  space(sx, sy, tail){
    if (sx < 0 || sy < 0 || sx >= N || sy >= N) return 0;
    const s0 = sx + sy * N;
    if (this.occ[s0] && s0 !== tail) return 0;
    // o carimbo mora num Uint32Array: ao chegar no máximo, zera tudo (sem isso o flood fill entra em loop infinito após ~4,3 bi chamadas)
    if (++ffStamp >= 0xFFFFFFFF) { FF_MARK.fill(0); ffStamp = 1; }
    const st = ffStamp; let qh = 0, qt = 0, count = 0;
    FF_MARK[this.head()] = st; FF_MARK[s0] = st; FF_Q[qt++] = s0;
    while (qh < qt) {
      const c = FF_Q[qh++], x = c % N, y = (c / N) | 0; count++;
      if (x > 0     && FF_MARK[c-1] !== st && (!this.occ[c-1] || c-1 === tail)) { FF_MARK[c-1] = st; FF_Q[qt++] = c-1; }
      if (x < N - 1 && FF_MARK[c+1] !== st && (!this.occ[c+1] || c+1 === tail)) { FF_MARK[c+1] = st; FF_Q[qt++] = c+1; }
      if (y > 0     && FF_MARK[c-N] !== st && (!this.occ[c-N] || c-N === tail)) { FF_MARK[c-N] = st; FF_Q[qt++] = c-N; }
      if (y < N - 1 && FF_MARK[c+N] !== st && (!this.occ[c+N] || c+N === tail)) { FF_MARK[c+N] = st; FF_Q[qt++] = c+N; }
    }
    return count;
  }
}

// ---- rede neural (genoma = vetor plano de pesos + bias) ----
let SIZES, GLEN;
function setArch(hidden){
  SIZES = [IN, ...hidden, OUT];
  GLEN = 0; for (let i = 0; i < SIZES.length - 1; i++) GLEN += (SIZES[i] + 1) * SIZES[i + 1];
}
const makeBufs = () => SIZES.map(n => new Float32Array(n));
function forward(g, input, bufs){
  bufs[0].set(input);
  let off = 0; const last = SIZES.length - 2;
  for (let l = 0; l <= last; l++) {
    const a = bufs[l], b = bufs[l + 1], ni = SIZES[l], no = SIZES[l + 1];
    for (let j = 0; j < no; j++) {
      let s = g[off + ni];
      for (let i = 0; i < ni; i++) s += g[off + i] * a[i];
      off += ni + 1;
      b[j] = l < last ? Math.tanh(s) : s;
    }
  }
  const o = bufs[bufs.length - 1]; let best = 0;
  for (let k = 1; k < OUT; k++) if (o[k] > o[best]) best = k;
  return best;
}

// ---- algoritmo genético ----
const CFG = { pop: 500, hidden: [16], mutRate: 0.08, mutStd: 0.3, elite: 0.04, tour: 5 };
const EV = { pop: [], fit: null, scores: null, gen: 1, idx: 0, game: null, seed: 0, history: [], last: null, ever: null };
const INP = new Float32Array(IN); let EBUFS;

const fitness = g => g.steps + 1000 * g.score * g.score;
function playGenome(g, seed, bufs, inp, hk = 3, snap = null){ const game = new Game(seed, hk, snap); while (game.alive) { game.sense(inp); game.step(forward(g, inp, bufs)); } return game; }

function initEvolution(){
  setArch(CFG.hidden); EBUFS = makeBufs();
  EV.pop = Array.from({ length: CFG.pop }, () => { const g = new Float32Array(GLEN); for (let i = 0; i < GLEN; i++) g[i] = gauss() * 0.5; return g; });
  EV.fit = new Float64Array(CFG.pop); EV.scores = new Int32Array(CFG.pop);
  EV.gen = 1; EV.idx = 0; EV.game = null; EV.seed = newSeed(); EV.history = []; EV.last = null; EV.ever = null;
}
function tournament(){
  let b = (Math.random() * CFG.pop) | 0;
  for (let k = 1; k < CFG.tour; k++) { const c = (Math.random() * CFG.pop) | 0; if (EV.fit[c] > EV.fit[b]) b = c; }
  return EV.pop[b];
}
function nextGeneration(){
  const P = CFG.pop, order = [...Array(P).keys()].sort((a, b) => EV.fit[b] - EV.fit[a]);
  let sum = 0; for (let i = 0; i < P; i++) sum += EV.scores[i];
  const b = order[0];
  // com várias partidas por cobra: scores = média (vai pra média), maxScores/seeds = a melhor partida real (replay)
  const bs = EV.maxScores ? EV.maxScores[b] : EV.scores[b];
  EV.history.push({ gen: EV.gen, best: bs, avg: sum / P });
  EV.last = { genome: EV.pop[b].slice(), seed: EV.seeds ? EV.seeds[b] : EV.seed, gen: EV.gen, score: bs, hk: CFG.hk || 3 };
  if (!EV.ever || EV.last.score > EV.ever.score) EV.ever = EV.last;
  const next = [], ne = Math.max(1, Math.round(P * CFG.elite));
  for (let k = 0; k < ne; k++) next.push(EV.pop[order[k]].slice());
  while (next.length < P) {
    const a = tournament(), c = tournament(), child = new Float32Array(GLEN);
    for (let i = 0; i < GLEN; i++) {
      child[i] = Math.random() < 0.5 ? a[i] : c[i];
      if (Math.random() < CFG.mutRate) child[i] += gauss() * CFG.mutStd;
    }
    next.push(child);
  }
  EV.pop = next; EV.gen++; EV.idx = 0; EV.seed = newSeed();
}
function evolveSlice(budgetMs){
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if (!EV.game) EV.game = new Game(EV.seed);
    const g = EV.pop[EV.idx], game = EV.game;
    for (let k = 0; k < 300 && game.alive; k++) { game.sense(INP); game.step(forward(g, INP, EBUFS)); }
    if (!game.alive) {
      EV.fit[EV.idx] = fitness(game); EV.scores[EV.idx] = game.score;
      EV.game = null;
      if (++EV.idx >= CFG.pop) nextGeneration();
    }
  }
}
// ==/SIM==
if (typeof module !== 'undefined') module.exports = {
  N, IN, OUT, CFG, EV, Game, setArch, makeBufs, forward, fitness, playGenome, initEvolution, nextGeneration, newSeed,
  get SIZES(){ return SIZES; }, get GLEN(){ return GLEN; },
};

