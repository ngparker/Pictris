// WebGL2 renderer: blurred photo backdrop + instanced-style batched rounded blocks.
// Locked blocks in "photo" style act as windows onto the sharp photo behind the board.

import { COLS, VISIBLE, HIDDEN, CELLS, TYPES, CLEAR_DELAY, LOCK_DELAY, extent } from './game.js';

export const PIECE_LAYERS = 48;
const PIECE_TEX = 256;

export const COLORS = {
  I: [0.42, 0.80, 0.86], J: [0.40, 0.52, 0.86], L: [0.91, 0.62, 0.34], O: [0.92, 0.82, 0.40],
  S: [0.45, 0.77, 0.52], T: [0.66, 0.50, 0.85], Z: [0.88, 0.44, 0.46],
};

const BG_VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uT0, uT1;
uniform vec2 uC0, uC1;
uniform float uH0, uH1, uMix, uDim, uBlur, uTime, uReveal, uShine;
uniform vec2 uF0, uF1;
vec2 cover(vec2 uv, vec2 s){ return (uv-0.5)*s+0.5; }
vec3 soft(sampler2D t, vec2 uv){
  vec3 c = vec3(0.);
  for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++){
    c += textureLod(t, uv + vec2(float(i),float(j))*0.006*uBlur, min(uBlur*2.5, 2.0 + uBlur)).rgb;
  }
  return c/25.;
}
void main(){
  vec2 uv = vec2(vUv.x, 1.-vUv.y);
  vec3 base = mix(vec3(0.05,0.06,0.09), vec3(0.09,0.10,0.15), vUv.y);
  // very slow drift so the scene feels alive but never busy
  vec2 drift = vec2(sin(uTime*0.021), cos(uTime*0.017))*0.006;
  vec2 zuv = (uv-0.5)*0.97+0.5+drift;
  vec3 a = uH0>0.5 ? soft(uT0, cover(zuv,uC0)) : base;
  vec3 b = uH1>0.5 ? soft(uT1, cover(zuv,uC1)) : base;
  vec3 c = mix(a,b,uMix);
  c *= 1.-uDim;
  float v = smoothstep(1.15, 0.35, length(vUv-0.5));
  c *= mix(0.55, 1.0, v);
  if (uReveal > 0.) {
    // Level-up moment: pull focus and ease from cover-fit out to the whole photo.
    vec2 p0 = cover(uv, mix(uC0, uF0, uReveal)), p1 = cover(uv, mix(uC1, uF1, uReveal));
    vec2 e0 = smoothstep(vec2(0.), vec2(0.004), p0) * smoothstep(vec2(0.), vec2(0.004), 1.-p0);
    vec2 e1 = smoothstep(vec2(0.), vec2(0.004), p1) * smoothstep(vec2(0.), vec2(0.004), 1.-p1);
    float m0 = e0.x*e0.y*uH0, m1 = e1.x*e1.y*uH1;
    vec3 sharp = mix(texture(uT0, p0).rgb, texture(uT1, p1).rgb, uMix);
    float m = mix(m0, m1, uMix);
    float band = exp(-pow((uv.x + uv.y*0.35 - (uShine*1.9 - 0.3))*5., 2.));
    sharp += band*0.10;
    c = mix(c*(1.-0.45*uReveal), sharp, m*uReveal);
  }
  o = vec4(c,1.);
}`;

const Q_VS = `#version 300 es
in vec2 aPos; in vec2 aLocal; in vec2 aSize; in vec4 aColor; in vec4 aParams; in vec4 aUv; in float aLayer;
uniform vec2 uRes;
out vec2 vLocal; out vec2 vSize; out vec4 vColor; out vec4 vParams; out vec4 vUv; flat out float vLayer;
void main(){
  vLocal=aLocal; vSize=aSize; vColor=aColor; vParams=aParams; vUv=aUv; vLayer=aLayer;
  vec2 c = aPos/uRes*2.-1.;
  gl_Position = vec4(c.x, -c.y, 0., 1.);
}`;

// params: x=mode (0 solid,1 reveal background photo,2 ghost,3 panel,4 piece photo), y=flash, z=tint, w=radius(px)
const Q_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vLocal; in vec2 vSize; in vec4 vColor; in vec4 vParams; in vec4 vUv; flat in float vLayer;
out vec4 o;
uniform sampler2D uT0, uT1;
uniform sampler2DArray uArr;
uniform vec2 uC0, uC1, uRes;
uniform float uH0, uH1, uMix;
vec2 cover(vec2 uv, vec2 s){ return (uv-0.5)*s+0.5; }
void main(){
  int mode = int(vParams.x+0.5);
  float r = vParams.w;
  vec2 p = (vLocal-0.5)*vSize;
  vec2 q = abs(p)-(vSize*0.5-r);
  float d = length(max(q,0.))+min(max(q.x,q.y),0.)-r;
  float aa = clamp(0.5-d, 0., 1.);
  if (aa <= 0.) discard;
  vec3 col = vColor.rgb;
  float alpha = vColor.a;
  if (mode == 3) { o = vec4(col*alpha*aa, alpha*aa); return; }
  if (mode == 2) {
    float bw = max(1.5, vSize.x*0.07);
    float inner = clamp(0.5-(d+bw), 0., 1.);
    float ring = aa-inner;
    float a2 = ring*0.85 + inner*0.10;
    o = vec4(col*a2*alpha, a2*alpha); return;
  }
  if (mode == 1) {
    vec2 suv = vec2(gl_FragCoord.x/uRes.x, 1.-gl_FragCoord.y/uRes.y);
    vec3 a = uH0>0.5 ? texture(uT0, cover(suv,uC0)).rgb : col;
    vec3 b = uH1>0.5 ? texture(uT1, cover(suv,uC1)).rgb : col;
    vec3 ph = mix(a,b,uMix);
    col = mix(ph, ph*col*1.6, vParams.z);
  }
  if (mode == 4) {
    vec3 ph = texture(uArr, vec3(mix(vUv.xy, vUv.zw, vLocal), vLayer)).rgb;
    ph = mix(ph, ph*col*1.6, vParams.z*0.6);
    float fw = max(1.5, vSize.x*0.075);
    float edge0 = min(min(vLocal.x,1.-vLocal.x)*vSize.x, min(vLocal.y,1.-vLocal.y)*vSize.y);
    float frame = 1.-smoothstep(fw-1., fw, edge0);
    col = mix(ph, col, frame*0.9);
  }
  float edge = min(min(vLocal.x,1.-vLocal.x)*vSize.x, min(vLocal.y,1.-vLocal.y)*vSize.y);
  float rim = 1.-smoothstep(0., max(2., vSize.x*0.13), edge);
  float side = (0.5-vLocal.y) + (0.5-vLocal.x)*0.5;
  col *= 1. + rim*side*0.9;
  col *= 1. + 0.10*(0.5-vLocal.y);
  col = mix(col, vec3(1.), vParams.y);
  o = vec4(col*alpha*aa, alpha*aa);
}`;

const NO_UV = [0, 0, 1, 1];

/** Pack each cell's position within the piece's extent (same encoding as Game.ext). */
function packExtents(cells) {
  const e = extent(cells);
  return cells.map(([x, y]) => (x - e.x) | ((y - e.y) << 2) | ((e.w - 1) << 4) | ((e.h - 1) << 6));
}

/** UV rect of one cell: the piece's extent is cover-fitted into the square photo, then sliced. */
function cellUv(ext) {
  const ex = ext & 3, ey = (ext >> 2) & 3, w = ((ext >> 4) & 3) + 1, h = ((ext >> 6) & 3) + 1;
  const a = w / h;
  let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
  if (a >= 1) { v0 = 0.5 - 0.5 / a; v1 = 0.5 + 0.5 / a; } else { u0 = 0.5 - a / 2; u1 = 0.5 + a / 2; }
  const du = (u1 - u0) / w, dv = (v1 - v0) / h;
  return [u0 + ex * du, v0 + ey * dv, u0 + (ex + 1) * du, v0 + (ey + 1) * dv];
}

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

const FLOATS = 19; // per vertex

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.bg = compile(gl, BG_VS, BG_FS);
    this.q = compile(gl, Q_VS, Q_FS);

    this.bgVao = gl.createVertexArray();
    gl.bindVertexArray(this.bgVao);
    const bgBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.bg.p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.qVao = gl.createVertexArray();
    gl.bindVertexArray(this.qVao);
    this.qBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.qBuf);
    this.data = new Float32Array(FLOATS * 6 * 1200);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    let off = 0;
    for (const [name, size] of [['aPos', 2], ['aLocal', 2], ['aSize', 2], ['aColor', 4], ['aParams', 4], ['aUv', 4], ['aLayer', 1]]) {
      const l = gl.getAttribLocation(this.q.p, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, FLOATS * 4, off * 4);
      off += size;
    }
    gl.bindVertexArray(null);

    this.tex = [this.makeTex(), this.makeTex()];
    this.arr = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arr);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.log2(PIECE_TEX) + 1, gl.RGBA8, PIECE_TEX, PIECE_TEX, PIECE_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.square = document.createElement('canvas');
    this.square.width = this.square.height = PIECE_TEX;
    this.slots = [null, null]; // {w,h}
    this.cur = 0;
    this.mix = 0; // 0 = show cur, 1 = show other
    this.fading = false;
    this.n = 0;
    this.fade = 1;
    this.layout = null;
  }

  makeTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Crossfade to a new ImageBitmap (or null for no photo). */
  setPhoto(bitmap, instant = false) {
    const gl = this.gl;
    if (this.fading) this.finishFade();
    const next = 1 - this.cur;
    if (bitmap) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[next]);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.slots[next] = { w: bitmap.width, h: bitmap.height };
    } else {
      this.slots[next] = null;
    }
    this.fading = true;
    this.mix = instant ? 1 : 0;
    if (instant) this.finishFade();
  }

  /** Upload a center-cropped square of `bitmap` into piece-photo layer `layer`. */
  setPieceLayer(layer, bitmap) {
    const gl = this.gl;
    const c = this.square.getContext('2d');
    const side = Math.min(bitmap.width, bitmap.height);
    // Bias the crop slightly upward: faces tend to sit above center.
    const sx = (bitmap.width - side) / 2, sy = Math.max(0, (bitmap.height - side) * 0.35);
    c.imageSmoothingQuality = 'high';
    c.drawImage(bitmap, sx, sy, side, side, 0, 0, PIECE_TEX, PIECE_TEX);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arr);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, PIECE_TEX, PIECE_TEX, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.square);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  finishFade() {
    this.cur = 1 - this.cur;
    this.mix = 0;
    this.fading = false;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.dpr = dpr;
    const W = w, H = h;
    const portrait = W / H < 0.8;
    if (portrait) {
      // Phone: hold + next in a bar above the board, stats in a row below.
      const m = Math.round(Math.min(W, H) * 0.03);
      const cell = Math.floor(Math.min((W - 2 * m) / COLS, (H - 2 * m - 6 * dpr) / (VISIBLE + 3.4 + 1.8)));
      const bw = cell * COLS, bh = cell * VISIBLE;
      const bx = Math.round((W - bw) / 2);
      const top = Math.round((H - (bh + cell * 5.2)) / 2);
      const by = top + Math.round(cell * 3.4);
      const barH = Math.round(cell * 3.0);
      const holdW = Math.round(cell * 3.6);
      this.layout = {
        W, H, cell, bx, by, bw, bh, dpr, portrait,
        hold: { x: bx, y: top, w: holdW, h: barH },
        next: { x: bx + holdW + Math.round(cell * 0.4), y: top, w: bw - holdW - Math.round(cell * 0.4), h: barH, horizontal: true },
        stats: { x: bx, y: by + bh + Math.round(cell * 0.4), w: bw },
      };
      return this.layout;
    }
    const side = 4.6;
    const cell = Math.floor(Math.min((H * 0.9) / VISIBLE, W / (COLS + 2 * side + 1.2)));
    const bw = cell * COLS, bh = cell * VISIBLE;
    const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2 + cell * 0.3);
    const pw = Math.round(cell * (side - 0.6));
    this.layout = {
      W, H, cell, bx, by, bw, bh, dpr, portrait,
      hold: { x: bx - pw - Math.round(cell * 0.5), y: by, w: pw, h: Math.round(cell * 3.2) },
      next: { x: bx + bw + Math.round(cell * 0.5), y: by, w: pw, h: Math.round(cell * 13.2) },
    };
    this.layout.stats = { x: this.layout.hold.x, y: by + this.layout.hold.h + Math.round(cell * 0.8), w: pw };
    return this.layout;
  }

  /** Scale that shows the whole photo with a small margin. */
  fit(slot) {
    const c = this.cover(slot);
    const m = Math.min(c[0], c[1]) * 0.94;
    return [c[0] / m, c[1] / m];
  }

  cover(slot) {
    const s = this.slots[slot];
    if (!s) return [1, 1];
    const A = this.layout.W / this.layout.H, I = s.w / s.h;
    return I > A ? [A / I, 1] : [1, I / A];
  }

  quad(x, y, w, h, color, alpha, mode, flash = 0, tint = 0, radius = 0, uv = NO_UV, layer = 0) {
    if (this.n >= 1200) return;
    alpha *= this.fade;
    const d = this.data;
    let o = this.n * 6 * FLOATS;
    const corners = [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]];
    for (const [lx, ly] of corners) {
      d[o++] = x + lx * w; d[o++] = y + ly * h;
      d[o++] = lx; d[o++] = ly;
      d[o++] = w; d[o++] = h;
      d[o++] = color[0]; d[o++] = color[1]; d[o++] = color[2]; d[o++] = alpha;
      d[o++] = mode; d[o++] = flash; d[o++] = tint; d[o++] = radius;
      d[o++] = uv[0]; d[o++] = uv[1]; d[o++] = uv[2]; d[o++] = uv[3]; d[o++] = layer;
    }
    this.n++;
  }

  block(x, y, size, type, opts = {}) {
    const g = Math.max(1, Math.round(size * 0.06));
    const r = Math.max(1, size * 0.14);
    let mode = opts.mode ?? 0, uv = NO_UV;
    if (opts.tag != null && opts.tag >= 0 && opts.ext != null) { mode = 4; uv = cellUv(opts.ext); }
    this.quad(x + g / 2, y + g / 2, size - g, size - g, opts.color || COLORS[type], opts.alpha ?? 1,
      mode, opts.flash || 0, opts.tint || 0, r, uv, Math.max(0, opts.tag ?? 0));
  }

  piecePreview(type, box, cy, size, alpha = 1, cx = box.x + box.w / 2, tag = -1, tint = 0) {
    if (!type) return;
    const cells = CELLS[type][0];
    const ext = packExtents(cells);
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pw = (maxX - minX + 1) * size, ph = (maxY - minY + 1) * size;
    const ox = cx - pw / 2, oy = cy - ph / 2;
    cells.forEach(([x, y], i) => this.block(ox + (x - minX) * size, oy + (y - minY) * size, size, type, { alpha, tag, ext: ext[i], tint }));
  }

  /**
   * @param {object} v view: { game, time, dt, settings, hasPhoto, flashRows }
   */
  render(v) {
    const gl = this.gl;
    const L = this.layout || this.resize();
    const { game, settings: s } = v;
    if (this.fading) {
      this.mix += v.dt / 1600;
      if (this.mix >= 1) this.finishFade();
    }
    const t0 = this.cur, t1 = 1 - this.cur;
    const has0 = this.slots[t0] ? 1 : 0, has1 = this.slots[t1] ? 1 : 0;

    gl.viewport(0, 0, L.W, L.H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[t0]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[t1]);
    const U = this.bg.u;
    gl.uniform1i(U.uT0, 0); gl.uniform1i(U.uT1, 1);
    gl.uniform2fv(U.uC0, this.cover(t0)); gl.uniform2fv(U.uC1, this.cover(t1));
    gl.uniform1f(U.uH0, s.background ? has0 : 0); gl.uniform1f(U.uH1, s.background ? has1 : 0);
    gl.uniform1f(U.uMix, this.fading ? this.mix : 0);
    // focus: 0 at the start of a level, 1 when it is nearly complete. The photo sharpens and brightens with it.
    const focus = game ? Math.min(1, Math.max(0, v.focus || 0)) : 0;
    gl.uniform1f(U.uDim, game ? s.dim * (1 - 0.8 * focus) : s.dim * 0.6);
    gl.uniform1f(U.uBlur, game ? s.blur * (1 - focus) : Math.min(s.blur, 0.25));
    gl.uniform1f(U.uTime, s.reduceMotion ? 0 : v.time / 1000);
    const reveal = v.reveal || 0;
    this.fade = 1 - reveal;
    gl.uniform1f(U.uReveal, reveal);
    gl.uniform1f(U.uShine, s.reduceMotion ? -1 : v.shine || 0);
    gl.uniform2fv(U.uF0, this.fit(t0)); gl.uniform2fv(U.uF1, this.fit(t1));
    gl.bindVertexArray(this.bgVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ---- quads ----
    this.n = 0;
    const { cell, bx, by, bw, bh } = L;
    if (!game) return this.flush(has0, has1, t0, t1);
    const panel = [0.02, 0.025, 0.04];
    this.quad(bx - 3, by - 3, bw + 6, bh + 6, panel, s.boardOpacity * (1 - 0.7 * focus), 3, 0, 0, Math.max(4, cell * 0.2));
    for (const p of [L.hold, L.next]) this.quad(p.x, p.y, p.w, p.h, panel, s.boardOpacity * 0.85, 3, 0, 0, cell * 0.25);
    // faint grid
    const gc = [1, 1, 1];
    for (let x = 1; x < COLS; x++) this.quad(bx + x * cell - 0.5, by, 1, bh, gc, 0.035, 3);
    for (let y = 1; y < VISIBLE; y++) this.quad(bx, by + y * cell - 0.5, bw, 1, gc, 0.035, 3);

    if (game) {
      const photoBlocks = s.blockStyle === 'reveal' && (has0 || has1);
      const piecePhotos = s.blockStyle === 'pieces';
      const clearing = game.clearing;
      const clearT = clearing ? 1 - clearing.t / CLEAR_DELAY : 0;
      for (let y = HIDDEN; y < HIDDEN + VISIBLE; y++) {
        const isClearing = clearing && clearing.rows.includes(y);
        for (let x = 0; x < COLS; x++) {
          const c = game.board[y * COLS + x];
          if (!c) continue;
          const type = TYPES[c - 1];
          const px = bx + x * cell, py = by + (y - HIDDEN) * cell;
          const i = y * COLS + x;
          const tag = piecePhotos ? game.tags[i] : -1, ext = game.ext[i];
          if (isClearing) {
            const k = s.reduceMotion ? 0.6 : Math.sin(Math.min(1, clearT) * Math.PI) * 0.85;
            this.block(px, py, cell, type, { mode: photoBlocks ? 1 : 0, tint: s.tint, flash: k, alpha: 1 - clearT * 0.7, tag, ext });
          } else {
            this.block(px, py, cell, type, { mode: photoBlocks ? 1 : 0, tint: s.tint, alpha: game.over ? 0.55 : 1, tag, ext });
          }
        }
      }
      const a = game.active;
      if (a && !game.over) {
        const cells = CELLS[a.type][a.rot];
        if (s.ghost) {
          const gy = a.y + game.dropDistance();
          for (const [cx, cy] of cells) {
            const y = gy + cy;
            if (y >= HIDDEN) this.block(bx + (a.x + cx) * cell, by + (y - HIDDEN) * cell, cell, a.type, { mode: 2, alpha: 0.7 });
          }
        }
        const lockFade = game.lockTimer > 0 ? Math.min(1, game.lockTimer / LOCK_DELAY) * 0.25 : 0;
        const ext = packExtents(cells);
        const tag = piecePhotos ? a.tag : -1;
        cells.forEach(([cx, cy], i) => {
          const y = a.y + cy;
          if (y >= HIDDEN - 2) this.block(bx + (a.x + cx) * cell, by + (y - HIDDEN) * cell, cell, a.type, { flash: lockFade * 0.4, tag, ext: ext[i], tint: s.tint });
        });
      }
      // hold & next
      const mini = cell * 0.62;
      const nx = L.next;
      const pt = (t) => (piecePhotos ? t : -1);
      if (nx.horizontal) {
        const hm = cell * 0.5;
        this.piecePreview(game.hold, L.hold, L.hold.y + L.hold.h * 0.6, hm, game.canHold ? 1 : 0.35, undefined, pt(game.holdTag), s.tint);
        const qn = Math.min(3, s.previews);
        const slot = (nx.w - cell * 0.6) / qn;
        for (let i = 0; i < qn; i++) {
          this.piecePreview(game.queue[i], nx, nx.y + nx.h * 0.6, i === 0 ? hm : hm * 0.85, i === 0 ? 1 : 0.8,
            nx.x + cell * 0.3 + slot * (i + 0.5), pt(game.queueTags[i]), s.tint);
        }
      } else {
        this.piecePreview(game.hold, L.hold, L.hold.y + L.hold.h * 0.56, mini, game.canHold ? 1 : 0.35, undefined, pt(game.holdTag), s.tint);
        const qn = Math.min(5, s.previews);
        for (let i = 0; i < qn; i++) {
          const sz = i === 0 ? cell * 0.75 : mini * 0.92;
          const cy = nx.y + cell * 1.9 + (i === 0 ? 0 : cell * 0.9 + i * cell * 2.3);
          this.piecePreview(game.queue[i], nx, cy, sz, i === 0 ? 1 : 0.8, undefined, pt(game.queueTags[i]), s.tint);
        }
      }
    }
    this.flush(has0, has1, t0, t1);
  }

  flush(has0, has1, t0, t1) {
    const gl = this.gl, L = this.layout;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.q.p);
    const Q = this.q.u;
    gl.uniform2f(Q.uRes, L.W, L.H);
    gl.uniform1i(Q.uT0, 0); gl.uniform1i(Q.uT1, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arr);
    gl.uniform1i(Q.uArr, 2);
    gl.uniform2fv(Q.uC0, this.cover(t0)); gl.uniform2fv(Q.uC1, this.cover(t1));
    gl.uniform1f(Q.uH0, has0); gl.uniform1f(Q.uH1, has1);
    gl.uniform1f(Q.uMix, this.fading ? this.mix : 0);
    gl.bindVertexArray(this.qVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.qBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * 6 * FLOATS);
    gl.drawArrays(gl.TRIANGLES, 0, this.n * 6);
    gl.bindVertexArray(null);
  }
}
