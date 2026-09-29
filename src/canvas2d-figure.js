/**
 * canvas2d-figure.js — 原始版本（逐点 arc + fill），保留作为观感参照与回退
 *
 * 这个版本**慢但最好看**：每个点独立做一次源覆盖合成，
 * 4.4 万次叠加后密实处会自然饱和、边缘互相融合，形成平滑的点云质感。
 * WebGL 版要复现的正是这个观感。
 *
 * 实测（43,991 点）：
 *   平板 1024×1366 dpr2 : 57.0 ms/帧（≈18fps）
 *   手机 412×915  dpr3  : 53.5 ms/帧（≈19fps）
 *   桌面 1440×900 dpr1  : 满帧（桌面显卡本来就够快）
 */

export function createCanvas2DFigure(opts) {
  const canvas = opts.canvas;
  const pts = opts.points;                    // Float32Array [x,y,...]
  const palette = opts.palette;
  const N = pts.length / 2;
  const ctx = canvas.getContext('2d');
  const dpr = opts.dpr != null ? opts.dpr : Math.min(window.devicePixelRatio || 1, 2);

  const hex = palette.map(function (c) {
    return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16)];
  });

  let W = 0, H = 0;
  let radius = opts.radius != null ? opts.radius : 2.0;
  let alpha = opts.alpha != null ? opts.alpha : 1.0;

  function resize(cssW, cssH) {
    W = cssW; H = cssH;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render(xy) {
    const P = xy || pts;
    if (P.length !== N * 2) throw new Error('points 长度不匹配');
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < N; i++) {
      const c = hex[opts.paletteIndex ? opts.paletteIndex[i] : (i % palette.length)] || hex[0];
      ctx.beginPath();
      ctx.arc(P[i * 2], P[i * 2 + 1], radius, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
      ctx.fill();
    }
  }

  function setTone(a) { alpha = a; }
  function setRadius(r) { radius = r; }

  return { resize: resize, render: render, setTone: setTone, setRadius: setRadius, count: N };
}
