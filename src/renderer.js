// WebGL2 renderer: photo backdrop + batched rounded quads (blocks, panels).
// Three photo experiences, all driven by `focus` = progress through the current level (0..1):
//   focus  - the photo starts blurred and dim and sharpens as you clear lines
//   mosaic - "Blobs": the photo blooms in as soft blobs that merge, centre first, as you clear lines
//   living - a sharp photo with gentle parallax, lit from dawn to golden hour to full light

import { COLS, ROWS, VISIBLE, HIDDEN, CELLS, TYPES, CLEAR_DELAY, LOCK_DELAY } from './game.js';

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
uniform int uMode;          // 0 focus, 1 blobs, 2 living
uniform float uFocus, uSweep, uZoom, uAspect, uFill;
uniform sampler2D uField;   // blobs: summed metaball field (low-res)
uniform vec2 uPar;
// Framing: screen uv -> photo uv. uC = visible share of the photo per axis (can exceed 1, leaving bands),
// uO = centre of the view in the photo (moved toward faces), uK = full-cover scale (for the soft fill).
uniform vec2 uO0, uO1, uK0, uK1;
vec2 frame0(vec2 uv){ return (uv-0.5)*uC0 + uO0; }
vec2 frame1(vec2 uv){ return (uv-0.5)*uC1 + uO1; }
float inPhoto(vec2 p){
  vec2 e = smoothstep(vec2(-0.02), vec2(0.02), p) * smoothstep(vec2(-0.02), vec2(0.02), 1.-p);
  return e.x*e.y;
}
// Where the photo doesn't reach: its own edge colours, stretched out and very softly blurred.
vec3 fillAt(sampler2D t, vec2 uv, vec2 k, vec2 p){
  vec3 a = textureLod(t, clamp(p, 0.003, 0.997), 5.5).rgb;
  vec3 b = textureLod(t, (uv-0.5)*k + 0.5, 6.5).rgb;
  return mix(a, b, 0.45) * 0.62;
}
vec3 photo0(vec2 uv){ vec2 p = frame0(uv); return mix(fillAt(uT0, uv, uK0, p), texture(uT0, p).rgb, inPhoto(p)); }
vec3 photo1(vec2 uv){ vec2 p = frame1(uv); return mix(fillAt(uT1, uv, uK1, p), texture(uT1, p).rgb, inPhoto(p)); }

// Living: a smooth pseudo-depth (centre and lower frame read as nearer) for gentle parallax.
float depth(vec2 uv){
  float d = 1. - smoothstep(0.05, 0.8, length((uv - vec2(0.5, 0.58)) * vec2(1.0, 0.85)));
  return clamp(d * 0.8 + uv.y * 0.35, 0., 1.);
}
vec3 sharpAt(vec2 uv){
  vec3 a = vec3(0.07,0.08,0.11);
  if (uH0 > 0.5) a = photo0(uv);
  if (uMix <= 0.) return a;
  vec3 b = vec3(0.07,0.08,0.11);
  if (uH1 > 0.5) b = photo1(uv);
  return mix(a,b,uMix);
}
// Dawn (cool, dim, muted) -> golden hour (warm, glowing) -> full daylight, by level progress p.
vec3 grade(vec3 c, vec2 uv, float p){
  float dawn = 1. - smoothstep(0., 0.45, p);
  float gold = smoothstep(0.2, 0.5, p) * (1. - smoothstep(0.7, 1.0, p));
  float expo = mix(0.5, 1.0, smoothstep(0., 0.85, p));
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, mix(1.0, 0.55, dawn) + 0.12*gold);
  c *= mix(mix(vec3(1.), vec3(0.80, 0.89, 1.10), dawn), vec3(1.12, 1.0, 0.82), gold) * expo;
  vec2 sun = mix(vec2(0.1, 0.9), vec2(0.85, 0.1), smoothstep(0., 1., p));
  vec2 dv = (uv - sun) * vec2(uAspect, 1.);
  float g = exp(-dot(dv, dv) * 2.2);
  c += vec3(1.0, 0.74, 0.45) * g * (0.05 + 0.20*gold);
  return c;
}
vec3 soft(sampler2D t, vec2 uv){
  vec3 c = vec3(0.);
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
    c += textureLod(t, uv + vec2(float(i),float(j))*0.011*uBlur, min(uBlur*2.5, 2.5 + uBlur)).rgb;
  }
  return c/9.;
}
void main(){
  vec2 uv = vec2(vUv.x, 1.-vUv.y);
  vec3 base = mix(vec3(0.05,0.06,0.09), vec3(0.09,0.10,0.15), vUv.y);
  // very slow drift so the scene feels alive but never busy
  vec2 drift = vec2(sin(uTime*0.021), cos(uTime*0.017))*0.006;
  vec2 zuv = (uv-0.5)*0.97+0.5+drift;
  vec3 a = base, b = base;
  if (uH0 > 0.5) { vec2 p = frame0(zuv); a = mix(fillAt(uT0, zuv, uK0, p), soft(uT0, p), inPhoto(p)); }
  if (uH1 > 0.5 && uMix > 0.) { vec2 p = frame1(zuv); b = mix(fillAt(uT1, zuv, uK1, p), soft(uT1, p), inPhoto(p)); }
  vec3 c = mix(a,b,uMix);
  c *= 1.-uDim;
  vec2 luv = (uv-0.5)/uZoom + 0.5 + drift*0.6;
  luv += uPar * (depth(luv) - 0.45) * 0.028;
  if (uMode == 1) {
    // Blobs read as water drops: the field is treated as a surface height. Near the edge the surface
    // tilts, so the photo is refracted (magnified inward, with a faint colour fringe), the edge facing
    // the light catches a specular highlight, and a soft shadow sits just outside the drop.
    const float thr = 0.42;
    vec2 tx = 1. / vec2(textureSize(uField, 0));
    float f = texture(uField, vUv).r + uFill;
    vec2 g = vec2(texture(uField, vUv + vec2(tx.x, 0.)).r - texture(uField, vUv - vec2(tx.x, 0.)).r,
                  texture(uField, vUv + vec2(0., tx.y)).r - texture(uField, vUv - vec2(0., tx.y)).r);
    float gl = length(g);
    vec2 inward = gl > 1e-4 ? g / gl : vec2(0.);          // in vUv space (y up), toward the drop centre
    vec2 inUv = vec2(inward.x, -inward.y);                 // same direction in photo uv space (y down)
    float mask = smoothstep(thr - 0.03, thr + 0.03, f);
    float edge = 1. - smoothstep(thr, thr + 0.30, f);      // 1 at the edge, 0 deep inside the drop
    float tilt = edge * edge * mask;
    float k = 0.022 * tilt;
    vec3 ph;
    if (mask <= 0.) ph = c;
    else if (tilt < 0.01) ph = sharpAt(uv);
    else ph = vec3(sharpAt(uv + inUv * k * 1.15).r, sharpAt(uv + inUv * k).g, sharpAt(uv + inUv * k * 0.85).b);
    ph *= 1. + 0.12 * tilt;                                 // a little fresnel brightening at the rim
    float facing = max(dot(inward, normalize(vec2(0.75, -1.))), 0.);  // edge facing the top-left light
    float spec = pow(facing, 3.) * smoothstep(0.55, 1.0, edge) * mask;
    float glint = pow(facing, 12.) * exp(-pow((f - thr - 0.06) / 0.04, 2.)) * mask;
    c *= 1. - 0.35 * exp(-pow((f - thr + 0.06) / 0.06, 2.)) * (1. - mask);  // contact shadow outside
    c = mix(c, ph, mask);
    c += vec3(1.0, 0.98, 0.94) * (spec * 0.22 + glint * 0.45);
  }
  if (uMode == 2) {
    c = grade(sharpAt(luv), uv, uFocus) * (1. - uDim*0.35);
    float band = exp(-pow((uv.x*0.85 + uv.y*0.45 - (uSweep*1.9 - 0.45))*6., 2.));
    c += vec3(1.0, 0.88, 0.70) * band * 0.13 * step(0., uSweep) * (1. - uSweep*0.5);
  }
  float v = smoothstep(1.15, 0.35, length(vUv-0.5));
  c *= mix(0.55, 1.0, v);
  if (uReveal > 0.) {
    // Level-up moment: pull focus and ease from cover-fit out to the whole photo.
    float w = smoothstep(0., 0.3, uReveal);   // content: current look -> true photo
    float gz = smoothstep(0.3, 1., uReveal);  // geometry: cover -> whole frame, only once w is complete
    vec2 ruv = uMode == 2 ? mix(luv, uv, gz) : uv;
    vec2 p0 = (ruv-0.5)*mix(uC0, uF0, gz) + mix(uO0, vec2(0.5), gz);
    vec2 p1 = (ruv-0.5)*mix(uC1, uF1, gz) + mix(uO1, vec2(0.5), gz);
    vec2 e0 = smoothstep(vec2(0.), vec2(0.004), p0) * smoothstep(vec2(0.), vec2(0.004), 1.-p0);
    vec2 e1 = smoothstep(vec2(0.), vec2(0.004), p1) * smoothstep(vec2(0.), vec2(0.004), 1.-p1);
    float m0 = e0.x*e0.y*uH0, m1 = e1.x*e1.y*uH1;
    vec3 sharp = texture(uT0, p0).rgb;
    if (uMix > 0.) sharp = mix(sharp, texture(uT1, p1).rgb, uMix);
    if (uMode == 2) sharp = mix(grade(sharp, uv, 1.), sharp, gz);
    float m = mix(m0, m1, uMix);
    float band = exp(-pow((uv.x + uv.y*0.35 - (uShine*1.9 - 0.3))*5., 2.));
    sharp += band*0.10;
    if (uMode == 2) sharp += vec3(1.0, 0.8, 0.55) * 0.10 * sin(3.14159*uReveal);
    c = mix(c*(1.-0.45*w), sharp, m*w);
  }
  o = vec4(c,1.);
}`;

const Q_VS = `#version 300 es
in vec2 aPos; in vec2 aLocal; in vec2 aSize; in vec4 aColor; in vec4 aParams;
uniform vec2 uRes;
out vec2 vLocal; out vec2 vSize; out vec4 vColor; out vec4 vParams;
void main(){
  vLocal=aLocal; vSize=aSize; vColor=aColor; vParams=aParams;
  vec2 c = aPos/uRes*2.-1.;
  gl_Position = vec4(c.x, -c.y, 0., 1.);
}`;

// params: x=mode (0 solid,1 reveal background photo,2 ghost,3 panel,4 outline), y=flash, z=tint (outline: width px), w=radius(px)
const Q_FS = `#version 300 es
precision highp float;
in vec2 vLocal; in vec2 vSize; in vec4 vColor; in vec4 vParams;
out vec4 o;
uniform sampler2D uT0, uT1;
uniform vec2 uC0, uC1, uO0, uO1, uRes;
uniform float uH0, uH1, uMix;
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
  if (mode == 4) {
    float ring = aa - clamp(0.5-(d+vParams.z), 0., 1.);
    o = vec4(col*alpha*ring, alpha*ring); return;
  }
  if (mode == 2) {
    float bw = max(1.5, vSize.x*0.07);
    float inner = clamp(0.5-(d+bw), 0., 1.);
    float ring = aa-inner;
    float a2 = ring*0.85 + inner*0.10;
    o = vec4(col*a2*alpha, a2*alpha); return;
  }
  if (mode == 1) {
    vec2 suv = vec2(gl_FragCoord.x/uRes.x, 1.-gl_FragCoord.y/uRes.y);
    vec3 a = uH0>0.5 ? texture(uT0, clamp((suv-0.5)*uC0 + uO0, 0., 1.)).rgb : col;
    vec3 b = uH1>0.5 ? texture(uT1, clamp((suv-0.5)*uC1 + uO1, 0., 1.)).rgb : col;
    vec3 ph = mix(a,b,uMix);
    col = mix(ph, ph*col*1.6, vParams.z);
  }
  float edge = min(min(vLocal.x,1.-vLocal.x)*vSize.x, min(vLocal.y,1.-vLocal.y)*vSize.y);
  float rim = 1.-smoothstep(0., max(2., vSize.x*0.13), edge);
  float side = (0.5-vLocal.y) + (0.5-vLocal.x)*0.5;
  col *= 1. + rim*side*0.9;
  col *= 1. + 0.10*(0.5-vLocal.y);
  col = mix(col, vec3(1.), vParams.y);
  o = vec4(col*alpha*aa, alpha*aa);
}`;

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

const FLOATS = 14; // per vertex
const MAX_QUADS = 1500;
const MAX_BLOBS = 600;
const MAX_CROP = 0.15; // at most this share of a photo's width or height is cut off

const BLOB_VS = `#version 300 es
in vec2 aPos; in vec2 aLocal; in float aK;
uniform vec2 uRes;
out vec2 vL; out float vK;
void main(){ vL = aLocal*2.-1.; vK = aK; vec2 c = aPos/uRes*2.-1.; gl_Position = vec4(c.x, -c.y, 0., 1.); }`;
const BLOB_FS = `#version 300 es
precision highp float;
in vec2 vL; in float vK; out vec4 o;
void main(){ float d2 = dot(vL, vL); if (d2 >= 1.) discard; float f = 1.-d2; o = vec4(vec3(f*f*f*vK), 1.); }`;

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
    this.data = new Float32Array(FLOATS * 6 * MAX_QUADS);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    let off = 0;
    for (const [name, size] of [['aPos', 2], ['aLocal', 2], ['aSize', 2], ['aColor', 4], ['aParams', 4]]) {
      const l = gl.getAttribLocation(this.q.p, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, FLOATS * 4, off * 4);
      off += size;
    }
    gl.bindVertexArray(null);

    this.tex = [this.makeTex(), this.makeTex()];
    this.slots = [null, null]; // {w,h}
    this.cur = 0;
    this.mix = 0; // 0 = show cur, 1 = show other
    this.fading = false;
    this.n = 0;
    this.fade = 1;
    this.layout = null;
    this.blobs = null;
    this.field = null;
    this.par = [0, 0];
    this.sweep = -1;
  }

  /**
   * Game over: every block (and the piece that couldn't fit) bursts off the board, tumbling and
   * falling away, so the photo is left in view. Particles are created on the first game-over frame.
   */
  drawFlyaway(game, now, reduceMotion) {
    const L = this.layout, { cell, bx, by } = L;
    if (!this.fly || this.fly.game !== game) {
      const parts = [];
      const add = (x, y, type) => {
        if (y < HIDDEN - 2) return;
        const r = Math.random;
        parts.push({
          x: bx + x * cell, y: by + (y - HIDDEN) * cell, type,
          delay: Math.max(0, (y - HIDDEN)) * 22 + r() * 160,
          vx: (((x + 0.5) / COLS) - 0.5) * cell * 16 + (r() - 0.5) * cell * 9,
          vy: -cell * (8 + r() * 12),
          spin: (r() - 0.5) * 14,
        });
      };
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const c = game.board[y * COLS + x];
        if (c) add(x, y, TYPES[c - 1]);
      }
      const a = game.active;
      if (a) for (const [cx, cy] of CELLS[a.type][a.rot]) add(a.x + cx, a.y + cy, a.type);
      this.fly = { game, t0: now, parts };
    }
    const G = cell * 48;
    for (const p of this.fly.parts) {
      const t = (now - this.fly.t0 - p.delay) / 1000;
      if (reduceMotion) {
        const a = 1 - Math.min(1, Math.max(0, (now - this.fly.t0) / 600));
        if (a > 0) this.block(p.x, p.y, cell, p.type, { alpha: a });
        continue;
      }
      if (t <= 0) { this.block(p.x, p.y, cell, p.type); continue; }
      const alpha = 1 - Math.min(1, Math.max(0, (t - 0.7) / 0.7));
      if (alpha <= 0) continue;
      const x = p.x + p.vx * t, y = p.y + p.vy * t + 0.5 * G * t * t;
      const sc = 1 - 0.3 * Math.min(1, t / 1.2);
      const squash = 0.35 + 0.65 * Math.abs(Math.cos(t * p.spin)); // a cheap tumble
      const w = cell * sc * squash, h = cell * sc;
      this.block(x + (cell - w) / 2, y + (cell - h) / 2, 0, p.type, { alpha, w, h, flash: Math.max(0, 0.35 - t) });
    }
  }

  /** Living: a light sweep across the photo (called on line clears). */
  pulse() { this.sweep = 0; }

  // ---------- blobs (the "mosaic" style) ----------
  // Soft metaballs are summed into a low-res field texture; the background shader shows the sharp
  // photo wherever the field passes a threshold, so neighbouring blobs bridge and merge like liquid.

  /** A jittered grid of blob sites covering the screen, ordered centre-first with a ragged edge. */
  buildBlobs(L) {
    const minD = Math.min(L.W, L.H);
    const sp = minD * 0.115;
    const cols = Math.ceil(L.W / sp) + 1, rows = Math.ceil(L.H / sp) + 1;
    const cx = L.W / 2, cy = L.H * 0.4, Rn = Math.max(L.W, L.H) / 2;
    const list = [];
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const x = (q - 0.5 + Math.random()) * sp, y = (r - 0.5 + Math.random()) * sp;
      const dist = Math.hypot((x - cx) / Rn, ((y - cy) / Rn) * 1.15);
      const prio = dist < 0.85 && Math.random() < 0.04 ? Math.random() * 0.9 : dist + (Math.random() - 0.5) * 0.4;
      list.push({ x, y, R: sp * (1.1 + Math.random() * 0.45), phase: Math.random() * 6.283, prio, at: -1, sx: x, sy: y, dur: 1 });
    }
    list.sort((a, b) => a.prio - b.prio);
    const prev = this.blobs;
    this.blobs = { list, home: 0, W: L.W, H: L.H };
    if (prev) this.blobsAdvance(Math.round((prev.home / prev.list.length) * list.length), -1e9);
  }

  resetBlobs() { if (this.blobs) { this.blobs.home = 0; for (const b of this.blobs.list) b.at = -1; } }

  blobsAdvance(target, now) {
    const B = this.blobs;
    target = Math.min(B.list.length, target);
    for (let k = B.home; k < target; k++) {
      const b = B.list[k];
      b.at = now + (k - B.home) * 110 + Math.random() * 120;
      const fromLeft = b.x < B.W / 2;
      b.sx = fromLeft ? -b.R : B.W + b.R;
      b.sy = b.y + (Math.random() - 0.5) * B.H * 0.25;
      b.dur = 1100 + (Math.abs(b.x - b.sx) / B.W) * 1300;
    }
    B.home = Math.max(B.home, target);
  }

  ensureField(L) {
    const gl = this.gl;
    const fw = Math.max(1, Math.ceil(L.W / 4)), fh = Math.max(1, Math.ceil(L.H / 4));
    if (this.field && this.field.w === fw && this.field.h === fh) return;
    if (!this.field) {
      this.field = { tex: gl.createTexture(), fbo: gl.createFramebuffer() };
      this.blobProg = compile(gl, BLOB_VS, BLOB_FS);
      this.blobVao = gl.createVertexArray();
      gl.bindVertexArray(this.blobVao);
      this.blobBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.blobBuf);
      this.blobData = new Float32Array(MAX_BLOBS * 6 * 5);
      gl.bufferData(gl.ARRAY_BUFFER, this.blobData.byteLength, gl.DYNAMIC_DRAW);
      let off = 0;
      for (const [name, size] of [['aPos', 2], ['aLocal', 2], ['aK', 1]]) {
        const l = gl.getAttribLocation(this.blobProg.p, name);
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, 20, off * 4);
        off += size;
      }
      gl.bindVertexArray(null);
    }
    Object.assign(this.field, { w: fw, h: fh });
    gl.bindTexture(gl.TEXTURE_2D, this.field.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.field.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.field.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Render the blob field for this frame. Blobs swell in with a soft overshoot, then breathe gently. */
  drawField(now, progress, reduceMotion) {
    const gl = this.gl, L = this.layout;
    this.ensureField(L);
    if (!this.blobs || this.blobs.W !== L.W || this.blobs.H !== L.H) this.buildBlobs(L);
    // Ease in: the first lines bring only a few blobs, later lines bring progressively more,
    // so the picture is not mostly there after the first few lines.
    this.blobsAdvance(Math.floor(Math.pow(progress, 1.8) * this.blobs.list.length + 1e-6), now);
    const d = this.blobData;
    let n = 0, o = 0;
    for (let k = 0; k < this.blobs.home && n < MAX_BLOBS; k++) {
      const b = this.blobs.list[k];
      const t = reduceMotion ? 1 : (now - b.at) / b.dur;
      if (t <= 0) continue;
      // Roll in along a gentle arc, overshoot a touch, settle; the blob swells as it arrives.
      const u = Math.min(1, t) - 1;
      const e = 1 + 2.0 * u * u * u + 1.0 * u * u; // easeOutBack
      const arc = Math.sin(Math.min(1, t) * Math.PI) * b.R * 0.6;
      const breathe = reduceMotion ? 1 : 1 + 0.05 * Math.sin(now / 1100 + b.phase);
      const r = b.R * (0.65 + 0.35 * Math.min(1, t)) * breathe;
      const x = b.sx + (b.x - b.sx) * e + (reduceMotion ? 0 : Math.sin(now / 2300 + b.phase) * b.R * 0.05);
      const y = b.sy + (b.y - b.sy) * e - arc + (reduceMotion ? 0 : Math.cos(now / 2700 + b.phase) * b.R * 0.05);
      for (const [lx, ly] of [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]]) {
        d[o++] = x + (lx * 2 - 1) * r; d[o++] = y + (ly * 2 - 1) * r;
        d[o++] = lx; d[o++] = ly; d[o++] = 1;
      }
      n++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.field.fbo);
    gl.viewport(0, 0, this.field.w, this.field.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.blobProg.p);
      gl.uniform2f(this.blobProg.u.uRes, L.W, L.H);
      gl.bindVertexArray(this.blobVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.blobBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 30);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
  setPhoto(bitmap, instant = false, meta = {}) {
    const gl = this.gl;
    if (this.fading) this.finishFade();
    const next = 1 - this.cur;
    if (bitmap) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[next]);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.slots[next] = { w: bitmap.width, h: bitmap.height, id: meta.id, face: meta.face || null };
    } else {
      this.slots[next] = null;
    }
    this.resetBlobs();
    this.fading = true;
    this.mix = instant ? 1 : 0;
    if (instant) this.finishFade();
  }

  finishFade() {
    this.cur = 1 - this.cur;
    this.mix = 0;
    this.fading = false;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

  /**
   * How the photo sits on screen: { s: visible share per axis, o: view centre in photo uv }.
   * Never crops more than MAX_CROP of either dimension (bands beyond the photo get a soft fill),
   * centres on detected faces, and zooms out further if that is what it takes to keep them in view.
   */
  frame(slot) {
    const sl = this.slots[slot];
    if (!sl) return { s: [1, 1], o: [0.5, 0.5] };
    const c = this.cover(slot);
    const minC = Math.min(c[0], c[1]);
    let k = Math.max(1, (1 - MAX_CROP) / minC);
    const f = sl.face;
    if (f) k = Math.max(k, (f.w + 0.12) / c[0], (f.h + 0.16) / c[1]);
    k = Math.min(k, 1 / minC); // never smaller than the whole photo
    const s = [c[0] * k, c[1] * k];
    const want = f ? [f.x + f.w / 2, f.y + f.h * 0.45] : [0.5, 0.45];
    const o = [0, 1].map((i) => (s[i] >= 1 ? 0.5 : Math.min(1 - s[i] / 2, Math.max(s[i] / 2, want[i]))));
    // Ease toward the target so a late face detection pans gently instead of jumping.
    if (!sl.o) sl.o = o;
    const e = this.frameEase;
    sl.o = [sl.o[0] + (o[0] - sl.o[0]) * e, sl.o[1] + (o[1] - sl.o[1]) * e];
    return { s, o: sl.o };
  }

  /** A face box ({x,y,w,h} in 0..1, or null) became known for the photo with this id. */
  setFace(id, face) {
    for (const sl of this.slots) if (sl && sl.id === id) sl.face = face;
  }

  quad(x, y, w, h, color, alpha, mode, flash = 0, tint = 0, radius = 0) {
    if (this.n >= MAX_QUADS) return;
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
    }
    this.n++;
  }

  block(x, y, size, type, opts = {}) {
    const w = opts.w ?? size, h = opts.h ?? size;
    const g = Math.max(1, Math.round(Math.max(w, h) * 0.06));
    const r = Math.max(1, Math.min(w, h) * 0.14);
    this.quad(x + g / 2, y + g / 2, w - g, h - g, opts.color || COLORS[type], opts.alpha ?? 1,
      opts.mode ?? 0, opts.flash || 0, opts.tint || 0, r);
  }

  piecePreview(type, box, cy, size, alpha = 1, cx = box.x + box.w / 2) {
    if (!type) return;
    const cells = CELLS[type][0];
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pw = (maxX - minX + 1) * size, ph = (maxY - minY + 1) * size;
    const ox = cx - pw / 2, oy = cy - ph / 2;
    for (const [x, y] of cells) this.block(ox + (x - minX) * size, oy + (y - minY) * size, size, type, { alpha });
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

    const exp = game ? s.experience : 'menu';
    const focus = game ? Math.min(1, Math.max(0, v.focus || 0)) : 0;
    if (exp === 'mosaic') this.drawField(v.time, focus, s.reduceMotion);
    gl.viewport(0, 0, L.W, L.H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[t0]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[t1]);
    const U = this.bg.u;
    gl.uniform1i(U.uT0, 0); gl.uniform1i(U.uT1, 1);
    this.frameEase = Math.min(1, v.dt / 700);
    const F0 = this.frame(t0), F1 = this.frame(t1);
    this.frames = [F0, F1];
    gl.uniform2fv(U.uC0, F0.s); gl.uniform2fv(U.uC1, F1.s);
    gl.uniform2fv(U.uO0, F0.o); gl.uniform2fv(U.uO1, F1.o);
    gl.uniform2fv(U.uK0, this.cover(t0)); gl.uniform2fv(U.uK1, this.cover(t1));
    gl.uniform1f(U.uH0, s.background ? has0 : 0); gl.uniform1f(U.uH1, s.background ? has1 : 0);
    gl.uniform1f(U.uMix, this.fading ? this.mix : 0);
    // focus: 0 at the start of a level, 1 when it is nearly complete.
    let dim, blur;
    if (exp === 'mosaic') { dim = 0.72; blur = 3; }
    else if (exp === 'living') { dim = s.dim * 0.5; blur = 0; }
    else if (exp === 'focus') { dim = s.dim * (1 - 0.8 * focus); blur = s.blur * (1 - focus); }
    else { dim = s.dim * 0.6; blur = Math.min(s.blur, 0.25); }
    gl.uniform1f(U.uDim, dim);
    gl.uniform1f(U.uBlur, blur);
    gl.uniform1i(U.uMode, exp === 'mosaic' ? 1 : exp === 'living' ? 2 : 0);
    gl.uniform1f(U.uFill, (v.seal || 0) * 0.6);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.field ? this.field.tex : null);
    gl.uniform1i(U.uField, 2);
    gl.uniform1f(U.uFocus, focus);
    gl.uniform1f(U.uAspect, L.W / L.H);
    // Living: the camera eases in as the level progresses, and sways a little with the falling piece.
    let tx = 0, ty = 0;
    if (exp === 'living' && !s.reduceMotion && game.active) {
      tx = ((game.active.x + 1.5) / COLS - 0.5) * 2;
      ty = Math.sin(v.time / 5200) * 0.35;
    }
    const k = Math.min(1, v.dt / 900);
    this.par[0] += (tx - this.par[0]) * k; this.par[1] += (ty - this.par[1]) * k;
    gl.uniform2fv(U.uPar, this.par);
    gl.uniform1f(U.uZoom, 1.06 - 0.03 * focus);
    if (this.sweep >= 0) { this.sweep += v.dt / 1300; if (this.sweep > 1) this.sweep = -1; }
    gl.uniform1f(U.uSweep, exp === 'living' && !s.reduceMotion ? this.sweep : -1);
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
    const boardAlpha = s.boardOpacity * (exp === 'mosaic' ? 0.85 * (1 - 0.3 * focus) : exp === 'living' ? 1 - 0.25 * focus : 1 - 0.7 * focus);
    const br = Math.max(4, cell * 0.2);
    this.quad(bx - 3, by - 3, bw + 6, bh + 6, panel, boardAlpha, 3, 0, 0, br);
    // A clear edge, so the well stays readable over a busy photo.
    const lw = Math.max(1.5, L.dpr * 1.25);
    this.quad(bx - 3 - lw, by - 3 - lw, bw + 6 + 2 * lw, bh + 6 + 2 * lw, [0.85, 0.9, 1], exp === 'mosaic' ? 0.42 : 0.22, 4, 0, lw, br + lw);
    for (const p of [L.hold, L.next]) this.quad(p.x, p.y, p.w, p.h, panel, s.boardOpacity * 0.85, 3, 0, 0, cell * 0.25);
    // faint grid
    const gc = [1, 1, 1];
    for (let x = 1; x < COLS; x++) this.quad(bx + x * cell - 0.5, by, 1, bh, gc, 0.035, 3);
    for (let y = 1; y < VISIBLE; y++) this.quad(bx, by + y * cell - 0.5, bw, 1, gc, 0.035, 3);

    if (game && game.over) this.drawFlyaway(game, v.time, s.reduceMotion);
    else this.fly = null;
    if (game && !game.over) {
      const photoBlocks = s.blockStyle === 'reveal' && (has0 || has1);
      const clearing = game.clearing;
      const clearT = clearing ? 1 - clearing.t / CLEAR_DELAY : 0;
      for (let y = HIDDEN; y < HIDDEN + VISIBLE; y++) {
        const isClearing = clearing && clearing.rows.includes(y);
        for (let x = 0; x < COLS; x++) {
          const c = game.board[y * COLS + x];
          if (!c) continue;
          const type = TYPES[c - 1];
          const px = bx + x * cell, py = by + (y - HIDDEN) * cell;
          if (isClearing) {
            const k = s.reduceMotion ? 0.6 : Math.sin(Math.min(1, clearT) * Math.PI) * 0.85;
            this.block(px, py, cell, type, { mode: photoBlocks ? 1 : 0, tint: s.tint, flash: k, alpha: 1 - clearT * 0.7 });
          } else {
            this.block(px, py, cell, type, { mode: photoBlocks ? 1 : 0, tint: s.tint, alpha: game.over ? 0.55 : 1 });
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
        for (const [cx, cy] of cells) {
          const y = a.y + cy;
          if (y >= HIDDEN - 2) this.block(bx + (a.x + cx) * cell, by + (y - HIDDEN) * cell, cell, a.type, { flash: lockFade * 0.4 });
        }
      }
      // hold & next
      const mini = cell * 0.62;
      const nx = L.next;
      if (nx.horizontal) {
        const hm = cell * 0.5;
        this.piecePreview(game.hold, L.hold, L.hold.y + L.hold.h * 0.6, hm, game.canHold ? 1 : 0.35);
        const qn = Math.min(3, s.previews);
        const slot = (nx.w - cell * 0.6) / qn;
        for (let i = 0; i < qn; i++) {
          this.piecePreview(game.queue[i], nx, nx.y + nx.h * 0.6, i === 0 ? hm : hm * 0.85, i === 0 ? 1 : 0.8,
            nx.x + cell * 0.3 + slot * (i + 0.5));
        }
      } else {
        this.piecePreview(game.hold, L.hold, L.hold.y + L.hold.h * 0.56, mini, game.canHold ? 1 : 0.35);
        const qn = Math.min(5, s.previews);
        for (let i = 0; i < qn; i++) {
          const sz = i === 0 ? cell * 0.75 : mini * 0.92;
          const cy = nx.y + cell * 1.9 + (i === 0 ? 0 : cell * 0.9 + i * cell * 2.3);
          this.piecePreview(game.queue[i], nx, cy, sz, i === 0 ? 1 : 0.8);
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
    const [F0, F1] = this.frames || [this.frame(t0), this.frame(t1)];
    gl.uniform2fv(Q.uC0, F0.s); gl.uniform2fv(Q.uC1, F1.s);
    gl.uniform2fv(Q.uO0, F0.o); gl.uniform2fv(Q.uO1, F1.o);
    gl.uniform1f(Q.uH0, has0); gl.uniform1f(Q.uH1, has1);
    gl.uniform1f(Q.uMix, this.fading ? this.mix : 0);
    gl.bindVertexArray(this.qVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.qBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * 6 * FLOATS);
    gl.drawArrays(gl.TRIANGLES, 0, this.n * 6);
    gl.bindVertexArray(null);
  }
}
