/**
 * 合成一份"人物剪影"风格的点云（无需任何外部素材）。
 *
 * 真实项目里点云是从一张抠好的立绘采样出来的：
 *   1. 用 alpha 通道做掩膜（透明背景才行；白底要先从边缘 flood fill 去底）
 *   2. 形态学开闭 + 取最大连通域，去掉噪点
 *   3. 抖动网格采样（CELL ≈ 1.5~1.8 px），不要纯随机 —— 纯随机会有疏密不匀的斑
 *   4. 把采样到的颜色归类到一个语义调色板（同一部位用同一色槽），
 *      否则 JPEG 噪点会让画面变成彩色麻点
 *   5. 坐标按包围盒归一化到 0~255，每点 4 字节（x, y, 色槽, 存在感）
 *
 * 这个 demo 用几何图形代替立绘，保证仓库里不含任何图片素材。
 */

export const PALETTE = ['#463c5e', '#6b5f90', '#9c92c4', '#c8c0e8', '#f5c422'];

export function makePoints(cssW, cssH) {
  // 抽象人形：头 + 身 + 双臂 + 双腿
  const shapes = [
    { cx: 0.50, cy: 0.32, rx: 0.19, ry: 0.23 },   // 头
    { cx: 0.50, cy: 0.61, rx: 0.15, ry: 0.21 },   // 身
    { cx: 0.32, cy: 0.58, rx: 0.055, ry: 0.15 },  // 左臂
    { cx: 0.68, cy: 0.58, rx: 0.055, ry: 0.15 },  // 右臂
    { cx: 0.435, cy: 0.85, rx: 0.065, ry: 0.12 }, // 左腿
    { cx: 0.565, cy: 0.85, rx: 0.065, ry: 0.12 }  // 右腿
  ];

  const CELL = 1.9;
  let s = 20260828;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const xy = [];
  const rgb = [];
  const al = [];
  const edgeSoft = 0.10;   // 边缘羽化宽度（相对于图形半径）

  for (let gy = 0; gy < cssH; gy += CELL) {
    for (let gx = 0; gx < cssW; gx += CELL) {
      const px = gx + (rnd() - 0.5) * CELL * 0.95;
      const py = gy + (rnd() - 0.5) * CELL * 0.95;
      const nx = px / cssW, ny = py / cssH;

      // 落在哪个形状里？记录最近的"内部深度"
      let depth = -1, shapeIdx = -1;
      for (let i = 0; i < shapes.length; i++) {
        const sh = shapes[i];
        const dx = (nx - sh.cx) / sh.rx, dy = (ny - sh.cy) / sh.ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= 1 && (depth < 0 || d < depth)) { depth = d; shapeIdx = i; }
      }
      if (shapeIdx < 0) continue;

      // depth: 0 = 圆心, 1 = 边缘。让边缘更暗、中心更亮，做出体积感
      const light = depth > 1 - edgeSoft
        ? Math.max(0, (1 - depth) / edgeSoft)          // 边缘羽化
        : 1;
      // 顶部受光
      const top = Math.max(0, Math.min(1, 1 - (ny - 0.08) * 0.85));
      const lum = light * (0.35 + 0.65 * top);

      const slot = 1 + Math.min(3, Math.floor(lum * 3.99));
      const base = PALETTE[lum > 0.9 && depth < 0.5 ? 4 : slot];
      const r = parseInt(base.substr(1, 2), 16);
      const g = parseInt(base.substr(3, 2), 16);
      const b = parseInt(base.substr(5, 2), 16);

      xy.push(px, py);
      rgb.push(r, g, b);
      al.push(0.22 + 0.38 * light);
    }
  }

  return {
    xy: new Float32Array(xy),
    rgb: new Uint8Array(rgb),
    alpha: new Float32Array(al),
    count: xy.length / 2
  };
}
