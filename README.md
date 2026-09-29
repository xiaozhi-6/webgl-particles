<div align="center">
  <h1>point-figure</h1>
  <p><b>用 Canvas2D 的观感，跑 WebGL 的开销</b></p>
  <p>把十万级点云人物剪影从逐点 <code>arc+fill</code> 换成 WebGL2 实例化四边形，<br>
     移动端 <b>~18fps → 60fps</b>，逐像素几乎一致。</p>
</div>

<div align="center">

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000.svg)](https://www.khronos.org/webgl/)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#-安装)
[![Demo](https://img.shields.io/badge/Demo-打开-blue.svg)](demo/index.html)

**中文 | [English](README_EN.md)**

</div>

---

## 🔥 这是什么

一个约 400 行、零依赖的 ES module。它解决一个很具体的问题：

> 用 Canvas2D 画 4~10 万个**独立半透明圆点**组成的剪影，
> 桌面还行，**手机和平板直接卡成 18fps**。

直觉上会以为要「减少点数」或「降低分辨率」。**都不对**。实测数据：

| 尝试 | 结果 |
|---|---|
| 把画布缓冲区压到 2.1Mpx（−62%） | 耗时**几乎不变** ❌ |
| 合并成 `Path2D` 批量填充 | 快 2.8×，但**重叠处出现颗粒噪点** ❌ |
| 用 `drawImage` 画预渲染精灵 | **更慢**（116ms） ❌ |
| **换 WebGL2 实例化四边形** | **快 47×** ✅ |

**瓶颈从来不是填充率，而是 4.4 万次 `beginPath` + `arc` + `fill` 的调用开销**（≈1.08µs/点）。

## 📊 效果

在 43,991 点的真实项目上实测（移动端，滚动中的人物层帧间隔）：

| 设备 | Canvas2D | **本库（WebGL2）** |
|---|---|---|
| 平板 1024×1366 dpr2 | 57.0 ms/帧（≈18fps） | **16.9 ms/帧（=60fps）** |
| 手机 412×915 dpr3 | 53.5 ms/帧（≈19fps） | **16.6 ms/帧（=60fps）** |
| 桌面 1440×900 dpr1 | 本就满帧 | 本就满帧 |

**画质**（与 Canvas2D 逐像素比对）：

| 状态 | 亮度比 | 逐像素平均差 | 差异 >40 的像素 |
|---|---|---|---|
| 密集/聚合 | **0.9991** | **1.12 / 255** | **0.28%** |
| 过渡态 | 1.08 ~ 1.23 | 68 ~ 75 | 59% ~ 71% |

> 密集态（静态画面）几乎完全一致；快速滚动过渡时 WebGL 侧偏亮 8~23%，
> 真机观感差异极细微。这是当前实现的**已知局限**，原因与解法见 [技术说明](docs/TECHNICAL.md)。

## 🚀 安装

**零依赖、零构建**。把 `src/point-figure.js` 拷进项目即可：

```html
<canvas id="figure"></canvas>
<script type="module">
import { createPointFigure } from './src/point-figure.js';

const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: new Float32Array([/* x0,y0, x1,y1, ... */]),  // CSS 像素
  palette: ['#463c5e', '#6b5f90', '#9c92c4', '#c8e8ff'],
  radius: 2.0,        // 每个点的半径（CSS px）
  alpha: 0.34,        // 每点基础透明度
  dpr: 2              // 画布分辨率倍数
});

figure.resize(1200, 800);
figure.setPointColors(rgb255, alphaPerPoint);   // 可选：逐点颜色/透明度
figure.render();
</script>
```

不支持 WebGL2 的浏览器**自动回退** Canvas2D，无需额外处理。

## ⚡ M1–M4：四步把点云跑满帧

### M1 · 换渲染后端，不是减内容

`gl_PointSize` 看着最省事，但**它会被舍入到整数设备像素**。
半径 1.32 px 的点，直径 5.29 会被舍成 5 或 6 —— 小点被明显放大。

所以用**实例化四边形**：每个点画一个四边形，圆由片元着色器按距离裁出，
边缘用半个设备像素的过渡带做抗锯齿，**亚像素精确**。

```glsl
// 片元着色器核心
float dist = length(v_local) * v_rad;      // 到圆心的距离（CSS px）
float aa   = 0.5 / u_dpr;                  // 半个设备像素
float cov  = clamp((v_rad - dist) / (2.0 * aa) + 0.5, 0.0, 1.0);
if (cov <= 0.0) discard;
outColor = vec4(v_col, cov * v_al);
```

一次 `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, N)` 画完所有点。

### M2 · 混合模式对齐 Canvas2D

```js
gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
```

### M3 · 发现并修掉「alpha 饱和差异」——这是最难的一步

密集点阵、完全覆盖区的实测颜色（点色 `rgb(120,110,180)`）：

| 每点 alpha | Canvas2D | WebGL | 比值 |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0 ← 已饱和** | 92.2 | 0.77 |
| 0.75 | 120.0 | 118.9 | 0.99 |
| 1.00 | 120 | 120 | 1.00 |

Canvas2D 的 4.4 万次源覆盖合成**在 alpha≈0.34 就把密实处推到满色**，
WebGL 要到 alpha≈1.0 才饱和。**这就是画面一开始偏暗、"像网格空壳"的全部原因。**

> 单点渲染两边完全一致（跨度 4px、峰值 alpha 255、中心 RGBA 都是 `[255,80,80,255]`），
> 所以差异只出在**大量点叠加后的合成**，不在几何/颜色/数值。

### M4 · 密度自适应 alpha 修正

标定出「需要把 alpha 放大多少倍」：

| 半径 / 局部点间距 | 需要的倍数 |
|---|---|
| 0.20（疏） | **×1.897** |
| 0.50 | ×1.840 |
| 0.60 | ×1.736 |
| 0.75（密） | **×1.584** |

倍数由**重叠程度**主导，拟合：

```js
k = 2.03 - 0.60 * (radius / localPitch)      // 实测范围 ×1.58 ~ ×1.90
alpha 最终 = min(1, baseAlpha * k)
```

`localPitch`（每个点的局部点间距）是**静态量**，只在初始化时用网格数一次邻点，
**运行时零额外开销**。套上之后密集态逐像素差从 253 降到 **1.12**。

## 🎬 Demo

```bash
python -m http.server 8080
# 打开 http://127.0.0.1:8080/demo/
```

Demo 用**几何图形合成的点云**（仓库不含任何图片素材），
可以实时切换后端、拖动半径与设备像素比，直接看耗时差异。

实测（10 万点级、dpr 2）：

| 后端 | 单帧渲染 | 帧率 |
|---|---|---|
| WebGL2 | **0.70 ms** | **60 fps** |
| Canvas2D | 32.80 ms | 29 fps |

## 📁 结构

```
point-figure/
├── src/
│   ├── point-figure.js        WebGL2 实现（主）
│   └── canvas2d-figure.js     Canvas2D 参照实现（保留作为观感基准与回退）
├── demo/
│   ├── index.html             自包含演示（可切后端、调参数）
│   └── points.js              合成点云（无需外部素材）
├── docs/
│   ├── TECHNICAL.md           全部实测数据、根因分析、标定表、踩坑记录
│   └── INTEGRATION.md         怎么接到已有项目里（含灰度开关写法）
├── LICENSE
└── README.md
```

## ⚠️ 已知局限

1. **过渡态偏亮 8~23%**。密集态几乎逐像素一致，但点云快速散开时会有偏差。
   剩余嫌疑是散开态的**局部密度估计不够准**（随机分布比标定用的规则网格间距分布更宽）。
   方向：按密度做更细的分档标定。欢迎 PR。
2. **`k` 的线性拟合是经验值**，在 `radius/pitch ∈ [0.2, 0.75]` 之外会退化（已做上下限钳制）。
3. **只验证了 Chrome / Edge / Safari 的 WebGL2**。旧设备请依赖自动回退。

## 📚 参考

- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) —— README 组织方式参考
- 灵感来源：米哈游 / 鹰角官网的高性能粒子与画布方案
  （鹰角全站用纯 `vw` 等比缩放，米哈游用 `requestIdleCallback` + `IntersectionObserver` 做负载调度）

## 📄 License

[MIT](LICENSE)
