// Google Photos Picker API (client-side). The user picks photos in Google's own UI;
// we download resized copies and keep them locally in IndexedDB.
// Requires an OAuth "Web application" client ID whose Authorized JavaScript origins
// include the site's origin. See README.

import { importImage } from './photos.js';

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';

let gisPromise = null;
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

/** Must be called from a click handler, after loadGis() has resolved, so the popup isn't blocked. */
export function requestToken(clientId) {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.message || e.type || 'Sign-in cancelled')),
    });
    client.requestAccessToken();
  });
}

async function api(token, path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Google Photos API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

export const createSession = (token) => api(token, '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

const dur = (s, d) => (s ? parseFloat(s) * 1000 : d);

/** The access token is only ever attached to Google's own image servers. */
export function isGoogleImageUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'googleusercontent.com' || x.hostname.endsWith('.googleusercontent.com'));
  } catch { return false; }
}

/** Polls until the user has finished picking. */
export async function waitForSelection(token, session, { signal } = {}) {
  const interval = Math.max(1000, dur(session.pollingConfig?.pollInterval, 3000));
  const deadline = Date.now() + Math.min(dur(session.pollingConfig?.timeoutIn, 30 * 60e3), 30 * 60e3);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    const s = await api(token, `/sessions/${session.id}`);
    if (s.mediaItemsSet) return s;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Timed out waiting for photo selection');
}

export async function importSelection(token, sessionId, onProgress = () => {}) {
  const items = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await api(token, `/mediaItems?${q}`);
    items.push(...(r.mediaItems || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);

  const photos = items.filter((i) => i.type !== 'VIDEO' && !(i.mediaFile?.mimeType || '').startsWith('video/'));
  const errors = [];
  let done = 0;
  for (const item of photos) {
    try {
      const base = item.mediaFile?.baseUrl;
      if (!isGoogleImageUrl(base)) throw new Error('unexpected download address; skipped');
      const r = await fetch(`${base}=w2048-h2048`, { headers: { Authorization: `Bearer ${token}` }, referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const blob = await r.blob();
      const created = item.createTime ? Date.parse(item.createTime) : null;
      await importImage(blob, { name: item.mediaFile.filename || 'Google Photo', knownDate: created, source: 'google' });
    } catch (e) {
      errors.push(`${item.mediaFile?.filename || item.id}: ${e.message}`);
    }
    onProgress(++done, photos.length);
  }
  api(token, `/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  return { count: done - errors.length, errors };
}
