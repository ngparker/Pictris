// Pure game logic: no DOM, no timers. Driven by tick(dtMs) + action calls.

export const COLS = 10;
export const VISIBLE = 20;
export const HIDDEN = 4;
export const ROWS = VISIBLE + HIDDEN;
export const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

export const LOCK_DELAY = 500;
export const MAX_LOCK_RESETS = 15;
export const CLEAR_DELAY = 220;
export const LINES_PER_LEVEL = 10;

const SHAPES = {
  I: { n: 4, c: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  J: { n: 3, c: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, c: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  O: { n: 2, c: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  S: { n: 3, c: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  T: { n: 3, c: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  Z: { n: 3, c: [[0, 0], [1, 0], [1, 1], [2, 1]] },
};

// CELLS[type][rot] -> [[x,y],...] within the bounding box, y pointing down.
export const CELLS = {};
for (const t of TYPES) {
  const { n, c } = SHAPES[t];
  const rots = [c];
  for (let r = 1; r < 4; r++) rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
  CELLS[t] = rots;
}

// SRS kick data, (x, y) with y pointing UP as in the published tables.
const K_JLSTZ = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const K_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};
const K_180 = [[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1]];

const T_CORNERS = [[0, 0], [2, 0], [2, 2], [0, 2]];
// Indices into T_CORNERS for the two corners the T "points" at, per rotation.
const T_FRONT = [[0, 1], [1, 2], [2, 3], [3, 0]];

/** Bounding extent of a set of cells: {x, y, w, h}. */
export function extent(cells) {
  let x0 = 9, y0 = 9, x1 = -1, y1 = -1;
  for (const [x, y] of cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function msPerRow(level) {
  const L = Math.min(Math.max(level, 1), 20);
  return Math.pow(0.8 - (L - 1) * 0.007, L - 1) * 1000;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  /**
   * @param {object} o
   * @param {'marathon'|'zen'} [o.mode]
   * @param {number} [o.startLevel]
   * @param {number} [o.seed]
   * @param {(type:string, data?:object)=>void} [o.onEvent]
   */
  /**
   * @param {(type:string)=>number} [o.tagger] assigns an opaque tag (e.g. photo id) to each new piece; -1 = none
   */
  constructor({ mode = 'marathon', startLevel = 1, seed = Date.now(), onEvent = () => {}, tagger = () => -1 } = {}) {
    this.mode = mode;
    this.startLevel = startLevel;
    this.rand = mulberry32(seed);
    this.emit = onEvent;
    this.tagger = tagger;
    this.board = new Uint8Array(ROWS * COLS); // 0 empty, else TYPES index + 1
    this.tags = new Int32Array(ROWS * COLS).fill(-1); // tag of the piece that filled each cell
    this.ext = new Uint8Array(ROWS * COLS); // cell position within its piece: ex | ey<<2 | (w-1)<<4 | (h-1)<<6
    this.queue = [];
    this.queueTags = [];
    this.hold = null;
    this.holdTag = -1;
    this.canHold = true;
    this.active = null;
    this.score = 0;
    this.lines = 0;
    this.level = startLevel;
    this.combo = -1;
    this.b2b = false;
    this.softDrop = false;
    this.over = false;
    this.clearing = null; // { rows:number[], t:number }
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = 0;
    this.lastRotate = false;
    this.lastKick = 0;
    this.stats = { pieces: 0, quads: 0, tspins: 0 };
    this.fillQueue();
    this.spawn();
  }

  fillQueue() {
    while (this.queue.length < 7) {
      const bag = TYPES.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      this.queue.push(...bag);
      this.queueTags.push(...bag.map((t) => this.tagger(t)));
    }
  }

  cell(x, y) {
    return this.board[y * COLS + x];
  }

  fits(type, rot, x, y) {
    for (const [cx, cy] of CELLS[type][rot]) {
      const bx = x + cx, by = y + cy;
      if (bx < 0 || bx >= COLS || by < 0 || by >= ROWS) return false;
      if (this.board[by * COLS + bx]) return false;
    }
    return true;
  }

  clearBoard() {
    this.board.fill(0);
    this.tags.fill(-1);
    this.ext.fill(0);
  }

  spawn(type, tag = -1) {
    if (!type) {
      type = this.queue.shift();
      tag = this.queueTags.shift();
      this.fillQueue();
    }
    const p = { type, rot: 0, x: type === 'O' ? 4 : 3, y: HIDDEN - 2, tag };
    if (!this.fits(p.type, p.rot, p.x, p.y)) {
      if (this.mode === 'zen') {
        this.clearBoard();
        this.emit('zenReset');
      } else {
        this.active = p;
        return this.gameOver('blockout');
      }
    }
    if (this.fits(p.type, p.rot, p.x, p.y + 1)) p.y++;
    this.active = p;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = p.y;
    this.lastRotate = false;
    this.emit('spawn', { type });
  }

  gameOver(reason) {
    this.over = true;
    this.emit('gameover', { reason });
  }

  get playable() {
    return !this.over && !this.clearing && !!this.active;
  }

  afterMove() {
    const a = this.active;
    if (a.y > this.lowestY) {
      this.lowestY = a.y;
      this.lockResets = 0;
      this.lockTimer = 0;
    } else if (this.lockTimer > 0 || !this.fits(a.type, a.rot, a.x, a.y + 1)) {
      if (this.lockResets < MAX_LOCK_RESETS) {
        this.lockResets++;
        this.lockTimer = 0;
      }
    }
  }

  move(dx) {
    if (!this.playable) return false;
    const a = this.active;
    if (!this.fits(a.type, a.rot, a.x + dx, a.y)) return false;
    a.x += dx;
    this.lastRotate = false;
    this.afterMove();
    this.emit('move');
    return true;
  }

  rotate(dir) {
    if (!this.playable) return false;
    const a = this.active;
    const to = (a.rot + dir + 4) % 4;
    let kicks;
    if (a.type === 'O') kicks = [[0, 0]];
    else if (dir === 2) kicks = K_180;
    else kicks = (a.type === 'I' ? K_I : K_JLSTZ)['' + a.rot + to];
    for (let i = 0; i < kicks.length; i++) {
      const nx = a.x + kicks[i][0], ny = a.y - kicks[i][1];
      if (this.fits(a.type, to, nx, ny)) {
        a.x = nx; a.y = ny; a.rot = to;
        this.lastRotate = true;
        this.lastKick = i;
        this.afterMove();
        this.emit('rotate');
        return true;
      }
    }
    return false;
  }

  dropDistance() {
    const a = this.active;
    let d = 0;
    while (this.fits(a.type, a.rot, a.x, a.y + d + 1)) d++;
    return d;
  }

  hardDrop() {
    if (!this.playable) return;
    const d = this.dropDistance();
    this.active.y += d;
    this.score += 2 * d;
    if (d > 0) this.lastRotate = false;
    this.lock(true);
  }

  holdPiece() {
    if (!this.playable || !this.canHold) return;
    const { type: cur, tag: curTag } = this.active;
    const swap = this.hold, swapTag = this.holdTag;
    this.hold = cur;
    this.holdTag = curTag;
    this.spawn(swap || undefined, swapTag);
    this.canHold = false;
    this.emit('hold');
  }

  tick(dt) {
    if (this.over) return;
    if (this.clearing) {
      this.clearing.t -= dt;
      if (this.clearing.t <= 0) this.finishClear();
      return;
    }
    if (!this.active) return;
    const a = this.active;
    const level = this.mode === 'zen' ? this.startLevel : this.level;
    let g = msPerRow(level);
    if (this.softDrop) g = Math.min(g, Math.max(g / 20, 25));
    this.gravityAcc += dt;
    let steps = 0;
    while (this.gravityAcc >= g && steps < ROWS) {
      steps++;
      if (this.fits(a.type, a.rot, a.x, a.y + 1)) {
        this.gravityAcc -= g;
        a.y++;
        this.lastRotate = false;
        if (this.softDrop) this.score += 1;
        if (a.y > this.lowestY) {
          this.lowestY = a.y;
          this.lockResets = 0;
          this.lockTimer = 0;
        }
      } else {
        this.gravityAcc = 0;
        break;
      }
    }
    if (!this.fits(a.type, a.rot, a.x, a.y + 1)) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY || this.lockResets >= MAX_LOCK_RESETS) this.lock(false);
    } else {
      this.lockTimer = 0;
    }
  }

  detectTSpin() {
    const a = this.active;
    if (a.type !== 'T' || !this.lastRotate) return null;
    const filled = T_CORNERS.map(([cx, cy]) => {
      const x = a.x + cx, y = a.y + cy;
      return x < 0 || x >= COLS || y >= ROWS || y < 0 || this.cell(x, y) !== 0;
    });
    const count = filled.filter(Boolean).length;
    if (count < 3) return null;
    const front = T_FRONT[a.rot].every((i) => filled[i]);
    return front || this.lastKick === 4 ? 'full' : 'mini';
  }

  lock(hard) {
    const a = this.active;
    const tspin = this.detectTSpin();
    let allHidden = true;
    const cells = CELLS[a.type][a.rot];
    const ex = extent(cells);
    for (const [cx, cy] of cells) {
      const y = a.y + cy;
      const i = y * COLS + a.x + cx;
      this.board[i] = TYPES.indexOf(a.type) + 1;
      this.tags[i] = a.tag;
      this.ext[i] = (cx - ex.x) | ((cy - ex.y) << 2) | ((ex.w - 1) << 4) | ((ex.h - 1) << 6);
      if (y >= HIDDEN) allHidden = false;
    }
    this.stats.pieces++;
    this.active = null;
    this.canHold = true;
    this.emit('lock', { hard, type: a.type });

    const rows = [];
    for (let y = 0; y < ROWS; y++) {
      let full = true;
      for (let x = 0; x < COLS; x++) if (!this.board[y * COLS + x]) { full = false; break; }
      if (full) rows.push(y);
    }
    this.score_(rows.length, tspin);

    if (rows.length) {
      this.clearing = { rows, t: CLEAR_DELAY };
      return;
    }
    if (allHidden) {
      if (this.mode === 'zen') {
        this.clearBoard();
        this.emit('zenReset');
      } else {
        return this.gameOver('lockout');
      }
    }
    this.spawn();
  }

  score_(n, tspin) {
    const lv = this.level;
    let base;
    if (tspin === 'full') base = [400, 800, 1200, 1600][n];
    else if (tspin === 'mini') base = [100, 200, 400, 400][n];
    else base = [0, 100, 300, 500, 800][n];
    if (tspin) this.stats.tspins++;
    if (n === 0) {
      this.combo = -1;
      this.score += base * lv;
      if (tspin) this.emit('clear', { lines: 0, tspin, b2b: false, combo: -1 });
      return;
    }
    const difficult = n === 4 || !!tspin;
    let pts = base * lv;
    const b2b = difficult && this.b2b;
    if (b2b) pts = Math.floor(pts * 1.5);
    this.b2b = difficult;
    this.combo++;
    pts += 50 * this.combo * lv;
    this.score += pts;
    if (n === 4) this.stats.quads++;
    this.emit('clear', { lines: n, tspin, b2b, combo: this.combo, points: pts });
  }

  finishClear() {
    const { rows } = this.clearing;
    this.clearing = null;
    const off = rows.length;
    for (const [arr, empty] of [[this.board, 0], [this.tags, -1], [this.ext, 0]]) {
      const keep = [];
      for (let y = 0; y < ROWS; y++) if (!rows.includes(y)) keep.push(arr.slice(y * COLS, (y + 1) * COLS));
      arr.fill(empty);
      keep.forEach((row, i) => arr.set(row, (i + off) * COLS));
    }

    const before = this.level;
    this.lines += rows.length;
    this.level = this.startLevel + Math.floor(this.lines / LINES_PER_LEVEL);
    if (this.board.every((v) => v === 0)) {
      this.score += 1000 * before;
      this.emit('perfect');
    }
    if (this.level !== before) this.emit('levelup', { level: this.level });
    this.spawn();
  }
}
