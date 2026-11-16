# Pictris

A calm falling-block puzzle game that weaves in your family photos. Static site — no server code, no accounts, photos never leave your browser.

## How photos are used

- **Timeline:** photos are sorted by date taken (EXIF → filename like `IMG_20140612_…` → file date; editable per photo). Level 1 shows the oldest era; each level-up crossfades forward in time, reaching the newest photos at level 15 (configurable). With more photos than levels, each game picks a random photo from each era, so games differ.
- **Background:** the current photo, softly blurred and dimmed behind the board, with a very slow drift.
- **Blocks:** locked blocks are windows onto the sharp photo behind the board — your stack gradually reveals the picture. Falling piece and ghost stay solid colors for readability. Switch to plain colors in Settings.
- **Captions:** “Level 5 · June 2016” fades in under the board on level-up (can be turned off).
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
| R / Enter | Restart (paused / game over) |
| Numpad | 4/6 move, 2 soft, 8 hard, 1/5/9 CW, 3/7 CCW, 0 hold |

Touch: drag sideways to move, tap to rotate, drag down to soft drop, flick down to hard drop, flick up to hold.

DAS/ARR are adjustable in Settings.

## Gameplay

7-bag randomizer, SRS rotation with wall kicks, hold, 5-piece preview, ghost piece, 0.5 s lock delay with 15 move resets, T-spin / mini detection, back-to-back, combos, perfect-clear bonus, guideline gravity curve.

- **Marathon:** speeds up every 10 lines; game over on top-out.
- **Zen:** constant speed (your chosen start level), never ends — a full board quietly resets. Photos keep advancing every 10 lines and loop.

## Adding photos

**Upload (simplest):** Photos → *Choose photos* / *Choose a folder*, or drag files onto the page. Images are resized to ≤2048 px and stored in IndexedDB (localStorage is limited to ~5 MB, too small for photos). To bring in a Google Photos album this way: open the album → ⋮ → *Download all* → unzip → *Choose a folder*.

**Google Photos import (Picker API):** picks photos in Google's own UI and copies them locally. One-time setup:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → *APIs & Services* → enable **Google Photos Picker API**.
2. *OAuth consent screen*: External, add yourself (and family) as test users. Scope: `photospicker.mediaitems.readonly`.
3. *Credentials* → *Create OAuth client ID* → **Web application** → add your site's origin (e.g. `https://you.github.io`, and `http://localhost:8080` for local testing) to *Authorized JavaScript origins*.
4. Paste the client ID into Photos → *Import from Google Photos*, then *Sign in* → *Pick photos*.

**Why not a shared-album link?** Google Photos has no public API for shared-album links, and the album pages can't be fetched from a browser (no CORS). Since March 2025 Google also restricts the Library API to app-created content, so the Picker API is the supported client-side route.

## Running locally

```sh
python3 -m http.server 8080   # or: npm run serve
# open http://localhost:8080
npm test                       # game-logic + photo-timeline tests (Node ≥ 20)
```

No build step, no dependencies.

## Hosting

Any static host works. Note: GitHub Pages from a **private** repo needs a paid GitHub plan; Cloudflare Pages and Netlify can deploy private repos on free tiers. The service worker (`sw.js`) makes it work offline after first load and installable as an app.

## Tech

- **WebGL2** renderer (`src/renderer.js`): blurred photo backdrop via mipmapped multi-tap sampling, crossfades between two photo textures, batched rounded/bevelled blocks with screen-space photo sampling.
- **Pure logic** (`src/game.js`): no DOM, deterministic with a seed, unit-tested.
- **IndexedDB** photo library with a small EXIF reader (`src/photos.js`).
- **Web Audio** synthesized, pentatonic, quiet sounds (`src/audio.js`). Move/rotate clicks are off by default.
- No WebAssembly: the game logic is a few microseconds per frame in JS, so WASM would add a toolchain without a measurable benefit.
