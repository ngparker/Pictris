// Google Photos *shared album links* (photos.app.goo.gl/… or photos.google.com/share/…).
//
// Google offers no API for these and the album page sends no CORS headers, so a browser
// cannot read it directly. The page is fetched through a small CORS relay (see README;
// worker/relay.js is one you can host yourself). Only the album page goes through the relay;
// the photos themselves load straight from Google's image servers.

export const DEFAULT_RELAYS = [
  'https://api.allorigins.win/raw?url={url}',
  'https://api.codetabs.com/v1/proxy/?quest={url}',
  'https://corsproxy.io/?url={url}',
];

/** Returns a canonical https album URL, or null if it isn't a Google Photos share link. */
export function normalizeAlbumUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const short = u.hostname === 'photos.app.goo.gl' && /^\/[\w-]+$/.test(u.pathname);
  const long = u.hostname === 'photos.google.com' && /^\/share\/[\w-]+/.test(u.pathname);
  if (!short && !long) return null;
  const key = u.searchParams.get('key');
  return `https://${u.hostname}${u.pathname}${long && key ? `?key=${encodeURIComponent(key)}` : ''}`;
}

export function validRelay(tpl) {
  return typeof tpl === 'string' && tpl.includes('{url}') && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(tpl);
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Extract photos from a shared-album page. The page embeds its data as nested JS arrays:
 *   ["<media key>",["https://lh3.googleusercontent.com/pw/…",width,height,…],<taken ms>,…]
 * This scans for that shape rather than parsing the whole structure, so it tolerates
 * unrelated changes around it. Only googleusercontent image URLs are ever accepted.
 */
export function parseAlbumHtml(html, now = Date.now()) {
  const items = [];
  const seenUrls = new Set();
  const re = /\["(https:\/\/lh[3-6]\.googleusercontent\.com\/[^"\\\s]+)",(\d+),(\d+)/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].split('=')[0];
    const w = +m[2], h = +m[3];
    if (w < 64 || h < 64 || seenUrls.has(url)) continue;
    let tail = html.slice(re.lastIndex, re.lastIndex + 700);
    const nextItem = tail.indexOf('"https://lh');
    if (nextItem >= 0) tail = tail.slice(0, nextItem);
    const ts = tail.match(/[,[](\d{12,13})[,\]]/);
    let date = ts ? +ts[1] : null;
    if (date !== null && (date < 0 || date > now + 864e5)) date = null;
    const key = html.slice(Math.max(0, m.index - 120), m.index).match(/"([\w-]{20,})",\s*$/);
    seenUrls.add(url);
    items.push({ id: 'g:' + (key ? key[1] : hashStr(url)), url, w, h, date });
  }
  // Items are only trustworthy if they look like album media (have a date); if none do, keep all.
  const dated = items.filter((i) => i.date !== null);
  const out = (dated.length ? dated : items).map((i) => ({ ...i, date: i.date ?? now, dated: i.date !== null }));
  const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/);
  let title = t ? decodeEntities(t[1]).trim() : '';
  title = title.replace(/\s*[-·|]\s*Google Photos\s*$/i, '');
  return { title: title.slice(0, 120), items: out };
}

async function relayFetch(tpl, target, as) {
  const r = await fetch(tpl.replace('{url}', encodeURIComponent(target)), {
    signal: AbortSignal.timeout?.(25000), referrerPolicy: 'no-referrer', credentials: 'omit',
  });
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
  return as === 'blob' ? r.blob() : r.text();
}

export function relayList(custom) {
  return validRelay(custom) ? [custom, ...DEFAULT_RELAYS] : DEFAULT_RELAYS;
}

/** Fetch and parse an album through the first relay that returns a usable page. */
export async function fetchAlbum(albumUrl, relays = DEFAULT_RELAYS) {
  const url = normalizeAlbumUrl(albumUrl);
  if (!url) throw new Error('That is not a Google Photos shared album link.');
  let last = new Error('no relay configured');
  for (const tpl of relays) {
    try {
      const album = parseAlbumHtml(await relayFetch(tpl, url, 'text'));
      if (album.items.length) return { ...album, url, fetchedAt: Date.now() };
      last = new Error('no photos found on the album page');
    } catch (e) { last = e; }
  }
  throw new Error(`Couldn't read the album (${last.message}). Check that link sharing is on, or try again later.`);
}

const cacheKey = (url) => 'pictris.album.' + url;
export function cachedAlbum(url) {
  try { return JSON.parse(localStorage.getItem(cacheKey(url)) || 'null'); } catch { return null; }
}
function storeAlbum(album) {
  try { localStorage.setItem(cacheKey(album.url), JSON.stringify(album)); } catch { /* quota / private mode */ }
}
export function forgetAlbum(url) {
  try { localStorage.removeItem(cacheKey(url)); } catch { /* ignore */ }
}

/**
 * Cached album immediately if there is one (refreshing in the background when older than
 * `maxAge`, reporting through onUpdate); otherwise waits for the network.
 */
export async function loadAlbum(albumUrl, { relays, maxAge = 3600e3, onUpdate } = {}) {
  const url = normalizeAlbumUrl(albumUrl);
  if (!url) throw new Error('That is not a Google Photos shared album link.');
  const cached = cachedAlbum(url);
  const refresh = () => fetchAlbum(url, relays).then((a) => { storeAlbum(a); return a; });
  if (!cached) return refresh();
  if (Date.now() - cached.fetchedAt > maxAge) refresh().then((a) => onUpdate?.(a)).catch(() => {});
  return cached;
}

/** Photo records in the same shape the local library uses, minus blobs. */
export function albumRecords(album) {
  return album.items.map((i) => ({
    id: i.id, remote: true, url: i.url, w: i.w, h: i.h, date: i.date,
    dateSource: i.dated ? 'album' : 'unknown', name: 'Google Photos',
  }));
}

export const sized = (rec, px, crop = false) => `${rec.url}=w${px}-h${px}${crop ? '-c' : ''}`;

/** Image bytes for WebGL. Direct from Google when CORS allows, otherwise through the relays. */
export async function remoteBlob(rec, px = 2048, relays = DEFAULT_RELAYS) {
  const target = sized(rec, px);
  try {
    const r = await fetch(target, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.ok) return await r.blob();
  } catch { /* fall through to relays */ }
  let last;
  for (const tpl of relays) {
    try {
      const b = await relayFetch(tpl, target, 'blob');
      if (b.type.startsWith('image/')) return b;
      last = new Error('relay did not return an image');
    } catch (e) { last = e; }
  }
  throw last || new Error('photo unavailable');
}

export function shareLink(albumUrl, base = location.origin + location.pathname) {
  return `${base}?album=${encodeURIComponent(albumUrl)}`;
}
