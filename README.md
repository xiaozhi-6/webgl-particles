<div align="center">
  <img src="assets/logo.svg" width="132" alt="webgl-particles" />
  <h1>webgl-particles</h1>
  <p><b>A WebGL2 particle renderer that composites like Canvas2D.</b><br>
     Points blend into each other instead of staying isolated — so a 100,000-point
     figure holds 60fps on mobile, at Canvas2D visual quality.</p>
</div>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000.svg)](https://www.khronos.org/webgl/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#install)
[![No build step](https://img.shields.io/badge/build-none-brightgreen.svg)](#install)
[![Demo](https://img.shields.io/badge/Demo-live-blue.svg)](https://xiaozhi-6.github.io/webgl-particles/demo/)

**[中文](README.md) · [English](README_EN.md) · [Technical notes](docs/TECHNICAL.md) · [Integration](docs/INTEGRATION.md)**

</div>

---

## The problem

Drawing a silhouette built from tens of thousands of **independent translucent points** is the
standard way to get a soft, pointillist figure on the web. With Canvas2D it looks right, and on
desktop it runs fine — but on a phone it collapses to **~18fps**.

The usual remedies don't work. Measured on a real 43,991-point figure:

| Remedy | Result |
|---|---|
| Shrink the backing store to 2.1 Mpx (−62%) | render time **unchanged** |
| Batch everything into one `Path2D` fill | 2.8× faster, but **speckle artifacts where points overlap** |
| Pre-rendered sprite via `drawImage` | **slower** (116 ms/frame) |
| **Instanced quads in WebGL2** | **47× faster** |

The cost was never fill rate. It's the fixed per-call overhead of 43,991
`beginPath` + `arc` + `fill` calls — about **1.08 µs per point**. The math behind the motion
accounts for 1.6% of the frame.

## Results

43,991 points, figure-layer rAF interval while scrolling:

| Device | Canvas2D | **webgl-particles** |
|---|---|---|
| Tablet · 1024×1366 · dpr 2 | 57.0 ms (≈18fps) | **16.9 ms (60fps)** |
| Phone · 412×915 · dpr 3 | 53.5 ms (≈19fps) | **16.6 ms (60fps)** |
| Desktop · 1440×900 · dpr 1 | 60fps | 60fps |

Image fidelity, per-pixel against the Canvas2D reference:

| State | Luminance ratio | Mean abs. diff | Pixels off by >40 |
|---|---|---|---|
| Dense / gathered | **0.9991** | **1.12 / 255** | **0.28%** |
| In transition | 1.08 – 1.23 | 68 – 75 | 59% – 71% |

Static views are effectively identical. During rapid scatter transitions the WebGL path reads
8–23% brighter on average; on device the difference is subtle. See
[Known limitations](#known-limitations) and [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

## Install

Zero dependencies, no build step. Copy one file:

```html
<canvas id="figure"></canvas>
<script type="module">
import { createPointFigure } from './src/point-figure.js';

const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: new Float32Array([/* x0, y0, x1, y1, ... */]),  // CSS pixels
  palette: ['#463c5e', '#6b5f90', '#9c92c4', '#c8e8ff'],
  radius: 2.0,   // per-point radius, CSS px
  alpha: 0.34,   // per-point base opacity
  dpr: 2
});

figure.resize(1200, 800);
figure.setPointColors(rgb, alphaPerPoint);   // optional per-point color
figure.render();
</script>
```

Browsers without WebGL2 fall back to Canvas2D automatically. Nothing to configure.

## How it works

### 1. Instanced quads, not `gl_PointSize`

`gl_PointSize` is the obvious choice and the wrong one: implementations **round it to whole
device pixels**. At a 1.32 px radius the 5.29 px diameter snaps to 5 or 6, visibly inflating
small points.

Instead each point instantiates a quad, and the circle is carved out in the fragment shader
with a half-device-pixel antialiasing band — sub-pixel accurate at any radius.

```glsl
float dist = length(v_local) * v_rad;      // distance to center, CSS px
float aa   = 0.5 / u_dpr;                  // half a device pixel
float cov  = clamp((v_rad - dist) / (2.0 * aa) + 0.5, 0.0, 1.0);
if (cov <= 0.0) discard;
outColor = vec4(v_col, cov * v_al);
```

Everything renders in one `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, N)`.

### 2. Canvas2D-compatible compositing

```js
gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
```

### 3. Matching Canvas2D's alpha saturation

This is the part that makes the visual parity possible.

In a fully covered dense patch with dot color `rgb(120,110,180)`:

| Per-point alpha | Canvas2D | WebGL | Ratio |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0 — saturated** | 92.2 | 0.77 |
| 1.00 | 120.0 | 120.0 | 1.00 |

Canvas2D issues 44,000 independent source-over composites, so dense regions **saturate at
alpha ≈ 0.34**. WebGL accumulates per-fragment and needs ≈ 1.0 to reach the same color.
Naively porting the code therefore yields a darker, grid-like image — this is the single
cause of the visual mismatch.

### 4. Density-adaptive alpha correction

Calibrated by binary-searching the alpha at which WebGL converges to Canvas2D's color:

| radius / local pitch | Required multiplier |
|---|---|
| 0.20 (sparse) | ×1.897 |
| 0.50 | ×1.840 |
| 0.75 (dense) | ×1.584 |

Overlap drives the multiplier, fitted as:

```js
k = 2.03 - 0.60 * (radius / localPitch)     // measured range ×1.58 – ×1.90
alpha = min(1, baseAlpha * k)
```

`localPitch` is a **static per-point property**, computed once at initialization with a spatial
grid — **zero runtime cost**. Applying it drops the dense-state per-pixel difference from 253
to **1.12**. No point is added, removed, resized or recolored.

## Demo

**Live:** https://xiaozhi-6.github.io/webgl-particles/demo/

Locally:

```bash
python -m http.server 8080
# open http://127.0.0.1:8080/demo/
```

The demo synthesizes its own point cloud from geometry — **the repository contains no image
assets**. Switch backends and adjust radius / DPR live to see the cost difference.

| Backend | Frame time | FPS |
|---|---|---|
| WebGL2 | **0.70 ms** | **60** |
| Canvas2D | 32.80 ms | 29 |

## Layout

```
webgl-particles/
├── src/
│   ├── point-figure.js        WebGL2 implementation
│   └── canvas2d-figure.js     Canvas2D reference (fidelity baseline & fallback)
├── demo/
│   ├── index.html             Self-contained demo
│   └── points.js              Synthetic point cloud
├── docs/
│   ├── TECHNICAL.md           All measurements, calibration data, pitfalls
│   └── INTEGRATION.md         Adopting this safely, with a feature flag
├── assets/logo.svg
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

## Known limitations

1. **Transition states read 8–23% brighter.** Static/dense views are nearly pixel-identical, but
   when the cloud rapidly disperses a deviation appears. Likely cause: the local density estimate
   is less accurate for randomly distributed points than for the regular grid used during
   calibration. Finer density buckets should close most of the gap.
2. **The `k` fit is empirical.** It degrades outside `radius/pitch ∈ [0.2, 0.75]` and is clamped
   there.
3. **Tested on Chrome / Edge / Safari WebGL2.** Older devices rely on the Canvas2D fallback.

## Credits

- The compositing-saturation insight and its calibration approach were developed for a personal
  site; the technique is extracted here as a standalone library.
- Inspiration for high-performance canvas work comes from the studio sites of
  **miHoYo** (idle-time scheduling, visibility gating) and **Hypergryph**
  (pure `vw` proportional scaling, blend-mode-driven visuals).

## License

[MIT](LICENSE)
