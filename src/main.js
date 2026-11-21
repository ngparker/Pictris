import { Game, LINES_PER_LEVEL } from './game.js';
import { Renderer } from './renderer.js';
import { Sound } from './audio.js';
import * as P from './photos.js';
import * as G from './gphotos.js';
import * as A from './album.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------- settings ----------------
const DEFAULTS = {
  blockStyle: 'color', order: 'chrono', span: 15, background: true, dim: 0.5, blur: 3, tint: 0.15, v: 2,
  boardOpacity: 0.72, captions: true, ghost: true, previews: 5, das: 167, arr: 33,
  reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, volume: 0.5, moveSounds: false,
  startLevel: 1, gClientId: '', celebrate: true, avoidRepeats: true, experience: 'focus', albumUrl: '', relay: '',
};
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
let settings = load('pictris.settings', DEFAULTS);
let best = load('pictris.best', { marathon: 0, zen: 0 });
let seen = load('pictris.seen', {}); // photo id -> last time it was the level photo
if (settings.blockStyle === 'photo') settings.blockStyle = 'reveal';
if (settings.blockStyle === 'pieces') settings.blockStyle = 'color';
// v2: solid blocks, photo comes into focus as the level progresses.
if (!(load('pictris.settings', {}).v >= 2)) Object.assign(settings, { blockStyle: 'color', blur: DEFAULTS.blur, dim: DEFAULTS.dim, v: 2 });

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
  const bmp = await createImageBitmap(rec.remote ? await A.remoteBlob(rec, 2048, relays()) : rec.blob);
  bitmapCache.set(rec.id, bmp);
  // Evict without close(): an in-flight caller may still be about to upload it; GC reclaims it.
  if (bitmapCache.size > 16) bitmapCache.delete(bitmapCache.keys().next().value);
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

// The photo for each level is chosen once per game, then remembered.
let picks = new Map(); // level -> photo record
let gameShown = []; // [{ rec, level }] in the order shown this game
function photoForGame(level, mode = game?.mode) {
  if (picks.has(level)) return picks.get(level);
  const rec = P.photoForLevel(photos, level, {
    order: settings.order, span: settings.span, seed, loop: mode === 'zen',
    seen: settings.avoidRepeats ? seen : {}, exclude: new Set([...picks.values()].map((r) => r.id)),
  });
  if (rec) picks.set(level, rec);
  return rec;
}

/** Make `level`'s photo the current one, record it, and warm up the next. */
function showLevelPhoto(level, mode = game?.mode) {
  focus = 0;
  renderer.resetMosaic(); // a new level always assembles from scratch, even when the photo repeats
  const rec = photoForGame(level, mode);
  showPhoto(rec);
  setCaption(rec);
  if (!rec) return;
  if (!gameShown.some((g) => g.level === level)) gameShown.push({ rec, level });
  seen[rec.id] = Date.now();
  save('pictris.seen', seen);
  const next = photoForGame(level + 1, mode);
  if (next) bitmapFor(next).catch(() => {});
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

// ---- album links ----
// A link opened with ?album=… plays that album only, without touching this browser's own library.
const sharedAlbumUrl = A.normalizeAlbumUrl(new URLSearchParams(location.search).get('album') || '');
const activeAlbumUrl = () => sharedAlbumUrl || A.normalizeAlbumUrl(settings.albumUrl);
const relays = () => A.relayList(settings.relay);
let album = null; // { title, items, url }
let albumError = '';

async function loadActiveAlbum() {
  const url = activeAlbumUrl();
  album = null; albumError = '';
  if (!url) return;
  try {
    album = await A.loadAlbum(url, { relays: relays(), onUpdate: (a) => { if (activeAlbumUrl() === a.url) { album = a; mergePhotos(); } } });
  } catch (e) {
    albumError = e.message;
  }
}

let localPhotos = [];
function mergePhotos() {
  const remote = album ? A.albumRecords(album) : [];
  photos = (sharedAlbumUrl ? remote : [...localPhotos, ...remote]).sort((a, b) => a.date - b.date);
  $('#photoCount').textContent = photos.length;
  const range = photos.length ? `${fmtDate(photos[0].date)} – ${fmtDate(photos[photos.length - 1].date)}` : '';
  const name = album?.title ? `“${album.title}”` : 'Shared album';
  let hint;
  if (albumError && sharedAlbumUrl) hint = albumError;
  else if (sharedAlbumUrl) hint = `${name} · ${photos.length} photos, ${range}`;
  else if (photos.length) hint = `${photos.length} photo${photos.length > 1 ? 's' : ''}, ${range}`;
  else hint = 'Add some family photos to see them appear as you play.';
  $('#photoHint').textContent = hint;
  $('#sharedBar').hidden = !sharedAlbumUrl;
  $('#menuShareRow').hidden = !(album && activeAlbumUrl());
}

async function refreshPhotos({ reloadAlbum = false } = {}) {
  try { localPhotos = sharedAlbumUrl ? [] : await P.listPhotos(); } catch (e) { console.warn('IndexedDB unavailable', e); localPhotos = []; }
  if (reloadAlbum || (!album && !albumError)) await loadActiveAlbum();
  mergePhotos();
}

async function shareGame(statusEl) {
  const url = activeAlbumUrl();
  if (!url) return;
  const link = A.shareLink(url);
  const field = $('#shareUrl');
  field.value = link;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: 'Pictris', text: album?.title ? `Play Pictris with “${album.title}”` : 'Play Pictris with our photos', url: link });
      statusEl.textContent = '';
    } else {
      await navigator.clipboard.writeText(link);
      statusEl.textContent = 'Link copied. Anyone who opens it plays with this album.';
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    field.hidden = false;
    statusEl.textContent = 'Copy the link below:';
    if ($('#photosDlg').open) { field.focus(); field.select(); } else prompt('Copy this link', link);
  }
}

// Calm slideshow behind the menu.
let menuTimer = 0;
function menuSlide(instant = false) {
  if (!photos.length) return showPhoto(null, instant);
  const rec = photos[Math.floor(Math.random() * photos.length)];
  showPhoto(rec, instant);
  setCaption(rec);
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
  const cap = $('#caption');
  if (L.portrait) {
    // Phone: the date sits at the right end of the stats row (where Best would be).
    cap.style.top = px(L.stats.y + L.cell * 0.45);
    cap.style.right = px(L.W - (L.stats.x + L.stats.w));
  } else {
    cap.style.top = px(L.by + L.bh + L.cell * 0.35);
    cap.style.right = '';
  }
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1100);
}
/** The date of the current photo, shown small and dim under the board. */
function setCaption(rec, bright = false) {
  const c = $('#caption');
  const on = !!rec && settings.captions;
  if (on) c.textContent = fmtDate(rec.date);
  c.classList.toggle('show', on);
  c.classList.toggle('bright', on && bright);
}

// Level-up moment: the board fades, the finished photo comes into full focus, then the next one drifts in.
const CEL = { in: 450, hold: 1500, out: 700 };
const SEAL = 1100; // mosaic only: last tiles land, then gaps close, before the reveal starts
const ease01 = (x) => Math.min(1, Math.max(0, x));
let celebrate = null; // { t, level, switched }
const ease = (x) => x * x * (3 - 2 * x);
function stepCelebrate(dt) {
  const c = celebrate;
  c.t += dt;
  if (!c.switched && c.t >= CEL.in + CEL.hold) {
    c.switched = true;
    showLevelPhoto(c.level);
    document.body.classList.remove('celebrate');
  }
  if (c.t >= CEL.in + CEL.hold + CEL.out) { celebrate = null; return; }
}
function revealAmount() {
  if (!celebrate) return 0;
  const t = celebrate.t;
  if (t < 0) return 0;
  if (t < CEL.in) return ease(t / CEL.in);
  if (t < CEL.in + CEL.hold) return 1;
  return 1 - ease(Math.min(1, (t - CEL.in - CEL.hold) / CEL.out));
}
function endCelebration() {
  if (celebrate && !celebrate.switched) showLevelPhoto(celebrate.level);
  celebrate = null;
  document.body.classList.remove('celebrate');
}

// ---------------- game flow ----------------
function onEvent(type, d) {
  switch (type) {
    case 'lock': sound.lock(d.hard); break;
    case 'move': if (settings.moveSounds) sound.move(); break;
    case 'rotate': if (settings.moveSounds) sound.rotate(); break;
    case 'hold': sound.hold(); break;
    case 'clear': {
      if (d.lines) { sound.clear(d.lines, d.combo); renderer.pulse(); }
      break;
    }
    case 'levelup': {
      sound.levelUp();
      if (settings.celebrate && currentPhotoId !== null) {
        celebrate = { t: settings.experience === 'mosaic' ? -SEAL : 0, level: d.level, switched: false };
        document.body.classList.add('celebrate');
        setCaption(photos.find((p) => p.id === currentPhotoId), true);
      } else {
        showLevelPhoto(d.level);
      }
      break;
    }
    case 'zenReset': toast('Fresh board'); break;
    case 'gameover': endGame(); break;
  }
}

let starting = false;
let focus = 0; // smoothed progress through the current level, 0..1
async function startGame(mode = game?.mode || 'marathon') {
  if (starting) return;
  starting = true;
  seed = (Math.random() * 2 ** 31) | 0;
  game = null;
  picks = new Map();
  gameShown = [];
  endCelebration();
  starting = false;
  game = new Game({ mode, startLevel: settings.startLevel, seed, onEvent });
  lastHud = '';
  state = 'play';
  paused = false;
  $('#menu').hidden = true; $('#pause').hidden = true; $('#over').hidden = true;
  $('#hud').hidden = false;
  placeHud();
  updateHud();
  showLevelPhoto(game.level);
  sound.ensure();
  canvas.focus?.();
}

function endGame() {
  state = 'over';
  endCelebration();
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
  endCelebration();
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
  ShiftRight: 'hold', Escape: 'pause', KeyP: 'pause', F1: 'pause', KeyM: 'mute', KeyR: 'restart', Enter: 'enter', KeyV: 'album',
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
  if (state === 'over') {
    if (act === 'restart' || act === 'enter') startGame();
    else if (act === 'pause') toMenu();
    else if (act === 'album') openDialog('albumDlg');
    return;
  }
  if (state === 'pause') {
    if (act === 'pause' || act === 'enter') setPause(false);
    else if (act === 'restart') startGame();
    else if (act === 'album') openDialog('albumDlg');
    return;
  }
  if (act === 'pause') return setPause(true);
  if (!game || e.repeat) return;
  if (celebrate) {
    // A key press cuts the photo moment short; it isn't passed on to the piece.
    if (act !== 'album' && celebrate.t > 500 && celebrate.t < CEL.in + CEL.hold) celebrate.t = CEL.in + CEL.hold;
    else if (act !== 'album' && celebrate.t < 0 && celebrate.t > -SEAL + 400) celebrate.t = 0;
    return;
  }
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
    if (celebrate) stepCelebrate(dt);
    else { input.update(dt); game.tick(dt); }
    updateHud();
  }
  if (game) {
    // During the level-up moment the finished photo stays complete; the next level starts from 0.
    let target = (game.lines - (game.level - game.startLevel) * LINES_PER_LEVEL) / LINES_PER_LEVEL;
    if (game.over) target = focus;
    else if (celebrate && !celebrate.switched) target = 1;
    focus += (target - focus) * Math.min(1, dt / (target < focus ? 1200 : 500));
  } else focus = 0;
  if (state === 'menu') {
    menuTimer += dt;
    if (menuTimer > 14000) { menuTimer = 0; menuSlide(); }
  }
  renderer.render({ game: state === 'menu' ? null : game, time: now, dt, settings,
    focus, reveal: revealAmount(), seal: celebrate && !celebrate.switched ? ease01((celebrate.t + 350) / 350) : 0, shine: celebrate ? celebrate.t / (CEL.in + CEL.hold) : 0 });
  requestAnimationFrame(frame);
}

addEventListener('resize', placeHud);

// ---------------- menus & dialogs ----------------
const sel = $('#startLevel');
for (let i = 1; i <= 15; i++) sel.add(new Option(i, i));
sel.value = settings.startLevel;
sel.onchange = () => { settings.startLevel = +sel.value; save('pictris.settings', settings); };

$$('[data-start]').forEach((b) => (b.onclick = () => startGame(b.dataset.start)));
function renderExp() {
  $$('[data-exp]').forEach((b) => b.setAttribute('aria-checked', b.dataset.exp === settings.experience));
}
$$('[data-exp]').forEach((b) => (b.onclick = () => {
  settings.experience = b.dataset.exp; save('pictris.settings', settings); renderExp();
}));
renderExp();
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
  if (id === 'albumDlg') renderAlbum();
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
  if (el.name === 'experience') renderExp();
  if (el.name === 'captions') setCaption(photos.find((p) => p.id === currentPhotoId));
  if ((el.name === 'order' || el.name === 'span') && game) {
    for (const k of [...picks.keys()]) if (k >= game.level) picks.delete(k);
    showLevelPhoto(game.level);
  }
});
$('#resetSettings').onclick = () => {
  settings = { ...DEFAULTS, gClientId: settings.gClientId, startLevel: settings.startLevel, albumUrl: settings.albumUrl, relay: settings.relay };
  save('pictris.settings', settings);
  fillSettings();
};

// album of photos shown this game
let albumAt = 0, albumUrl = null;
const albumThumbs = [];
function renderAlbum() {
  albumThumbs.splice(0).forEach(URL.revokeObjectURL);
  const strip = $('#albumStrip');
  strip.textContent = '';
  const has = gameShown.length > 0;
  $('#albumEmpty').hidden = has;
  $('#albumFig').hidden = !has;
  $('#albumCap').hidden = !has;
  if (!has) return;
  gameShown.forEach((g, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `Level ${g.level} · ${fmtDate(g.rec.date)}`;
    const img = new Image();
    let url;
    if (g.rec.remote) url = A.sized(g.rec, 240, true);
    else { url = URL.createObjectURL(g.rec.thumb); albumThumbs.push(url); }
    img.referrerPolicy = 'no-referrer';
    img.src = url; img.alt = b.title;
    b.append(img);
    b.onclick = () => albumShow(i);
    strip.append(b);
  });
  albumShow(gameShown.length - 1);
}
function albumShow(i) {
  albumAt = (i + gameShown.length) % gameShown.length;
  const g = gameShown[albumAt];
  if (albumUrl) URL.revokeObjectURL(albumUrl);
  albumUrl = g.rec.remote ? null : URL.createObjectURL(g.rec.blob);
  $('#albumImg').referrerPolicy = 'no-referrer';
  $('#albumImg').src = albumUrl || A.sized(g.rec, 2048);
  $('#albumCap').textContent = `${fmtDay(g.rec.date)} · level ${g.level}`;
  [...$('#albumStrip').children].forEach((b, k) => {
    b.setAttribute('aria-current', k === albumAt);
    if (k === albumAt) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const many = gameShown.length > 1;
  $('#albumPrev').style.visibility = $('#albumNext').style.visibility = many ? '' : 'hidden';
}
$('#albumPrev').onclick = () => albumShow(albumAt - 1);
$('#albumNext').onclick = () => albumShow(albumAt + 1);
$('#albumDlg').addEventListener('keydown', (e) => {
  if (!gameShown.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); albumShow(albumAt - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); albumShow(albumAt + 1); }
});

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
  $('#clearAll').hidden = !localPhotos.length;
  $('#sharedNote').hidden = !sharedAlbumUrl;
  $('#ownPhotos').hidden = !!sharedAlbumUrl;
  $('#albumActions').hidden = !(album && !sharedAlbumUrl);
  if (!sharedAlbumUrl && albumError) $('#albumStatus').textContent = albumError;
  const span = settings.span;
  photos.forEach((p, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    let url;
    if (p.remote) { url = A.sized(p, 240, true); tile.classList.add('remote'); }
    else { url = URL.createObjectURL(p.thumb); thumbUrls.push(url); }
    const lvl = settings.order === 'chrono' ? P.levelOfIndex(i, photos.length, span) : null;
    const d = new Date(p.date);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    tile.innerHTML = `<img alt="" loading="lazy">${lvl ? `<span class="era">L${lvl}${lvl === span ? '+' : ''}</span>` : ''}
      <button class="del" title="Remove" aria-label="Remove photo">✕</button>
      <div class="meta"><input type="date" ${p.remote ? 'disabled title="From the shared album"' : `title="Date taken (${p.dateSource}) — change to reorder"`} value="${iso}"></div>`;
    const timg = tile.querySelector('img');
    timg.referrerPolicy = 'no-referrer';
    timg.src = url;
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
  if (!confirm(`Remove all ${localPhotos.length} uploaded photos from this browser?`)) return;
  await P.clearPhotos();
  bitmapCache.clear();
  seen = {};
  save('pictris.seen', seen);
  await refreshPhotos(); renderGrid();
  showPhoto(null);
};

// shared album link
const albumInput = $('#albumUrl'), albumStatus = (t) => ($('#albumStatus').textContent = t);
albumInput.value = settings.albumUrl;
$('#relayUrl').value = settings.relay;
$('#relayUrl').onchange = (e) => {
  const v = e.target.value.trim();
  if (v && !A.validRelay(v)) { albumStatus('Relay must be an https:// address containing {url}.'); return; }
  settings.relay = v; save('pictris.settings', settings); albumStatus(v ? 'Relay saved.' : 'Using the default relays.');
};
async function useAlbum() {
  const url = A.normalizeAlbumUrl(albumInput.value);
  if (!url) { albumStatus('Paste a Google Photos shared album link (https://photos.app.goo.gl/…).'); return; }
  albumStatus('Loading album…');
  $('#albumUse').disabled = true;
  settings.albumUrl = url; save('pictris.settings', settings);
  A.forgetAlbum(url);
  await refreshPhotos({ reloadAlbum: true });
  $('#albumUse').disabled = false;
  albumStatus(album ? `${album.title ? `“${album.title}”: ` : ''}${album.items.length} photos${album.items.length >= 300 ? ' (Google lists only the first ~300 of a large album)' : ''}.` : albumError);
  renderGrid();
}
$('#albumUse').onclick = useAlbum;
albumInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useAlbum(); } });
$('#albumRemove').onclick = async () => {
  if (settings.albumUrl) A.forgetAlbum(settings.albumUrl);
  settings.albumUrl = ''; save('pictris.settings', settings);
  albumInput.value = ''; $('#shareUrl').hidden = true;
  await refreshPhotos({ reloadAlbum: true });
  albumStatus('Album removed.');
  renderGrid();
};
$('#shareBtn').onclick = () => shareGame($('#albumStatus'));
$('#menuShare').onclick = () => shareGame($('#menuShareStatus'));

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
  await refreshPhotos();
  menuSlide(true);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Test hook for automated checks.
  window.__pictris = { get game() { return game; }, get photos() { return photos; }, startGame, refreshPhotos, P };
})();
