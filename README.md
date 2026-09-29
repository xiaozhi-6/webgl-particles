<div align="center">
  <img src="assets/logo.svg" width="132" alt="webgl-particles" />
  <h1>webgl-particles</h1>
  <p><b>一个合成方式对齐 Canvas2D 的 WebGL2 粒子渲染器。</b><br>
     点与点之间会像 Canvas2D 那样相互叠加、融合，而不是各自独立。<br>
     十万级点云在手机上能跑满 60fps，观感与 Canvas2D 基本一致。</p>
</div>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000.svg)](https://www.khronos.org/webgl/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#安装)
[![No build step](https://img.shields.io/badge/build-none-brightgreen.svg)](#安装)
[![Demo](https://img.shields.io/badge/Demo-在线试-blue.svg)](https://xiaozhi-6.github.io/webgl-particles/demo/)

**中文 · [English](README_EN.md) · [技术细节](docs/TECHNICAL.md) · [接入指南](docs/INTEGRATION.md)**

</div>

---

## 起因

用几万个半透明小点拼出一个人物剪影，是网页上做柔和点阵图形的常见做法。Canvas2D 画出来的
效果是对的，在电脑上也够流畅，但换到手机上就只剩 **18fps 左右**。

常见的几种优化路子都试过，对一个真实的 43,991 点案例来说都没用：

| 尝试 | 结果 |
|---|---|
| 把画布缓冲区压到 2.1 Mpx（减 62%） | 耗时**没有变化** |
| 合并成一个 `Path2D` 批量填充 | 快了 2.8 倍，但**点重叠的地方出现颗粒噪点** |
| 预渲染精灵图，用 `drawImage` 贴 | **更慢**（116 ms/帧） |
| **WebGL2 实例化四边形** | **快 47 倍** |

慢的地方从来不是填充率，而是 43,991 次 `beginPath` + `arc` + `fill` 的固定调用开销，
平均每个点 **1.08 µs**。真正做运动计算的数学部分只占一帧的 1.6%。

## 实测结果

43,991 个点，滚动时测量人物所在层的 rAF 帧间隔：

| 设备 | Canvas2D | **webgl-particles** |
|---|---|---|
| 平板 · 1024×1366 · dpr 2 | 57.0 ms（约 18fps） | **16.9 ms（60fps）** |
| 手机 · 412×915 · dpr 3 | 53.5 ms（约 19fps） | **16.6 ms（60fps）** |
| 桌面 · 1440×900 · dpr 1 | 60fps | 60fps |

与 Canvas2D 参考实现逐像素比对：

| 状态 | 亮度比 | 逐像素平均差 | 差异超过 40 的像素 |
|---|---|---|---|
| 密集/聚合 | **0.9991** | **1.12 / 255** | **0.28%** |
| 过渡中 | 1.08 ~ 1.23 | 68 ~ 75 | 59% ~ 71% |

静止画面的差异肉眼看不出来。快速散开的过渡阶段，WebGL 侧平均偏亮 8~23%，在真机上要刻意
对比才看得出来。原因与可行的解法写在[已知问题](#已知问题)和
[`docs/TECHNICAL.md`](docs/TECHNICAL.md) 里。

## 安装

没有依赖，也不需要构建，拷一个文件就能用：

```html
<canvas id="figure"></canvas>
<script type="module">
import { createPointFigure } from './src/point-figure.js';

const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: new Float32Array([/* x0, y0, x1, y1, ... */]),  // 单位为 CSS 像素
  palette: ['#463c5e', '#6b5f90', '#9c92c4', '#c8e8ff'],
  radius: 2.0,   // 每个点的半径，CSS 像素
  alpha: 0.34,   // 每个点的基础不透明度
  dpr: 2
});

figure.resize(1200, 800);
figure.setPointColors(rgb, alphaPerPoint);   // 可选，逐点指定颜色
figure.render();
</script>
```

浏览器不支持 WebGL2 时会自动退回 Canvas2D，不需要额外处理。

## 实现思路

### 1. 用实例化四边形，不用 `gl_PointSize`

`gl_PointSize` 看起来最省事，但实现会把它**舍入到整数设备像素**。半径 1.32 px 的点，
直径 5.29 会被舍成 5 或 6，小点被明显放大。

改成每个点实例化一个四边形，圆在片元着色器里按到中心的距离裁出来，边缘用半个设备像素的
过渡带做抗锯齿，这样在任何半径下都能做到亚像素精度。

```glsl
float dist = length(v_local) * v_rad;      // 到圆心的距离，CSS 像素
float aa   = 0.5 / u_dpr;                  // 半个设备像素
float cov  = clamp((v_rad - dist) / (2.0 * aa) + 0.5, 0.0, 1.0);
if (cov <= 0.0) discard;
outColor = vec4(v_col, cov * v_al);
```

所有点由一次 `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, N)` 画完。

### 2. 混合方式对齐 Canvas2D

```js
gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
```

### 3. 处理 alpha 饱和差异

观感能对上，关键在这一步。

在一块被完全覆盖的密集区域里，点的颜色取 `rgb(120,110,180)`，实测结果是：

| 每点 alpha | Canvas2D | WebGL | 比值 |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0（已饱和）** | 92.2 | 0.77 |
| 1.00 | 120.0 | 120.0 | 1.00 |

Canvas2D 每次 `fill()` 都是一次独立的源覆盖合成，4.4 万次叠加之后，密集区域在
alpha ≈ 0.34 就已经被推到满色。WebGL 是逐片元累加的，要 alpha ≈ 1.0 才到同样的颜色。

所以直接把代码搬到 WebGL，画面会偏暗、还能看出网格感。这就是画面对不上的全部原因。

### 4. 按密度修正 alpha

用二分反解出「WebGL 需要多少 alpha 才能得到 Canvas2D 的收敛色」：

| 半径 / 局部点间距 | 需要的倍数 |
|---|---|
| 0.20（稀疏） | ×1.897 |
| 0.50 | ×1.840 |
| 0.75（密集） | ×1.584 |

倍数由重叠程度决定，拟合出来是：

```js
k = 2.03 - 0.60 * (radius / localPitch)     // 实测范围 ×1.58 ~ ×1.90
alpha = min(1, baseAlpha * k)
```

`localPitch` 是每个点的静态属性，初始化时用空间网格数一次邻点就算好了，**运行时没有额外开销**。
加上这一步之后，密集状态的逐像素差异从 253 降到 **1.12**。点的数量、位置、大小、颜色都没有改动。

## 演示

**在线试：** https://xiaozhi-6.github.io/webgl-particles/demo/

本地跑：

```bash
python -m http.server 8080
# 打开 http://127.0.0.1:8080/demo/
```

演示页的点云是用几何图形现场生成的，**仓库里不含任何图片素材**。页面上可以随时切换后端、
拖动半径和设备像素比，直接看耗时差别。

| 后端 | 单帧 | 帧率 |
|---|---|---|
| WebGL2 | **0.70 ms** | **60** |
| Canvas2D | 32.80 ms | 29 |

## 目录结构

```
webgl-particles/
├── src/
│   ├── point-figure.js        WebGL2 实现
│   └── canvas2d-figure.js     Canvas2D 参考实现（观感基准，同时作为回退）
├── demo/
│   ├── index.html             自包含演示页
│   └── points.js              合成点云
├── docs/
│   ├── TECHNICAL.md           全部实测数据、标定表、踩过的坑
│   └── INTEGRATION.md         怎么安全地接进已有项目
├── assets/logo.svg
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

## 已知问题

1. **过渡状态偏亮 8~23%。** 静止和密集画面基本逐像素一致，但点云快速散开时会出现偏差。
   猜测是散开态的局部密度估得不够准：随机分布的间距比标定用的规则网格更不均匀。
   把密度分档做细一些应该能补上大部分。
2. **`k` 的线性拟合是经验值。** 在 `radius/pitch` 落在 0.2 到 0.75 之外会失准，代码里做了上下限钳制。
3. **只在 Chrome / Edge / Safari 的 WebGL2 上验证过。** 老设备依赖 Canvas2D 回退。

## 致谢

- 关于合成饱和的那点发现和整套标定方法，是给个人网站做优化时摸索出来的，这里抽成独立库。
- 高性能画布方面参考过**米哈游**（空闲时段调度、可见性停帧）和**鹰角**（纯 `vw` 等比缩放、
  靠混合模式出效果）官网的做法。

## 许可

[MIT](LICENSE)
