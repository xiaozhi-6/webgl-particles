/**
 * point-figure.js — 用 Canvas2D 的观感，跑 WebGL 的开销
 *
 * 把「4 万级点云人物剪影」从 Canvas2D 的逐点 arc+fill（移动端约 18fps）
 * 换成 WebGL2 实例化四边形（移动端 60fps），并做到逐像素几乎一致。
 *
 * 用法：
 *   const fig = createPointFigure({ canvas, points, palette, radius, alpha, dpr });
 *   fig.setPoints(xyFloat32Array);   // 每帧更新位置（可选）
 *   fig.render();
 *   fig.destroy();
 *
 * 数据格式：points 是 [x0,y0, x1,y1, ...] 的 Float32Array，单位 CSS 像素。
 *
 * ── 为什么需要它（实测，43,991 点）────────────────────────────────
 *   平板 1024×1366 dpr2 : Canvas2D 57.0ms/帧(≈18fps) → WebGL 16.9ms(=60fps)
 *   手机 412×915  dpr3  : Canvas2D 53.5ms/帧(≈19fps) → WebGL 16.6ms(=60fps)
 *   瓶颈是「4.4 万次 beginPath+arc+fill 的调用开销」，不是填充率
 *   （把画布缓冲区压掉 62% 几乎不改变耗时，可佐证）。
 *
 * ── 怎么做到观感一致 ────────────────────────────────────────────
 *   1) 不用 gl_PointSize —— 它会被舍入到整数设备像素，小半径时点会明显变大。
 *      改用「实例化四边形 + 片元按距离算覆盖率」，亚像素精确。
 *   2) Canvas2D 的 alpha 会「饱和」：4.4 万次源覆盖合成在 alpha≈0.34 就把
 *      密实处推到满色，WebGL 同 alpha 只有 77%。所以要按「重叠程度」放大 alpha。
 *      修正倍数 k 由「半径 / 局部点间距」决定，实测 1.90（疏）→ 1.58（密），
 *      拟合 k ≈ 2.03 - 0.60 × (radius / pitch)。
 *
 * 详见 README.md / docs/TECHNICAL.md
 */

export function createPointFigure(opts) {
  const canvas = opts.canvas;
  const points = opts.points;
  const palette = opts.palette;              // ['#rrggbb', ...]
  const radius = opts.radius != null ? opts.radius : 2.0;   // CSS px
  const alpha = opts.alpha != null ? opts.alpha : 1.0;      // 每点基础 alpha
  const dpr = opts.dpr != null ? opts.dpr : Math.min(window.devicePixelRatio || 1, 2);
  const alphaLift = opts.alphaLift != null ? opts.alphaLift : 0.28;
  const colorLift = opts.colorLift != null ? opts.colorLift : 0.20;
  const autoDetectRadius = opts.autoDetectRadius !== false;

  const N = points.length / 2;
  const ctx = canvas.getContext('2d');
  const glCanvas = document.createElement('canvas');
  const backend = createBackend(glCanvas);

  // 每点颜色（0-255）与 alpha
  const COLOR = new Uint8Array(N * 3);
  const BASE_A = new Float32Array(N);
  const hex = palette.map(function (c) {
    return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16)];
  });

  // 每点的局部点间距：静态量，只算一次
  const PITCH = new Float32Array(N);
  let pitchReady = false;

  const gCtr = new Float32Array(N * 2);
  const gCol = new Float32Array(N * 3);
  const gRad = new Float32Array(N);
  const gAl = new Float32Array(N);

  let bw = 0, bh = 0;

  /* ---------------- 颜色与 alpha ---------------- */
  // mix: 0 = 冷色/暗，1 = 亮。可按需在动画里插值。
  function setTone(mix, globalAlpha) {
    const m = mix != null ? mix : 1;
    const ga = globalAlpha != null ? globalAlpha : alpha;
    const lit = 1 - colorLift + colorLift * m;
    const lift = 255 * (1 - m) * alphaLift;
    const aBase = (0.62 + 0.30 * m) * ga;
    for (let i = 0; i < N; i++) {
      const c = hex[palette.length === 1 ? 0 : (i % palette.length)] || hex[0];
      COLOR[i * 3] = Math.min(255, Math.round(c[0] * lit + lift));
      COLOR[i * 3 + 1] = Math.min(255, Math.round(c[1] * lit + lift));
      COLOR[i * 3 + 2] = Math.min(255, Math.round(c[2] * lit + lift));
      BASE_A[i] = aBase;
    }
  }
  // 给每个点指定色槽（当点数据自带色槽时用这个，比取模更准）
  function setPaletteIndex(paletteIdx) {
    for (let i = 0; i < N; i++) {
      const c = hex[paletteIdx[i]] || hex[0];
      COLOR[i * 3] = c[0];
      COLOR[i * 3 + 1] = c[1];
      COLOR[i * 3 + 2] = c[2];
    }
  }

  // 直接写入逐点颜色与 alpha（最强的控制方式：自己算好 RGB 和每点透明度）
  function setPointColors(rgb255, alphaArr) {
    if (rgb255) COLOR.set(rgb255.subarray(0, N * 3));
    if (alphaArr) BASE_A.set(alphaArr.subarray(0, N));
  }

  /* ---------------- 局部点间距（离线一次） ---------------- */
  function computePitch(probeFactor) {
    const K = probeFactor != null ? probeFactor : 2.5;
    const r = radius * K, r2 = r * r;
    const cell = Math.max(4, r * 0.75);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      const x = points[i * 2], y = points[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const gw = Math.max(1, Math.ceil((maxX - minX) / cell) + 3);
    const gh = Math.max(1, Math.ceil((maxY - minY) / cell) + 3);
    const ox = minX - cell, oy = minY - cell;
    const gi = (x, y) => {
      let cx = Math.floor((x - ox) / cell), cy = Math.floor((y - oy) / cell);
      if (cx < 0) cx = 0; else if (cx >= gw) cx = gw - 1;
      if (cy < 0) cy = 0; else if (cy >= gh) cy = gh - 1;
      return cy * gw + cx;
    };
    const head = new Int32Array(gw * gh).fill(-1);
    const next = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const g = gi(points[i * 2], points[i * 2 + 1]);
      next[i] = head[g]; head[g] = i;
    }
    const span = Math.ceil(r / cell);
    for (let i = 0; i < N; i++) {
      const X = points[i * 2], Y = points[i * 2 + 1];
      const g0 = gi(X, Y);
      const cx = g0 % gw, cy = (g0 - cx) / gw;
      let cnt = 0;
      for (let ax = -span; ax <= span; ax++) {
        const nx = cx + ax; if (nx < 0 || nx >= gw) continue;
        for (let ay = -span; ay <= span; ay++) {
          const ny = cy + ay; if (ny < 0 || ny >= gh) continue;
          for (let o = head[ny * gw + nx]; o !== -1; o = next[o]) {
            const dx = points[o * 2] - X, dy = points[o * 2 + 1] - Y;
            if (dx * dx + dy * dy <= r2) cnt++;
          }
        }
      }
      // 每点占面积 ≈ πr²/cnt → 等效方形间距 = sqrt(πr²/cnt)
      PITCH[i] = cnt > 1 ? Math.sqrt(Math.PI * r2 / cnt) : r;
    }
    pitchReady = true;
  }

  /* ---------------- 画布尺寸 ---------------- */
  function resize(cssW, cssH) {
    bw = Math.max(1, Math.round(cssW * dpr));
    bh = Math.max(1, Math.round(cssH * dpr));
    canvas.width = bw; canvas.height = bh;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (backend) backend.resize(bw, bh, cssW, cssH, dpr);
  }

  /* ---------------- 渲染 ---------------- */
  function render(xy) {
    if (xy) {
      if (xy.length !== N * 2) throw new Error('setPoints 长度不匹配');
      gCtr.set(xy);
    } else {
      gCtr.set(points);
    }
    if (!pitchReady) computePitch();

    // 半径自适应：点越密、半径越大时，把修正倍数往下调（实测 1.90 → 1.58）
    const kBase = 2.03, kSlope = 0.60;
    for (let i = 0; i < N; i++) {
      const p = PITCH[i] > 0 ? PITCH[i] : radius;
      let k = kBase - kSlope * (radius / p);
      if (k < 1.0) k = 1.0; else if (k > 2.4) k = 2.4;
      gRad[i] = radius;
      gCol[i * 3] = COLOR[i * 3] / 255;
      gCol[i * 3 + 1] = COLOR[i * 3 + 1] / 255;
      gCol[i * 3 + 2] = COLOR[i * 3 + 2] / 255;
      let a = BASE_A[i] * k;
      gAl[i] = a > 1 ? 1 : a;
    }

    if (backend) {
      backend.draw(gCtr, gCol, gRad, gAl, N);
      ctx.clearRect(0, 0, bw / dpr, bh / dpr);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(glCanvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return;
    }
    // 回退：Canvas2D
    const W = bw / dpr, H = bh / dpr;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < N; i++) {
      ctx.beginPath();
      ctx.arc(gCtr[i * 2], gCtr[i * 2 + 1], radius, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + COLOR[i * 3] + ',' + COLOR[i * 3 + 1] + ',' + COLOR[i * 3 + 2] +
        ',' + gAl[i].toFixed(3) + ')';
      ctx.fill();
    }
  }

  function destroy() {
    if (backend && backend.destroy) backend.destroy();
  }

  function isWebGL() { return !!backend; }

  return {
    resize: resize,
    render: render,
    setTone: setTone,
    setPaletteIndex: setPaletteIndex,
    setPointColors: setPointColors,
    computePitch: computePitch,
    isWebGL: isWebGL,
    destroy: destroy,
    count: N
  };
}

/* ==================================================================
   WebGL2 实例化四边形后端
   ================================================================== */
function createBackend(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: false, antialias: false,
    depth: false, stencil: false, powerPreference: 'high-performance'
  });
  if (!gl) return null;

  const VS = [
    '#version 300 es',
    'in vec2 a_corner;',
    'in vec2 a_center;',
    'in vec3 a_col;',
    'in float a_rad;',
    'in float a_al;',
    'uniform vec2 u_res;',
    'out vec3 v_col;',
    'out vec2 v_local;',
    'out float v_rad;',
    'out float v_al;',
    'void main() {',
    '  vec2 pos = a_center + a_corner * a_rad;',
    '  vec2 p = pos / u_res * 2.0 - 1.0;',
    '  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);',
    '  v_local = a_corner;',
    '  v_rad = a_rad;',
    '  v_col = a_col;',
    '  v_al = a_al;',
    '}'
  ].join('\n');

  const FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_col;',
    'in vec2 v_local;',
    'in float v_rad;',
    'in float v_al;',
    'uniform float u_dpr;',
    'out vec4 outColor;',
    'void main() {',
    // 到圆心的距离（CSS px）
    '  float dist = length(v_local) * v_rad;',
    // 半个设备像素的过渡带 → 亚像素精确的圆形边缘
    '  float aa = 0.5 / u_dpr;',
    '  float cov = clamp((v_rad - dist) / (2.0 * aa) + 0.5, 0.0, 1.0);',
    '  if (cov <= 0.0) discard;',
    '  outColor = vec4(v_col, cov * v_al);',
    '}'
  ].join('\n');

  function sh(type, src) {
    const o = gl.createShader(type);
    gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
      if (typeof console !== 'undefined') console.warn('[point-figure] shader:', gl.getShaderInfoLog(o));
      return null;
    }
    return o;
  }
  const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
  if (!v || !f) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // 单位四边形角点：所有实例共享（不设 divisor）
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const locCorner = gl.getAttribLocation(prog, 'a_corner');
  gl.enableVertexAttribArray(locCorner);
  gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, 0, 0);

  const specs = [['a_center', 2], ['a_col', 3], ['a_rad', 1], ['a_al', 1]];
  const bufs = {}, locs = {};
  for (let i = 0; i < specs.length; i++) {
    const name = specs[i][0];
    bufs[name] = gl.createBuffer();
    locs[name] = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(locs[name]);
    gl.vertexAttribDivisor(locs[name], 1);
  }

  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uDpr = gl.getUniformLocation(prog, 'u_dpr');

  gl.enable(gl.BLEND);
  // 与 Canvas2D 的 source-over 对齐（含 alpha 通道的正确合成）
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  return {
    resize: function (bw, bh, cssW, cssH, dpr) {
      canvas.width = bw; canvas.height = bh;
      gl.viewport(0, 0, bw, bh);
      gl.useProgram(prog);
      gl.uniform2f(uRes, cssW, cssH);
      gl.uniform1f(uDpr, dpr);
    },
    draw: function (ctr, col, rad, al, count) {
      const arrs = [ctr, col, rad, al];
      gl.useProgram(prog);
      for (let i = 0; i < specs.length; i++) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs[specs[i][0]]);
        gl.bufferData(gl.ARRAY_BUFFER, arrs[i], gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(locs[specs[i][0]], specs[i][1], gl.FLOAT, false, 0, 0);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    },
    destroy: function () {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  };
}
