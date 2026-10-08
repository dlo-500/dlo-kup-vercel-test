// Shared engine: GL helpers, renderer, image ingest, video export. Effects plug in via {init, render, duration, ui, defaults}.
const MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.mjs';
const tick = () => new Promise(r => setTimeout(r));

export function createProgram(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  return p;
}

export function gridMesh(gl, n) { // (n+1)^2 vertices with uv in [0,1], attribute location 0
  const v = new Float32Array((n + 1) ** 2 * 2), idx = new Uint32Array(n * n * 6);
  for (let j = 0, k = 0; j <= n; j++) for (let i = 0; i <= n; i++) { v[k++] = i / n; v[k++] = j / n; }
  for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.set([a, b, c, b, d, c], k); k += 6;
  }
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return { vao, count: idx.length, draw: () => { gl.bindVertexArray(vao); gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0); } };
}

export async function loadImage(file, max = 2048) { // EXIF-aware, downscaled, straight alpha
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close();
  return { source: c, w, h };
}

export class Renderer {
  constructor(canvas) {
    this.c = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw Error('WebGL2 is not available in this browser.');
    this.mesh = gridMesh(gl, 160); this.tex = gl.createTexture();
  }
  setEffect(fx) { this.fx = fx; this.st = fx.init(this.gl); }
  setImage(img) {
    const gl = this.gl; this.img = img;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  resize(w, h) { this.c.width = w; this.c.height = h; }
  render(t, p) {
    if (!this.img || !this.fx) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.c.width, this.c.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    this.fx.render(gl, this.st, t, p, { w: this.c.width, h: this.c.height, img: this.img, mesh: this.mesh });
  }
}

async function pickConfig(w, h, fps) {
  const bitrate = Math.round(w * h * fps * 0.18);
  for (const codec of ['avc1.640033', 'avc1.64002A', 'avc1.4d002a', 'avc1.42001f']) {
    const cfg = { codec, width: w, height: h, framerate: fps, bitrate, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
  }
  throw Error('No supported H.264 encoder at this size. Try a smaller preset.');
}

function recordRealtime(r, p, fps, n, onProgress) { // fallback when WebCodecs is missing
  return new Promise(res => {
    const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(r.c.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 12e6 }), ch = [];
    rec.ondataavailable = e => ch.push(e.data);
    rec.onstop = () => res(new Blob(ch, { type: mime.split(';')[0] }));
    rec.start(); const t0 = performance.now();
    (function loop() {
      const f = (performance.now() - t0) / 1000 * fps;
      r.render(Math.min(f, n) / fps, p); onProgress(Math.min(f / n, 1));
      f < n ? requestAnimationFrame(loop) : rec.stop();
    })();
  });
}

// Offline, deterministic export: frame i is rendered at t = i/fps, independent of device speed.
export async function exportVideo(r, p, { fps = 30, w, h, onProgress = () => {}, signal } = {}) {
  const n = Math.ceil(r.fx.duration(p) * fps), prev = [r.c.width, r.c.height];
  w &= ~1; h &= ~1; r.resize(w, h);
  try {
    if (!('VideoEncoder' in window)) return await recordRealtime(r, p, fps, n, onProgress);
    const { Muxer, ArrayBufferTarget } = await import(MUXER);
    const cfg = await pickConfig(w, h, fps), target = new ArrayBufferTarget();
    const mux = new Muxer({ target, video: { codec: 'avc', width: w, height: h }, fastStart: 'in-memory' });
    let err; const enc = new VideoEncoder({ output: (c, m) => mux.addVideoChunk(c, m), error: e => (err = e) });
    enc.configure(cfg);
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (err) throw err;
      r.render(i / fps, p);
      const f = new VideoFrame(r.c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(f, { keyFrame: i % (fps * 2) === 0 }); f.close();
      while (enc.encodeQueueSize > 6) await tick();
      if (i % 4 === 0) { onProgress(i / n); await tick(); }
    }
    await enc.flush(); if (err) throw err; mux.finalize();
    onProgress(1); return new Blob([target.buffer], { type: 'video/mp4' });
  } finally { r.resize(...prev); }
}
