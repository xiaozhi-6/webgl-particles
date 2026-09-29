<div align="center">
  <img src="assets/logo.svg" width="132" alt="webgl-particles" />
  <h1>webgl-particles</h1>
  <p><b>A WebGL2 particle renderer that composites like Canvas2D.</b><br>
     Points blend into each other instead of staying isolated, so a 100,000-point
     figure holds 60fps on mobile at Canvas2D visual quality.</p>
</div>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000.svg)](https://www.khronos.org/webgl/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#install)
[![No build step](https://img.shields.io/badge/build-none-brightgreen.svg)](#install)

<h3><a href="https://xiaozhi-6.github.io/webgl-particles/demo/versus.html">▶ Open the side-by-side demo</a></h3>
<p>Same frame, same point cloud, Canvas2D and WebGL2 rendering at once, each timed separately.</p>

**中文 · English · [Technical notes](docs/TECHNICAL.md) · [Integration](docs/INTEGRATION.md)**

<sub>18fps → 60fps on mobile. The image was essentially correct from the start: 92.9% of pixels are
within ±0.5/255 of Canvas2D. An alpha correction I later derived turned out to be
**39% worse than doing nothing**, so I deleted it.
<a href="docs/blog-18fps-to-60fps.zh.md">The three self-refutations (Chinese)</a>.</sub>

</div>

---

## The problem

Drawing a silhouette built from tens of thousands of **independent translucent points** is the
standard way to get a soft, pointillist figure on the web. With Canvas2D it looks right, and on
desktop it runs fine, but on a phone it collapses to **~18fps**.

The usual remedies don't work. Measured on a real 43,991-point figure:

| Remedy | Result |
|---|---|
| Shrink the backing store to 2.1 Mpx (−62%) | render time **unchanged** |
| Batch everything into one `Path2D` fill | 2.8× faster, but **speckle artifacts where points overlap** |
| Pre-rendered sprite via `drawImage` | **slower** (116 ms/frame) |
| **Instanced quads in WebGL2** | **30×+ faster** |

The cost was never fill rate. It's the fixed per-call overhead of 43,991
`beginPath` + `arc` + `fill` calls, about **1.08 µs per point**. The math behind the motion
accounts for 1.6% of the frame.

## Results

**Frame interval while scrolling** (43,991 points, measuring the figure's own layer):

| Device | Canvas2D | **webgl-particles** |
|---|---|---|
| Tablet · 1024×1366 · dpr 2 | 57.0 ms (≈18fps) | **16.9 ms (60fps)** |
| Phone · 412×915 · dpr 3 | 53.5 ms (≈19fps) | **16.6 ms (60fps)** |
| Desktop · 1440×900 · dpr 1 | 60fps | 60fps |

**Per-pixel comparison against Canvas2D** (composited onto the dark background first):

| State | Luminance ratio | Mean abs. diff | Pixels off by >40 |
|---|---|---|---|
| Dense / gathered | **0.9991** | **0.5427 / 255** | **0.085%** |
| In transition | 1.08 – 1.23 | 68 – 75 | 59% – 71% |

Static views are visually identical; 92.9% of content pixels are within ±0.5/255. During rapid
scatter transitions the WebGL path reads 8–23% brighter on average, which on device requires
deliberate comparison to notice. See [Known limitations](#known-limitations).

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
with a half-device-pixel antialiasing band, sub-pixel accurate at any radius.

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

### 3. Do not apply an alpha correction

This one is a negative result, and it is the easiest thing to get wrong here.

The WebGL version looks darker. Measuring a fully covered dense patch (dot color `rgb(120,110,180)`):

| Per-point alpha | Canvas2D | WebGL | Ratio |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0 (saturated)** | 92.2 | 0.77 |
| 1.00 | 120.0 | 120.0 | 1.00 |

Canvas2D issues independent source-over composites, so dense regions saturate at alpha 0.34;
WebGL accumulates per-fragment and needs 1.0. **It looks like multiplying alpha by some factor
would align them.**

That is a natural conclusion, and I acted on it, with convincing-looking metrics at the time.
Real-figure measurements later disproved it. See
[The wrong turn](#the-wrong-turn-density-based-alpha-correction-do-not-use).
**The current code applies no alpha correction at all.**

## Demo

**▶ [Side by side](https://xiaozhi-6.github.io/webgl-particles/demo/versus.html)** — start here.
Same frame, same point cloud, both backends rendering simultaneously, each timed.

**[Interactive demo](https://xiaozhi-6.github.io/webgl-particles/demo/)** — switch backends and
adjust radius / DPR. The point cloud is synthesized from geometry; **the repository contains no
image assets**.

Locally:

```bash
python -m http.server 8080
# side by side  http://127.0.0.1:8080/demo/versus.html
# interactive   http://127.0.0.1:8080/demo/
```

| Scenario | Canvas2D | WebGL2 | Ratio |
|---|---|---|---|
| Side by side · desktop 1280×1000 · 24,038 points | 15.30 ms | **0.50 ms** | **31×** |
| Side by side · phone 412×915 · 15,829 points | 9.80 ms | **0.40 ms** | **33×** |

## The wrong turn: density-based alpha correction (do not use)

> ⛔ **The conclusion of this section is "don't do this."** It documents an approach that once
> shipped, was disproved by real-figure measurements, and has been **removed from the code**.
> It is here only because the mistake is instructive. **It is not part of the implementation.**

The approach: binary-search the alpha at which WebGL reaches Canvas2D's converged color,
calibrated on a set of **synthetic patches**:

| radius / local pitch | Required multiplier |
|---|---|
| 0.20 (sparse) | ×1.897 |
| 0.50 | ×1.840 |
| 0.75 (dense) | ×1.584 |

Fitted as `k = 2.03 - 0.60 * (radius / localPitch)`. `localPitch` is a static per-point property
computed once at init with a spatial grid, zero runtime cost. It dropped the dense-state per-pixel
difference from 253 to **1.12 / 255**, so at the time it looked correct.

**Re-measured on the real figure, the conclusion flipped:**

| Approach | Mean absolute luminance error (real figure) |
|---|---|
| The `k(density)` above (values 1.58–1.90) | **0.7987** |
| `k = 1` (no correction) | **0.5751** |

**39% worse than doing nothing.** Two reasons:

1. **The coefficients came from synthetic patches.** Their density distribution and sub-pixel
   phase differ from a real point cloud. What looked like "needs ×1.6–1.9" there is at most
   **1.3** in reality.
2. **Only sparse pixels benefit.** **98.2%** of the real figure's content pixels are already
   saturated, where `k` is irrelevant. Over the **96%** that are dense, `k(density)` pushed the
   error from 0.18 up to 0.48.

Bucketed by per-pixel base alpha accumulation `A0`, the real requirement is:

| A0 range | Share | Best k |
|---|---|---|
| [0.00,0.75) | 1.25% | **k = 1.3** |
| [0.75,1.50) | 0.95% | **k = 1.1** |
| [1.50,3.00) | 1.69% | **k = 1.05** |
| **[3.00,9.00)** | **96.1%** | **k = 1** |

Even implementing that curve **per point** measured 0.5704 against 0.5751 for no correction at
all, a difference of 0.005. One point covers several pixels, so a single `k` averages away the
differences between them. Reaching the per-bucket optimum (0.4572) would need per-pixel `A0`,
which requires an extra additive-blend GPU pass. Not worth it.

**Final disposition: the correction was removed from the code**, along with the `localPitch` grid
that only served it (1975 fewer bytes, one fewer init loop).

| | Mean absolute luminance error | Pixels off by >40 |
|---|---|---|
| Before (with `k(density)`) | 0.7987 | — |
| **After (`k = 1`)** | **0.5751** | **0.11%** |

Mobile frame time unchanged (tablet 16.7 ms, phone 16.6 ms).

Full data: [`docs/FINDINGS-real-figure.md`](docs/FINDINGS-real-figure.md) and
├── docs/FINDINGS-expansion-fix.md   The quad-expansion fix (the one positive change)
[`docs/TECHNICAL.md`](docs/TECHNICAL.md).

## Layout

```
webgl-particles/
├── src/
│   ├── point-figure.js            WebGL2 implementation
│   └── canvas2d-figure.js         Canvas2D reference (fidelity baseline & fallback)
├── demo/
│   ├── versus.html                Side by side (same frame, both backends)
│   ├── index.html                 Interactive demo (switch backends, tweak params)
│   └── points.js                  Synthetic point cloud (no image assets)
├── docs/
│   ├── TECHNICAL.md               All measurements, calibration data, pitfalls
│   ├── FINDINGS-real-figure.md    Real-figure measurement report
│   ├── blog-18fps-to-60fps.zh.md  Write-up: the three self-refutations (Chinese)
│   └── INTEGRATION.md             Adopting this safely, with a feature flag
├── assets/logo.svg
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

## Known limitations

1. **Transition states read 8–23% brighter.** Static and dense views are nearly pixel-identical,
   but a deviation appears when the cloud rapidly disperses. On the real figure the error
   concentrates in the sparse rim (about 2.95% of content pixels, worst case 25/255); the dense
   region is accurate. Closing it requires solving "a per-point correction cannot realise a
   per-pixel optimum."
2. **Tested on Chrome / Edge / Safari WebGL2.** Older devices rely on the Canvas2D fallback.

## Credits

- The compositing-saturation observation and the measurement method came out of optimizing a
  personal site; the technique is extracted here as a standalone library.
- Inspiration for high-performance canvas work comes from the studio sites of
  **miHoYo** (idle-time scheduling, visibility gating) and **Hypergryph**
  (pure `vw` proportional scaling, blend-mode-driven visuals).

## License

[MIT](LICENSE)
