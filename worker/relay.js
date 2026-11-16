// Optional: your own relay for Google Photos shared-album links, as a free Cloudflare Worker.
// Deploy: dash.cloudflare.com → Workers → Create → paste this → Deploy.
// Then in Pictris: Photos → Shared album → Advanced → relay = https://<name>.<you>.workers.dev/?url={url}
//
// It only fetches Google Photos share pages and Google-hosted images, nothing else.
const ALLOWED = [/^photos\.app\.goo\.gl$/, /^photos\.google\.com$/, /^lh[3-6]\.googleusercontent\.com$/];

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const target = new URL(request.url).searchParams.get('url');
    let u;
    try { u = new URL(target); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (u.protocol !== 'https:' || !ALLOWED.some((re) => re.test(u.hostname))) {
      return new Response('host not allowed', { status: 403, headers: cors });
    }
    const r = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' } });
    if (!ALLOWED.some((re) => re.test(new URL(r.url).hostname))) {
      return new Response('redirected off Google', { status: 502, headers: cors });
    }
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'text/plain', 'Cache-Control': 'public, max-age=600' },
    });
  },
};
