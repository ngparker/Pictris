// Photo library: resized copies stored in IndexedDB (localStorage is far too small for images).

const DB_NAME = 'pictris';
const STORE = 'photos';
const MAX_SIDE = 2048;
const THUMB_SIDE = 240;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** All photo records, oldest first. */
export async function listPhotos() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.date - b.date);
}

export const deletePhoto = (id) => tx('readwrite', (s) => s.delete(id));
export const clearPhotos = () => tx('readwrite', (s) => s.clear());
export const putPhoto = (rec) => tx('readwrite', (s) => s.put(rec));

export async function updateDate(id, date) {
  const rec = await tx('readonly', (s) => s.get(id));
  if (!rec) return;
  rec.date = date;
  rec.dateSource = 'manual';
  await putPhoto(rec);
}

// ---------- date detection ----------

/** Reads EXIF DateTimeOriginal (or DateTime) from a JPEG. Returns ms epoch or null. */
export async function exifDate(blob) {
  try {
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
        return parseTiffDate(v, off + 10);
      }
      off += 2 + len;
    }
  } catch { /* malformed */ }
  return null;
}

function parseTiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(t + o, le);
  const u32 = (o) => v.getUint32(t + o, le);
  const readAscii = (o, n) => {
    let s = '';
    for (let i = 0; i < n - 1 && t + o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(t + o + i));
    return s;
  };
  const entries = (ifd) => {
    const out = {};
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), val: u32(e + 8) };
    }
    return out;
  };
  const ifd0 = entries(u32(4));
  let str = null;
  if (ifd0[0x8769]) {
    const ex = entries(ifd0[0x8769].val);
    const e = ex[0x9003] || ex[0x9004];
    if (e) str = readAscii(e.val, e.count);
  }
  if (!str && ifd0[0x0132]) str = readAscii(ifd0[0x0132].val, ifd0[0x0132].count);
  return parseExifString(str);
}

function parseExifString(s) {
  const m = s && s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === '0000') return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) ? null : d.getTime();
}

/** Date from names like IMG_20140612_101500.jpg, PXL_20230101..., 2015-06-12 10.15.00.jpg */
export function filenameDate(name) {
  const m = name && name.match(/(19[7-9]\d|20[0-4]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
  return isNaN(d) ? null : d.getTime();
}

// ---------- import ----------

async function resize(bitmap, maxSide, quality) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else { canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return { blob, w, h };
}

/**
 * Store an image. `knownDate` (ms) wins over EXIF / filename / lastModified.
 * @returns {Promise<object>} the stored record
 */
export async function importImage(blob, { name = 'photo', knownDate = null, source = 'upload', lastModified = null } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${name}: this browser can't decode it (HEIC? export as JPEG)`);
  }
  let date = knownDate, dateSource = knownDate ? source : null;
  if (!date) { date = await exifDate(blob); dateSource = date && 'exif'; }
  if (!date) { date = filenameDate(name); dateSource = date && 'filename'; }
  if (!date) { date = lastModified || Date.now(); dateSource = 'file'; }
  const full = await resize(bitmap, MAX_SIDE, 0.88);
  const thumb = await resize(bitmap, THUMB_SIDE, 0.8);
  bitmap.close?.();
  const rec = {
    id: (crypto.randomUUID?.() || String(Math.random()).slice(2)),
    name, date, dateSource, source,
    w: full.w, h: full.h,
    blob: full.blob, thumb: thumb.blob,
    added: Date.now(),
  };
  await putPhoto(rec);
  return rec;
}

export async function importFiles(files, onProgress = () => {}) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic)$/i.test(f.name));
  const errors = [];
  let done = 0;
  for (const f of list) {
    try {
      await importImage(f, { name: f.name, lastModified: f.lastModified });
    } catch (e) {
      errors.push(e.message);
    }
    onProgress(++done, list.length);
  }
  return { count: done - errors.length, errors };
}

export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}

// ---------- timeline ----------

/**
 * Pick the photo for a level.
 * Chronological: the library is split into `span` equal eras (oldest first); level 1 draws
 * from the earliest era, level `span`+ from the latest (`loop` wraps around instead).
 * Shuffle: draws from the whole library.
 * Within the candidates, photos in `exclude` (already used this game) are skipped when
 * possible, then the least-recently-seen ones (`seen`: id -> timestamp) are preferred, and
 * `seed` picks at random among those. So every game differs and repeats are spread out.
 */
export function photoForLevel(photos, level, { order = 'chrono', span = 15, seed = 0, loop = false, seen = {}, exclude = null } = {}) {
  const n = photos.length;
  if (!n) return null;
  let cands = photos;
  if (order !== 'shuffle') {
    const L = loop ? (level - 1) % span : Math.min(level - 1, span - 1);
    const lo = Math.floor((L * n) / span);
    const hi = Math.max(lo + 1, Math.floor(((L + 1) * n) / span));
    cands = photos.slice(Math.min(lo, n - 1), Math.min(hi, n));
  }
  if (exclude && exclude.size) {
    const fresh = cands.filter((p) => !exclude.has(p.id));
    if (fresh.length) cands = fresh;
  }
  let oldest = Infinity;
  for (const p of cands) oldest = Math.min(oldest, seen[p.id] || 0);
  cands = cands.filter((p) => (seen[p.id] || 0) === oldest);
  return cands[hash(seed * 31 + level) % cands.length];
}

/** The first level (chronological order) at which photo index i can appear. */
export function levelOfIndex(i, n, span) {
  for (let L = 1; L <= span; L++) {
    const lo = Math.floor(((L - 1) * n) / span);
    const hi = Math.max(lo + 1, Math.floor((L * n) / span));
    if (i >= lo && i < hi) return L;
  }
  return span;
}

function hash(x) {
  x = (x | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
