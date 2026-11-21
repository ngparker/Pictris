import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, COLS, ROWS, HIDDEN, CELLS, TYPES, msPerRow, LOCK_DELAY, CLEAR_DELAY } from '../src/game.js';

const fill = (g, y, except = []) => {
  for (let x = 0; x < COLS; x++) if (!except.includes(x)) g.board[y * COLS + x] = 1;
};

test('7-bag yields each piece once per 7', () => {
  const g = new Game({ seed: 1 });
  const seen = [g.active.type, ...g.queue.slice(0, 6)];
  assert.deepEqual([...seen].sort(), [...TYPES].sort());
});

test('rotations of every piece have 4 cells and return to start', () => {
  for (const t of TYPES) {
    assert.equal(CELLS[t].length, 4);
    for (const r of CELLS[t]) assert.equal(r.length, 4);
  }
});

test('spawn drops one row immediately and is centered', () => {
  const g = new Game({ seed: 2 });
  assert.equal(g.active.y, HIDDEN - 1);
  assert.ok(g.active.x === 3 || g.active.x === 4);
});

test('moves stop at walls', () => {
  const g = new Game({ seed: 3 });
  for (let i = 0; i < 20; i++) g.move(-1);
  const minX = Math.min(...CELLS[g.active.type][g.active.rot].map(([x]) => x + g.active.x));
  assert.equal(minX, 0);
});

test('hard drop locks at the floor and scores 2/row', () => {
  const g = new Game({ seed: 4 });
  const d = g.dropDistance();
  g.hardDrop();
  assert.equal(g.score, 2 * d);
  assert.ok(g.board.slice((ROWS - 1) * COLS).some((v) => v));
});

test('single line clear scores 100 x level and collapses', () => {
  const g = new Game({ seed: 5, startLevel: 2 });
  fill(g, ROWS - 1, [0, 1, 2, 3]);
  g.active = { type: 'I', rot: 0, x: 0, y: 0 };
  g.hardDrop();
  assert.ok(g.clearing);
  const scored = g.score;
  g.tick(CLEAR_DELAY + 1);
  assert.equal(g.lines, 1);
  assert.ok(scored >= 200);
  assert.ok(g.board.slice((ROWS - 1) * COLS).every((v) => v === 0));
});

test('four lines = quad, b2b on second quad', () => {
  const g = new Game({ seed: 6 });
  const doQuad = () => {
    for (let y = ROWS - 4; y < ROWS; y++) fill(g, y, [9]);
    g.active = { type: 'I', rot: 1, x: 7, y: 0 };
    g.hardDrop();
    g.tick(CLEAR_DELAY + 1);
  };
  doQuad();
  assert.equal(g.lines, 4);
  assert.equal(g.stats.quads, 1);
  assert.equal(g.b2b, true);
  const s1 = g.score;
  doQuad();
  assert.ok(g.score - s1 >= 1200, 'b2b quad worth 1.5x');
});

test('level increases every 10 lines', () => {
  const g = new Game({ seed: 7 });
  let lv = null;
  g.emit = (t, d) => { if (t === 'levelup') lv = d.level; };
  for (let i = 0; i < 3; i++) {
    for (let y = ROWS - 4; y < ROWS; y++) fill(g, y, [9]);
    g.active = { type: 'I', rot: 1, x: 7, y: 0 };
    g.hardDrop();
    g.tick(CLEAR_DELAY + 1);
  }
  assert.equal(g.lines, 12);
  assert.equal(g.level, 2);
  assert.equal(lv, 2);
});

test('hold swaps and is limited to once per piece', () => {
  const g = new Game({ seed: 8 });
  const first = g.active.type;
  const next = g.queue[0];
  g.holdPiece();
  assert.equal(g.hold, first);
  assert.equal(g.active.type, next);
  g.holdPiece();
  assert.equal(g.active.type, next, 'second hold ignored');
});

test('gravity moves piece and lock delay locks it', () => {
  const g = new Game({ seed: 9 });
  const y0 = g.active.y;
  g.tick(msPerRow(1) + 1);
  assert.equal(g.active.y, y0 + 1);
  g.active.y += g.dropDistance();
  g.tick(LOCK_DELAY + 1);
  assert.equal(g.stats.pieces, 1);
});

test('SRS: I piece kicks off the left wall', () => {
  const g = new Game({ seed: 10 });
  g.active = { type: 'I', rot: 1, x: -2, y: 10 };
  assert.ok(g.fits('I', 1, -2, 10));
  assert.ok(g.rotate(1));
  const xs = CELLS.I[g.active.rot].map(([x]) => x + g.active.x);
  assert.ok(Math.min(...xs) >= 0);
});

test('T-spin double is detected', () => {
  const g = new Game({ seed: 11 });
  // Classic TSD slot at bottom: rows ROWS-2 and ROWS-1, hole at x=4 (bottom) and x=3..5 (row above), overhang at x=3 row ROWS-3.
  const B = ROWS - 1;
  fill(g, B, [4]);
  fill(g, B - 1, [3, 4, 5]);
  g.board[(B - 2) * COLS + 3] = 1;
  let ev = null;
  g.emit = (t, d) => { if (t === 'clear') ev = d; };
  g.active = { type: 'T', rot: 1, x: 3, y: B - 2 };
  assert.ok(g.fits('T', 1, 3, B - 2));
  assert.ok(g.rotate(1)); // R -> 2 (pointing down)
  g.hardDrop();
  assert.equal(ev.lines, 2);
  assert.equal(ev.tspin, 'full');
});

test('marathon block-out ends game; zen resets board instead', () => {
  const g = new Game({ seed: 12 });
  for (let y = 0; y < ROWS; y++) fill(g, y, [0]);
  g.active = null;
  g.spawn();
  assert.equal(g.over, true);
  const z = new Game({ seed: 12, mode: 'zen' });
  for (let y = 0; y < ROWS; y++) fill(z, y, [0]);
  z.spawn();
  assert.equal(z.over, false);
});

test('photo timeline: levels map oldest→newest and grid labels agree', async () => {
  const { photoForLevel, levelOfIndex } = await import('../src/photos.js');
  for (const n of [1, 6, 15, 40]) {
    const photos = Array.from({ length: n }, (_, i) => ({ id: i, date: i }));
    let prev = -1;
    for (let L = 1; L <= 20; L++) {
      const p = photoForLevel(photos, L, { span: 15, seed: 3 });
      if (L <= 15) assert.ok(p.id >= prev, 'non-decreasing');
      const lab = levelOfIndex(p.id, n, 15);
      if (n >= 15) assert.equal(lab, Math.min(L, 15));
      else assert.ok(lab <= Math.min(L, 15));
      prev = p.id;
    }
    assert.equal(photoForLevel(photos, 1, { span: 15 }).id < Math.max(1, n / 15) + 1, true);
    assert.equal(photoForLevel(photos, 15, { span: 15, seed: 9 }).id >= Math.floor((14 * n) / 15), true);
  }
});

test('photo picker: random within era per game, avoids used and recently seen photos', async () => {
  const { photoForLevel } = await import('../src/photos.js');
  const photos = Array.from({ length: 150 }, (_, i) => ({ id: 'p' + i, date: i }));
  const idx = (p) => +p.id.slice(1);
  // level 3 of 15 -> photos 20..29
  const seenIds = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const p = photoForLevel(photos, 3, { seed });
    assert.ok(idx(p) >= 20 && idx(p) < 30);
    seenIds.add(p.id);
  }
  assert.ok(seenIds.size >= 5, 'different games pick different photos');
  // all but one seen before -> the unseen one is chosen
  const seen = {};
  for (let i = 20; i < 30; i++) if (i !== 27) seen['p' + i] = 1000 + i;
  assert.equal(photoForLevel(photos, 3, { seed: 5, seen }).id, 'p27');
  // everything seen -> least recently seen
  seen.p27 = 5000;
  assert.equal(photoForLevel(photos, 3, { seed: 5, seen }).id, 'p20');
  // exclude wins over seen
  assert.notEqual(photoForLevel(photos, 3, { seed: 5, seen, exclude: new Set(['p20']) }).id, 'p20');
  // zen loops back to the first era; marathon stays in the last
  assert.ok(idx(photoForLevel(photos, 16, { seed: 2, loop: true })) < 10);
  assert.ok(idx(photoForLevel(photos, 16, { seed: 2 })) >= 140);
});

test('shared album: link validation and page parsing', async () => {
  const A = await import('../src/album.js');
  assert.equal(A.normalizeAlbumUrl(' https://photos.app.goo.gl/AbC123xyz '), 'https://photos.app.goo.gl/AbC123xyz');
  assert.equal(A.normalizeAlbumUrl('https://photos.google.com/share/AF1QipABC?key=k1&x=1#f'), 'https://photos.google.com/share/AF1QipABC?key=k1');
  for (const bad of ['', 'javascript:alert(1)', 'https://evil.example/photos.app.goo.gl/x', 'https://photos.google.com/album/1', 'https://photos.app.goo.gl.evil.com/x'])
    assert.equal(A.normalizeAlbumUrl(bad), null, bad);
  assert.ok(A.validRelay('https://r.example/?url={url}'));
  assert.ok(!A.validRelay('http://r.example/?url={url}'));
  assert.ok(!A.validRelay('https://r.example/'));

  const item = (key, path, w, h, ts) =>
    `["${key}",["https://lh3.googleusercontent.com/pw/${path}",${w},${h},null,null,null,null,null,null,[5152313]],${ts},"hash${key}",-25200000,${ts + 5000},null,null]`;
  const html = `<html><head><title>x</title><meta property="og:title" content="Kids &amp; Co · Google Photos">
    <meta property="og:image" content="https://lh3.googleusercontent.com/pw/COVER=w600-h315-p-k"></head><body><script>
    AF_initDataCallback({key: 'ds:1', data:[null,[${item('AF1QipAAAAAAAAAAAAAAAAAAAAAAAA', 'AAA', 4032, 3024, 1402567890123)},
    ${item('AF1QipBBBBBBBBBBBBBBBBBBBBBBBB', 'BBB', 3024, 4032, 1602567890123)},
    ${item('AF1QipAAAAAAAAAAAAAAAAAAAAAAAA', 'AAA', 4032, 3024, 1402567890123)}],
    ["https://lh3.googleusercontent.com/a/avatar",32,32],
    ["https://evil.example/x.jpg",4000,3000,null],1402567890123]});</script></body></html>`;
  const a = A.parseAlbumHtml(html, 1800000000000);
  assert.equal(a.title, 'Kids & Co');
  assert.equal(a.items.length, 2, 'deduped, avatar and foreign hosts ignored');
  assert.deepEqual(a.items.map((i) => [i.id, i.url, i.w, i.h, i.date]), [
    ['g:AF1QipAAAAAAAAAAAAAAAAAAAAAAAA', 'https://lh3.googleusercontent.com/pw/AAA', 4032, 3024, 1402567890123],
    ['g:AF1QipBBBBBBBBBBBBBBBBBBBBBBBB', 'https://lh3.googleusercontent.com/pw/BBB', 3024, 4032, 1602567890123],
  ]);
  const recs = A.albumRecords(a);
  assert.equal(A.sized(recs[0], 240, true), 'https://lh3.googleusercontent.com/pw/AAA=w240-h240-c');
  assert.equal(A.shareLink('https://photos.app.goo.gl/AbC', 'https://x.github.io/Pictris/'),
    'https://x.github.io/Pictris/?album=https%3A%2F%2Fphotos.app.goo.gl%2FAbC');
  assert.equal(A.parseAlbumHtml('<html>nothing</html>').items.length, 0);
});
