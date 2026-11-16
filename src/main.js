import { Game, LINES_PER_LEVEL } from './game.js';
import { Renderer } from './renderer.js';
import { Sound } from './audio.js';
import * as P from './photos.js';
import * as G from './gphotos.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------- settings ----------------
const DEFAULTS = {
  blockStyle: 'photo', order: 'chrono', span: 15, background: true, dim: 0.45, blur: 1.25, tint: 0.3,
  boardOpacity: 0.72, captions: true, ghost: true, previews: 5, das: 167, arr: 33, clearText: true,
  reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, volume: 0.5, moveSounds: false,
  startLevel: 1, gClientId: '',
};
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
let settings = load('pictris.settings', DEFAULTS);
let best = load('pictris.best', { marathon: 0, zen: 0 });

// ---------------- core objects ----------------
const canvas = $('#gl');
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  document.body.innerHTML = `<p class="nojs">Pictris needs WebGL2, which this browser doesn't provide (${e.message}).</p>`;
  throw e;
}
const sound = new Sound();
sound.volume = settings.volume;

let photos = [];
let game = null;
let seed = 0;
let paused = false;
let state = 'menu'; // menu | play | pause | over
let currentPhotoId = null;
const bitmapCache = new Map();

// ---------------- photos ----------------
async function bitmapFor(rec) {
  if (bitmapCache.has(rec.id)) return bitmapCache.get(rec.id);
  const bmp = await createImageBitmap(rec.blob);
  bitmapCache.set(rec.id, bmp);
  if (bitmapCache.size > 6) {
    const [k, v] = bitmapCache.entries().next().value;
    if (k !== rec.id) { v.close?.(); bitmapCache.delete(k); }
  }
  return bmp;
}

async function showPhoto(rec, instant = false) {
  if (!rec) {
    if (currentPhotoId !== null) renderer.setPhoto(null, instant);
    currentPhotoId = null;
    return;
  }
  if (rec.id === currentPhotoId) return;
  currentPhotoId = rec.id;
  try {
    const bmp = await bitmapFor(rec);
    if (currentPhotoId === rec.id) renderer.setPhoto(bmp, instant);
  } catch (e) {
    console.warn('photo decode failed', e);
  }
}

function photoForGame(level) {
  return P.photoForLevel(photos, level, { order: settings.order, span: settings.span, seed, loop: game?.mode === 'zen' });
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

async function refreshPhotos() {
  photos = await P.listPhotos();
  $('#photoCount').textContent = photos.length;
  $('#photoHint').textContent = photos.length
    ? `${photos.length} photo${photos.length > 1 ? 's' : ''}, ${fmtDate(photos[0].date)} – ${fmtDate(photos[photos.length - 1].date)}`
    : 'Add some family photos to see them appear as you play.';
}

// Calm slideshow behind the menu.
let menuTimer = 0;
function menuSlide(instant = false) {
  if (!photos.length) return showPhoto(null, instant);
  const rec = photos[Math.floor(Math.random() * photos.length)];
  showPhoto(rec, instant);
}

// ---------------- HUD ----------------
const hud = { score: $('#score'), level: $('#level'), lines: $('#lines'), best: $('#best') };
let lastHud = '';
function updateHud() {
  if (!game) return;
  const key = `${game.score}|${game.level}|${game.lines}`;
  if (key === lastHud) return;
  lastHud = key;
  hud.score.textContent = game.score.toLocaleString();
  hud.level.textContent = game.level;
  hud.lines.textContent = game.lines;
  hud.best.textContent = Math.max(best[game.mode] || 0, game.score).toLocaleString();
}

function placeHud() {
  const L = renderer.resize();
  const d = L.dpr;
  const px = (v) => `${Math.round(v / d)}px`;
  const hl = $('#holdLabel'), nl = $('#nextLabel'), st = $('#stats');
  const lx = L.cell * (L.portrait ? 0.2 : 0.3), ly = L.cell * (L.portrait ? 0.15 : 0.25);
  hl.style.left = px(L.hold.x + lx); hl.style.top = px(L.hold.y + ly);
  nl.style.left = px(L.next.x + lx); nl.style.top = px(L.next.y + ly);
  st.style.left = px(L.stats.x + (L.portrait ? 0 : L.cell * 0.3)); st.style.top = px(L.stats.y);
  st.style.width = px(L.stats.w);
  st.classList.toggle('row', !!L.portrait);
  document.body.classList.toggle('portrait', !!L.portrait);
  $('#toast').style.top = px(L.by + L.bh * 0.42);
  $('#caption').style.top = px(L.by + L.bh + L.cell * 0.35);
}

let toastTimer, captionTimer;
function toast(text) {
  if (!settings.clearText) return;
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1100);
}
function caption(text) {
  const c = $('#caption');
  c.textContent = text;
  c.classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => c.classList.remove('show'), 3500);
}

// ---------------- game flow ----------------
function onEvent(type, d) {
  switch (type) {
    case 'lock': sound.lock(d.hard); break;
    case 'move': if (settings.moveSounds) sound.move(); break;
    case 'rotate': if (settings.moveSounds) sound.rotate(); break;
    case 'hold': sound.hold(); break;
    case 'clear': {
      if (d.lines) sound.clear(d.lines, d.combo);
      const names = ['', 'Single', 'Double', 'Triple', 'Quad'];
      let label = '';
      if (d.tspin) label = `${d.tspin === 'mini' ? 'Mini ' : ''}T-Spin${d.lines ? ' ' + names[d.lines] : ''}`;
      else if (d.lines === 4) label = 'Quad';
      if (label && d.b2b) label = 'Back-to-back ' + label;
      if (d.combo >= 2) label = (label ? label + ' · ' : '') + `Combo ×${d.combo}`;
      if (label) toast(label);
      break;
    }
    case 'perfect': toast('Perfect clear'); break;
    case 'levelup': {
      sound.levelUp();
      const rec = photoForGame(d.level);
      showPhoto(rec);
      if (rec && settings.captions) caption(`Level ${d.level} · ${fmtDate(rec.date)}`);
      break;
    }
    case 'zenReset': toast('Fresh board'); break;
    case 'gameover': endGame(); break;
  }
}

function startGame(mode = game?.mode || 'marathon') {
  seed = (Math.random() * 2 ** 31) | 0;
  game = new Game({ mode, startLevel: settings.startLevel, seed, onEvent });
  lastHud = '';
  state = 'play';
  paused = false;
  $('#menu').hidden = true; $('#pause').hidden = true; $('#over').hidden = true;
  $('#hud').hidden = false;
  placeHud();
  updateHud();
  const rec = photoForGame(game.level);
  showPhoto(rec);
  if (rec && settings.captions) caption(fmtDate(rec.date));
  sound.ensure();
  canvas.focus?.();
}

function endGame() {
  state = 'over';
  sound.gameOver();
  const mode = game.mode;
  const isBest = game.score > (best[mode] || 0);
  if (isBest) { best[mode] = game.score; save('pictris.best', best); }
  $('#overScore').textContent = game.score.toLocaleString();
  $('#overDetail').textContent = `${game.lines} lines · level ${game.level}${isBest ? ' · new best!' : ''}`;
  setTimeout(() => { if (state === 'over') $('#over').hidden = false; }, 700);
}

function setPause(on) {
  if (state !== 'play' && state !== 'pause') return;
  state = on ? 'pause' : 'play';
  $('#pause').hidden = !on;
  input.clear();
}

function toMenu() {
  if (game && game.score > (best[game.mode] || 0)) { best[game.mode] = game.score; save('pictris.best', best); }
  state = 'menu';
  game = null;
  $('#hud').hidden = true; $('#pause').hidden = true; $('#over').hidden = true; $('#menu').hidden = false;
  renderBests();
  menuSlide();
}

function renderBests() {
  const parts = [];
  if (best.marathon) parts.push(`Marathon best ${best.marathon.toLocaleString()}`);
  if (best.zen) parts.push(`Zen best ${best.zen.toLocaleString()}`);
  $('#bests').textContent = parts.join(' · ');
}

// ---------------- input ----------------
const KEYMAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'soft', ArrowUp: 'cw', KeyX: 'cw', KeyZ: 'ccw',
  ControlLeft: 'ccw', ControlRight: 'ccw', KeyA: 'r180', Space: 'hard', KeyC: 'hold', ShiftLeft: 'hold',
  ShiftRight: 'hold', Escape: 'pause', KeyP: 'pause', F1: 'pause', KeyM: 'mute', KeyR: 'restart', Enter: 'enter',
  Numpad4: 'left', Numpad6: 'right', Numpad2: 'soft', Numpad8: 'hard', Numpad1: 'cw', Numpad5: 'cw', Numpad9: 'cw',
  Numpad3: 'ccw', Numpad7: 'ccw', Numpad0: 'hold',
};

const input = {
  held: new Set(),
  dir: 0, das: 0, arr: 0,
  clear() { this.held.clear(); this.dir = 0; if (game) game.softDrop = false; },
  press(dir) {
    this.dir = dir; this.das = 0; this.arr = 0;
    game.move(dir);
  },
  update(dt) {
    if (!game || !this.dir) return;
    this.das += dt;
    if (this.das < settings.das) return;
    if (settings.arr <= 0) { while (game.move(this.dir)); return; }
    this.arr += dt;
    while (this.arr >= settings.arr) { this.arr -= settings.arr; if (!game.move(this.dir)) { this.arr = 0; break; } }
  },
};

addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const act = KEYMAP[e.code];
  if (!act) return;
  if (e.target.matches?.('input, select, textarea') ) return;
  e.preventDefault();
  if (act === 'mute') { sound.muted = !sound.muted; toast(sound.muted ? 'Sound off' : 'Sound on'); return; }
  if (state === 'menu') { if (act === 'enter' || act === 'hard') startGame('marathon'); return; }
  if (state === 'over') { if (act === 'restart' || act === 'enter') startGame(); else if (act === 'pause') toMenu(); return; }
  if (state === 'pause') {
    if (act === 'pause' || act === 'enter') setPause(false);
    else if (act === 'restart') startGame();
    return;
  }
  if (act === 'pause') return setPause(true);
  if (e.repeat) return;
  input.held.add(act);
  switch (act) {
    case 'left': input.press(-1); break;
    case 'right': input.press(1); break;
    case 'soft': game.softDrop = true; break;
    case 'hard': game.hardDrop(); break;
    case 'cw': game.rotate(1); break;
    case 'ccw': game.rotate(-1); break;
    case 'r180': game.rotate(2); break;
    case 'hold': game.holdPiece(); break;
  }
});

addEventListener('keyup', (e) => {
  const act = KEYMAP[e.code];
  if (!act || !game) return;
  input.held.delete(act);
  if (act === 'soft' && !input.held.has('soft')) game.softDrop = false;
  if ((act === 'left' && input.dir === -1) || (act === 'right' && input.dir === 1)) {
    const other = act === 'left' ? 'right' : 'left';
    if (input.held.has(other)) input.press(other === 'left' ? -1 : 1);
    else input.dir = 0;
  }
});

addEventListener('blur', () => { if (state === 'play') setPause(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') setPause(true); });

// Touch: drag to move, tap to rotate, drag down to soft drop, flick down hard drop, flick up hold.
const touch = { id: null };
canvas.addEventListener('pointerdown', (e) => {
  if (state !== 'play' || e.pointerType === 'mouse') return;
  touch.id = e.pointerId; touch.x0 = touch.x = e.clientX; touch.y0 = touch.y = e.clientY;
  touch.t0 = performance.now(); touch.moved = false; touch.ay = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== touch.id || !game) return;
  const cell = renderer.layout.cell / renderer.layout.dpr;
  while (e.clientX - touch.x > cell * 0.9) { game.move(1); touch.x += cell * 0.9; touch.moved = true; }
  while (touch.x - e.clientX > cell * 0.9) { game.move(-1); touch.x -= cell * 0.9; touch.moved = true; }
  const dy = e.clientY - touch.y0;
  game.softDrop = dy > cell * 1.2 && Math.abs(e.clientX - touch.x0) < cell * 2;
  if (Math.abs(dy) > cell * 0.5) touch.moved = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== touch.id || !game) return;
  touch.id = null;
  game.softDrop = false;
  const dt = performance.now() - touch.t0;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
  const cell = renderer.layout.cell / renderer.layout.dpr;
  if (dt < 280 && dy > cell * 2.5 && Math.abs(dy) > Math.abs(dx) * 1.5) game.hardDrop();
  else if (dt < 280 && dy < -cell * 2.5 && Math.abs(dy) > Math.abs(dx) * 1.5) game.holdPiece();
  else if (!touch.moved && dt < 300) game.rotate(e.clientX < innerWidth / 3 ? -1 : 1);
});
canvas.addEventListener('pointercancel', () => { touch.id = null; if (game) game.softDrop = false; });

// ---------------- loop ----------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (state === 'play' && game) {
    input.update(dt);
    game.tick(dt);
    updateHud();
  }
  if (state === 'menu') {
    menuTimer += dt;
    if (menuTimer > 14000) { menuTimer = 0; menuSlide(); }
  }
  renderer.render({ game: state === 'menu' ? null : game, time: now, dt, settings });
  requestAnimationFrame(frame);
}

addEventListener('resize', placeHud);

// ---------------- menus & dialogs ----------------
const sel = $('#startLevel');
for (let i = 1; i <= 15; i++) sel.add(new Option(i, i));
sel.value = settings.startLevel;
sel.onchange = () => { settings.startLevel = +sel.value; save('pictris.settings', settings); };

$$('[data-start]').forEach((b) => (b.onclick = () => startGame(b.dataset.start)));
$$('[data-open]').forEach((b) => (b.onclick = () => openDialog(b.dataset.open)));
$$('[data-act]').forEach((b) => (b.onclick = () => {
  const a = b.dataset.act;
  if (a === 'resume') setPause(false);
  else if (a === 'restart') startGame();
  else if (a === 'menu') toMenu();
}));
$('#pauseBtn').onclick = () => setPause(true);

function openDialog(id) {
  const d = document.getElementById(id);
  if (id === 'settingsDlg') fillSettings();
  if (id === 'photosDlg') renderGrid();
  d.showModal();
}
$$('dialog').forEach((d) => d.addEventListener('close', () => {
  if (d.id === 'photosDlg' && state === 'menu') menuSlide();
}));

// settings form
const form = $('#settingsForm');
function fillSettings() {
  for (const el of form.querySelectorAll('[name]')) {
    const v = settings[el.name];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
}
form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'range' || el.type === 'number') v = +v;
  if (el.type === 'number') v = Math.min(+el.max || Infinity, Math.max(+el.min || 0, v));
  settings[el.name] = v;
  sound.volume = settings.volume;
  save('pictris.settings', settings);
  if ((el.name === 'order' || el.name === 'span') && game) showPhoto(photoForGame(game.level));
});
$('#resetSettings').onclick = () => {
  settings = { ...DEFAULTS, gClientId: settings.gClientId, startLevel: settings.startLevel };
  save('pictris.settings', settings);
  fillSettings();
};

// photo library UI
const status = (t) => ($('#importStatus').textContent = t);

async function doImport(files) {
  if (!files.length) return;
  await P.requestPersistence();
  status(`Importing 0 / ${files.length}…`);
  const r = await P.importFiles(files, (d, n) => status(`Importing ${d} / ${n}…`));
  status(`Added ${r.count} photo${r.count === 1 ? '' : 's'}.` + (r.errors.length ? `\nSkipped ${r.errors.length}: ${r.errors.slice(0, 3).join('; ')}` : ''));
  await refreshPhotos();
  renderGrid();
}

$('#fileInput').onchange = (e) => { doImport([...e.target.files]); e.target.value = ''; };
$('#dirInput').onchange = (e) => { doImport([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); doImport([...e.dataTransfer.files]); });
// Dropping anywhere on the page opens the library and imports.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.target.closest?.('#drop')) return;
  if (!$('#photosDlg').open) openDialog('photosDlg');
  doImport([...(e.dataTransfer?.files || [])]);
});

const thumbUrls = [];
async function renderGrid() {
  thumbUrls.splice(0).forEach(URL.revokeObjectURL);
  const grid = $('#grid');
  grid.textContent = '';
  const est = await P.storageEstimate();
  $('#libSummary').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}` +
    (est?.usage ? ` · ${(est.usage / 1048576).toFixed(0)} MB used` : '');
  $('#clearAll').hidden = !photos.length;
  const span = settings.span;
  photos.forEach((p, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const url = URL.createObjectURL(p.thumb);
    thumbUrls.push(url);
    const lvl = settings.order === 'chrono' ? P.levelOfIndex(i, photos.length, span) : null;
    const d = new Date(p.date);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    tile.innerHTML = `<img alt="" loading="lazy">${lvl ? `<span class="era">L${lvl}${lvl === span ? '+' : ''}</span>` : ''}
      <button class="del" title="Remove" aria-label="Remove photo">✕</button>
      <div class="meta"><input type="date" title="Date taken (${p.dateSource}) — change to reorder" value="${iso}"></div>`;
    tile.querySelector('img').src = url;
    tile.querySelector('.del').onclick = async () => { await P.deletePhoto(p.id); bitmapCache.delete(p.id); await refreshPhotos(); renderGrid(); };
    tile.querySelector('input').onchange = async (e) => {
      const [y, m, dd] = e.target.value.split('-').map(Number);
      if (!y) return;
      await P.updateDate(p.id, new Date(y, m - 1, dd, 12).getTime());
      await refreshPhotos(); renderGrid();
    };
    grid.appendChild(tile);
  });
}

$('#clearAll').onclick = async () => {
  if (!confirm(`Remove all ${photos.length} photos from this browser?`)) return;
  await P.clearPhotos();
  bitmapCache.clear();
  await refreshPhotos(); renderGrid();
  showPhoto(null);
};

// Google Photos picker
const gId = $('#gClientId');
gId.value = settings.gClientId;
gId.onchange = () => { settings.gClientId = gId.value.trim(); save('pictris.settings', settings); if (settings.gClientId) G.loadGis().catch(() => {}); };
$('#photosDlg details').addEventListener('toggle', (e) => { if (e.target.open && settings.gClientId) G.loadGis().catch(() => {}); });
let gToken = null, gSession = null;
$('#gConnect').onclick = async () => {
  if (!settings.gClientId) { status('Enter your OAuth client ID first (see README).'); gId.focus(); return; }
  try {
    await G.loadGis();
    status('Waiting for Google sign-in…');
    gToken = await G.requestToken(settings.gClientId);
    gSession = await G.createSession(gToken);
    $('#gPick').disabled = false;
    status('Signed in. Now press “Pick photos”.');
  } catch (e) { status(`Google sign-in failed: ${e.message}`); }
};
$('#gPick').onclick = async () => {
  if (!gToken || !gSession) return;
  const w = window.open(gSession.pickerUri + '/autoclose', 'gphotos', 'width=1000,height=760');
  if (!w) { status('Popup blocked — allow popups for this site and try again.'); return; }
  $('#gPick').disabled = true;
  try {
    status('Pick photos in the Google Photos window, then press Done there…');
    await G.waitForSelection(gToken, gSession);
    await P.requestPersistence();
    const r = await G.importSelection(gToken, gSession.id, (d, n) => status(`Downloading ${d} / ${n}…`));
    status(`Added ${r.count} photo${r.count === 1 ? '' : 's'} from Google Photos.` + (r.errors.length ? `\n${r.errors.length} failed: ${r.errors.slice(0, 2).join('; ')}` : ''));
    await refreshPhotos(); renderGrid();
  } catch (e) {
    status(`Google Photos import failed: ${e.message}`);
  } finally {
    gSession = null;
    $('#gPick').disabled = true;
    $('#gConnect').textContent = '1. Sign in again to pick more';
  }
};

// ---------------- boot ----------------
(async function boot() {
  renderBests();
  placeHud();
  try { await refreshPhotos(); } catch (e) { console.warn('IndexedDB unavailable', e); }
  menuSlide(true);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Test hook for automated checks.
  window.__pictris = { get game() { return game; }, startGame, refreshPhotos, P };
})();
