<div align="center">
  <h1>point-figure</h1>
  <p><b>Canvas2D looks, WebGL cost</b></p>
  <p>Rendering a 100k-point silhouette figure with instanced quads instead of<br>
     per-point <code>arc+fill</code> — <b>~18fps → 60fps</b> on mobile, nearly pixel-identical.</p>
</div>

<div align="center">

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000.svg)](https://www.khronos.org/webgl/)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#-install)
[![Demo](https://img.shields.io/badge/Demo-open-blue.svg)](demo/index.html)

**[中文](README.md) | English**

</div>

---

## 🔥 What is this

A ~400-line, zero-dependency ES module solving a very specific problem:

> Drawing a silhouette made of **40k–100k independent translucent dots** with Canvas2D
> runs fine on desktop, but **drops to ~18fps on phones and tablets**.

The obvious fixes are wrong. Measured on 43,991 real points:

| Attempt | Result |
|---|---|
| Shrink the canvas backing store to 2.1 Mpx (−62%) | **No change** in render time ❌ |
| Batch into a single `Path2D` fill | 2.8× faster, but **visible speckle where dots overlap** ❌ |
| Pre-rendered sprite via `drawImage` | **Slower** (116 ms) ❌ |
| **WebGL2 instanced quads** | **47× faster** ✅ |

**The bottleneck was never fill rate — it's the fixed cost of 43,991 `beginPath` + `arc` + `fill`
calls** (≈1.08 µs per point).

## 📊 Results

Measured on a real 43,991-point figure (figure-layer rAF interval while scrolling, mobile):

| Device | Canvas2D | **This library (WebGL2)** |
|---|---|---|
| Tablet 1024×1366 dpr2 | 57.0 ms/frame (≈18fps) | **16.9 ms/frame (=60fps)** |
| Phone 412×915 dpr3 | 53.5 ms/frame (≈19fps) | **16.6 ms/frame (=60fps)** |
| Desktop 1440×900 dpr1 | already smooth | already smooth |

**Image fidelity** (per-pixel diff against Canvas2D):

| State | Luminance ratio | Mean abs diff | Pixels differing >40 |
|---|---|---|---|
| Dense / gathered | **0.9991** | **1.12 / 255** | **0.28%** |
| In-transition | 1.08 ~ 1.23 | 68 ~ 75 | 59% ~ 71% |

> Dense state (static view) is essentially identical. During fast scroll transitions the WebGL
> path is 8–23% brighter; on real devices the difference is very subtle.
> This is the current **known limitation** — see [TECHNICAL.md](docs/TECHNICAL.md).

## 🚀 Install

**Zero dependencies, zero build step.** Copy `src/point-figure.js` into your project:

```html
<canvas id="figure"></canvas>
<script type="module">
import { createPointFigure } from './src/point-figure.js';

const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: new Float32Array([/* x0,y0, x1,y1, ... */]),  // CSS pixels
  palette: ['#463c5e', '#6b5f90', '#9c92c4', '#c8e8ff'],
  radius: 2.0,        // per-dot radius (CSS px)
  alpha: 0.34,        // per-dot base alpha
  dpr: 2
});

figure.resize(1200, 800);
figure.setPointColors(rgb255, alphaPerPoint);   // optional per-point color/alpha
figure.render();
</script>
```

Browsers without WebGL2 **fall back to Canvas2D automatically**.

## ⚡ How it works

### 1. Change the backend, not the content

`gl_PointSize` looks easiest, but **it is rounded to whole device pixels** —
a 1.32 px-radius dot (5.29 px diameter) gets snapped to 5 or 6, visibly enlarging small dots.

Instead: **instanced quads**, with the circle carved out in the fragment shader using a
half-device-pixel antialiasing band — sub-pixel accurate.

```glsl
float dist = length(v_local) * v_rad;      // distance to center (CSS px)
float aa   = 0.5 / u_dpr;                  // half a device pixel
float cov  = clamp((v_rad - dist) / (2.0 * aa) + 0.5, 0.0, 1.0);
if (cov <= 0.0) discard;
outColor = vec4(v_col, cov * v_al);
```

One `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, N)` renders everything.

### 2. Match Canvas2D's blending

```js
gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
```

### 3. Fix the "alpha saturation" gap — the hard part

Measured color in a fully covered dense patch (dot color `rgb(120,110,180)`):

| Per-dot alpha | Canvas2D | WebGL | Ratio |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0 ← saturated** | 92.2 | 0.77 |
| 1.00 | 120.0 | 120.0 | 1.00 |

Canvas2D's 44,000 source-over composites **saturate the dense areas at alpha≈0.34**;
WebGL needs ≈1.0. **This is the entire reason the WebGL version first looked dark and grid-like.**

### 4. Density-adaptive alpha correction

Calibrated multipliers (binary-searched so WebGL converges to Canvas2D's color):

| radius / local pitch | Required multiplier |
|---|---|
| 0.20 (sparse) | **×1.897** |
| 0.50 | ×1.840 |
| 0.75 (dense) | **×1.584** |

Driven by **overlap**, fitted as:

```js
k = 2.03 - 0.60 * (radius / localPitch)      // measured range ×1.58 ~ ×1.90
alpha = min(1, baseAlpha * k)
```

`localPitch` is **static** — computed once at init with a spatial grid, **zero runtime cost**.
With this applied, dense-state per-pixel diff dropped from 253 to **1.12**.

## 🎬 Demo

```bash
python -m http.server 8080
# open http://127.0.0.1:8080/demo/
```

The demo synthesizes its own point cloud from geometry (**no image assets in this repo**),
and lets you switch backends and tweak radius/DPR live.

Measured (100k-scale points, dpr 2):

| Backend | Frame time | FPS |
|---|---|---|
| WebGL2 | **0.70 ms** | **60 fps** |
| Canvas2D | 32.80 ms | 29 fps |

## 📁 Layout

```
point-figure/
├── src/
│   ├── point-figure.js        WebGL2 implementation (main)
│   └── canvas2d-figure.js     Canvas2D reference (fidelity baseline & fallback)
├── demo/
│   ├── index.html             Self-contained demo (switch backends, tweak params)
│   └── points.js              Synthetic point cloud (no external assets)
├── docs/
│   ├── TECHNICAL.md           All measurements, root-cause analysis, calibration data
│   └── INTEGRATION.md         How to integrate safely, with a feature flag
├── LICENSE
├── README.md                  中文
└── README_EN.md               English
```

## ⚠️ Known limitations

1. **Transition states are 8–23% brighter.** Dense state is nearly pixel-identical, but when the
   cloud rapidly disperses there's a visible deviation. Likely cause: the local density estimate
   is less accurate for randomly distributed points than for the regular grid used during
   calibration. Direction: finer density-bucket calibration. PRs welcome.
2. **The linear `k` fit is empirical** and degrades outside `radius/pitch ∈ [0.2, 0.75]`
   (clamped in code).
3. **Only tested on Chrome / Edge / Safari WebGL2.** Older devices rely on the Canvas2D fallback.

## 📚 References

- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) — this README's structure is inspired by it
- Inspiration for high-performance canvas work on studio sites
  (pure `vw` proportional scaling; `requestIdleCallback` + `IntersectionObserver` scheduling)

## 📄 License

[MIT](LICENSE)
