import { createProgram } from '../engine.js';

// Symmetric accordion fold in X and Y about the sheet centre. Material coords -> folded 3D position, evaluated
// per-vertex; normals come from finite differences of the same function, so crumple and folds light correctly.
const VS = `
layout(location=0) in vec2 a;
uniform vec2 uP; uniform vec4 uF; uniform vec2 uC; uniform vec3 uV; uniform vec3 uS; uniform vec2 uJ;
out vec2 vM; out vec3 vN; out vec3 vE;
const float D = 4.0;
float hs(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hs(i), hs(i+vec2(1,0)), f.x), mix(hs(i+vec2(0,1)), hs(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ return vn(p) * .55 + vn(p*2.1) * .3 + vn(p*4.3) * .15; }
float ez(float x){ x = clamp(x, 0., 1.); return x*x*(3.-2.*x); }
float pr(float i, float n){ float s = (i-1.)/max(n-1., 1.) * uF.z; return ez((uF.w - s)/(1.-uF.z)); }
vec3 fx(vec3 p, float s){ float n = uF.x - 1.;
  for (int i = int(n); i >= 1; i--) { float b = float(i) * uP.x * .5 / uF.x;
    if (s > b) { float g = ((i & 1) == 1 ? 1. : -1.) * 3.14159265 * (1. - pr(float(i), n)) * .985;
      float c = cos(g), k = sin(g), d = p.x - b; p = vec3(b + d*c + p.z*k, p.y, -d*k + p.z*c); } }
  return p; }
vec3 fy(vec3 p, float s){ float n = uF.y - 1.;
  for (int i = int(n); i >= 1; i--) { float b = float(i) * uP.y * .5 / uF.y;
    if (s > b) { float g = ((i & 1) == 1 ? 1. : -1.) * 3.14159265 * (1. - pr(float(i), n)) * .985;
      float c = cos(g), k = sin(g), d = p.y - b; p = vec3(p.x, b + d*c + p.z*k, -d*k + p.z*c); } }
  return p; }
vec3 P(vec2 m){ vec2 c = m - uP*.5, s = abs(c); vec3 p = fx(fy(vec3(s, 0.), s.y), s.x);
  p.xy *= vec2(c.x < 0. ? -1. : 1., c.y < 0. ? -1. : 1.);
  p.z += uC.x * (1. - uF.w) * (fbm(m * 9.) - .5); return p; }
void main(){
  vec2 m = a * uP; vec3 p = P(m), n = vec3(0,0,1);
  #ifdef SHADOW
    float h = max(p.z + .2, 0.); p = vec3(p.xy + uS.xy*h + uJ*(.01 + .05*h), -.2);
  #else
    n = normalize(cross(P(m + vec2(uC.y, 0.)) - p, P(m + vec2(0., uC.y)) - p));
  #endif
  float t = uV.x, c = cos(t), s = sin(t); mat3 R = mat3(1,0,0, 0,c,s, 0,-s,c);
  vec3 q = R * p; vN = R * n; vE = vec3(0,0,D) - q; vM = m;
  gl_Position = vec4(q.xy * uV.yz * D, -q.z * .2, D - q.z);
}`;

const FS = `
precision highp float;
in vec2 vM; in vec3 vN; in vec3 vE;
uniform sampler2D uT; uniform vec4 uI; uniform vec3 uK; uniform float uCut; uniform float uSh;
out vec4 o;
float hs(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  #ifdef SHADOW
    o = vec4(uK * .45, uSh); return;
  #else
    vec2 q = (vM - uI.xy) / uI.zw;
    bool ins = q.x >= 0. && q.y >= 0. && q.x <= 1. && q.y <= 1.;
    vec4 t = ins ? texture(uT, vec2(q.x, 1. - q.y)) : vec4(0);
    if (uCut > .5 && t.a < .5) discard;
    vec3 n = normalize(vN), e = normalize(vE); bool fr = dot(n, e) > 0.; if (!fr) n = -n;
    vec3 paper = vec3(.97, .95, .9), base = fr ? mix(paper, t.rgb, t.a) : paper * .93;
    base *= .97 + .05 * hs(floor(vM * 900.));
    vec3 L = normalize(vec3(-.3, .5, .8));
    float d = max(dot(n, L), 0.), sp = pow(max(dot(reflect(-L, n), e), 0.), 24.) * .12;
    o = vec4(base * (.45 + .65 * d) + sp, 1.);
  #endif
}`;

const hdr = def => `#version 300 es\n${def}\nprecision highp float;\n`;
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const U = (gl, pg, n, ...v) => gl[`uniform${v.length}f`](gl.getUniformLocation(pg, n), ...v);
const LEAD = 0.4, TAIL = 1.2, ez = x => x * x * (3 - 2 * x);

export const paperUnfold = {
  id: 'paper-unfold',
  defaults: { speed: 1, crumple: 1, shadow: 0.6, tilt: 8, margin: 0.04, stagger: 0.6, foldsX: 8, foldsY: 4, cutout: false, key: '#00ff00' },
  // [key, label, min, max, step] or [key, label, [options]]; foldsX/Y must divide 80 so creases land on mesh lines.
  ui: [['speed', 'Speed', 0.5, 2, 0.05], ['crumple', 'Crumple', 0, 2, 0.05], ['shadow', 'Shadow', 0, 1, 0.05],
       ['tilt', 'Tilt', 0, 25, 1], ['margin', 'Border', 0, 0.15, 0.01], ['stagger', 'Stagger', 0, 0.9, 0.05],
       ['foldsX', 'Folds across', [2, 4, 5, 8]], ['foldsY', 'Folds down', [2, 4, 5, 8]]],
  unfoldTime: p => 3.2 / p.speed,
  duration(p) { return LEAD + this.unfoldTime(p) + TAIL; },
  init(gl) {
    return { main: createProgram(gl, hdr('') + VS, hdr('') + FS), shadow: createProgram(gl, hdr('#define SHADOW') + VS, hdr('#define SHADOW') + FS) };
  },
  render(gl, st, t, p, v) {
    const ar = v.img.w / v.img.h, iw = ar >= 1 ? 1 : ar, ih = ar >= 1 ? 1 / ar : 1, m = p.margin, W = iw + 2 * m, H = ih + 2 * m;
    const u = ez(Math.min(Math.max((t - LEAD) / this.unfoldTime(p), 0), 1)), big = Math.max(W, H);
    const px = 0.88 * Math.min(v.w / W, v.h / H), key = hex(p.key);
    const common = pg => {
      gl.useProgram(pg);
      U(gl, pg, 'uP', W, H); U(gl, pg, 'uF', p.foldsX, p.foldsY, p.stagger, u);
      U(gl, pg, 'uC', p.crumple * big * 0.04, big / 320); U(gl, pg, 'uV', p.tilt * Math.PI / 180, 2 * px / v.w, 2 * px / v.h);
      U(gl, pg, 'uK', ...key);
    };
    gl.clearColor(...key, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (p.shadow > 0) { // 5 jittered passes approximate a soft contact shadow
      common(st.shadow); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      U(gl, st.shadow, 'uS', 0.12, -0.16, 0); U(gl, st.shadow, 'uSh', p.shadow * 0.28);
      for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { U(gl, st.shadow, 'uJ', x, y); v.mesh.draw(); }
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    common(st.main); U(gl, st.main, 'uI', m, m, iw, ih); U(gl, st.main, 'uCut', p.cutout ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(st.main, 'uT'), 0);
    v.mesh.draw();
  },
};
