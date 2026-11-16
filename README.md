# Pictris

A calm falling-block puzzle game that weaves in your family photos. Static site — no server code, no accounts, photos never leave your browser.

## How photos are used

- **The photo is the reward:** each level starts with its photo heavily blurred and dimmed behind the board. Every line you clear brings it further into focus and makes the board more transparent, so it is nearly clear by the end of the level.
- **Solid blocks:** pieces are opaque, so a stack that builds up hides the photo. Playing clean keeps the picture visible. (Alternatives in Settings: lens blocks that show the photo sharp, or a photo on every piece.)
- **Level-up moment:** the game pauses for about 2.5 s, the board fades, and the finished photo pulls into full focus and eases out to show the whole frame; then the next photo drifts in. Any key cuts it short. Can be turned off.
- **Timeline:** photos are sorted by date taken (EXIF → filename like `IMG_20140612_…` → file date; editable per photo) and split into 15 equal eras (configurable). Level 1 draws from the oldest era, level 15+ from the newest.
- **Different every game:** with more photos than levels, each level picks at random within its era, never repeating within a game and preferring photos not shown in earlier games (history is kept in localStorage; least-recently-shown wins once all have been seen).
- **Album:** pause (or game over) → *Photos so far* (`V`) to browse the photos shown this game, with full dates. ←/→ to step through.
- **Dates:** the current photo's month and year sits small and dim under the board.
- **Menu:** slow slideshow of your library.

## Controls

Standard guideline layout (same as most modern block-stacking games):

| Key | Action |
| --- | --- |
| ← → | Move |
| ↓ | Soft drop |
| Space | Hard drop |
| ↑ / X | Rotate clockwise |
| Z / Ctrl | Rotate counter-clockwise |
| A | Rotate 180° |
| Shift / C | Hold |
| Esc / P / F1 | Pause |
| M | Mute |
| V | View photos so far (paused / game over) |
| R / Enter | Restart (paused / game over) |
| Numpad | 4/6 move, 2 soft, 8 hard, 1/5/9 CW, 3/7 CCW, 0 hold |

Touch: drag sideways to move, tap to rotate, drag down to soft drop, flick down to hard drop, flick up to hold.

DAS/ARR are adjustable in Settings.

## Gameplay

7-bag randomizer, SRS rotation with wall kicks, hold, 5-piece preview, ghost piece, 0.5 s lock delay with 15 move resets, T-spin / mini detection, back-to-back, combos, perfect-clear bonus, guideline gravity curve.

- **Marathon:** speeds up every 10 lines; game over on top-out.
- **Zen:** constant speed (your chosen start level), never ends — a full board quietly resets. Photos keep advancing every 10 lines and loop.

## Adding photos

Photos → three ways, which can be combined:

**1. Google Photos shared album link (shareable).** In Google Photos: album → Share → Create link. Paste it under *Google Photos shared album* → *Use album*. Photos load from Google as you play (nothing is copied). *Copy link to game + album* gives a link like

```
https://<you>.github.io/Pictris/?album=https%3A%2F%2Fphotos.app.goo.gl%2F…
```

Whoever opens it plays with that album, without touching their own photo library or settings.

How it works, and its limits:
- Google has no API for shared-album links and blocks browsers from reading the album page (no CORS). The page is therefore read through a **relay**; only the album page goes through it, the images come straight from Google. Public relays are tried by default (allorigins, codetabs, corsproxy.io). They are third-party and can be slow or down. For reliability, deploy `worker/relay.js` as a free Cloudflare Worker and set it under *Advanced*.
- The page format is undocumented and may change; the parser is in `src/album.js`.
- Google lists roughly the first 300 items of an album on that page.
- Anyone with the game link can see the album, exactly as with the album link itself.
- Uploaded (device-only) photos are not part of a shared link.

**2. Upload.** *Choose photos* / *Choose a folder*, or drag files onto the page. Images are resized to ≤2048 px and stored in IndexedDB in this browser only.

**3. Google Photos Picker (private copy).** Picks photos in Google's own UI and copies them into this browser. One-time setup:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → *APIs & Services* → enable **Google Photos Picker API**.
2. *OAuth consent screen*: External, add yourself (and family) as test users. Scope: `photospicker.mediaitems.readonly`.
3. *Credentials* → *Create OAuth client ID* → **Web application** → add your site's origin (e.g. `https://you.github.io`, and `http://localhost:8080` for local testing) to *Authorized JavaScript origins*.
4. Paste the client ID into Photos → *Import from Google Photos*, then *Sign in* → *Pick photos*.

## Running locally

```sh
python3 -m http.server 8080   # or: npm run serve
# open http://localhost:8080
npm test                       # game-logic + photo-timeline tests (Node ≥ 20)
```

No build step, no dependencies.

## Hosting

`.github/workflows/pages.yml` runs the tests and deploys to GitHub Pages on every push. One-time: repo *Settings → Pages → Build and deployment → Source: GitHub Actions*. The service worker (`sw.js`) makes the game work offline after first load (uploaded photos only) and installable as an app; after a deploy, the new version shows on the second visit.

## Tech

- **WebGL2** renderer (`src/renderer.js`): blurred photo backdrop via mipmapped multi-tap sampling, crossfades between two photo textures, batched rounded/bevelled blocks with screen-space photo sampling, a texture array for per-piece photos.
- **Pure logic** (`src/game.js`): no DOM, deterministic with a seed, unit-tested.
- **IndexedDB** photo library with a small EXIF reader (`src/photos.js`).
- **Web Audio** synthesized, pentatonic, quiet sounds (`src/audio.js`). Move/rotate clicks are off by default.
- No WebAssembly: the game logic is a few microseconds per frame in JS, so WASM would add a toolchain without a measurable benefit.
