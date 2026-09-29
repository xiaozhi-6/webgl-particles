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

<h3><a href="https://xiaozhi-6.github.io/webgl-particles/demo/versus.html">▶ 打开并排对比演示</a></h3>
<p>同一帧、同一套点云，Canvas2D 与 WebGL2 同时渲染，各自计时。</p>

**中文 · [English](README_EN.md) · [技术细节](docs/TECHNICAL.md) · [接入指南](docs/INTEGRATION.md) · [实战记录](docs/blog-18fps-to-60fps.zh.md)**

<sub>手机端 18fps → 60fps。画质从一开始就基本是对的：92.9% 的像素与 Canvas2D 的偏差在 ±0.5/255 以内。<br>
我后来写过一个 alpha 修正公式，实测比什么都不做还差 39%，于是删掉了。<a href="docs/blog-18fps-to-60fps.zh.md">那三次被自己推翻的过程</a>。</sub>

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
| **WebGL2 实例化四边形** | **快 30 倍以上** |

慢的地方从来不是填充率，而是 43,991 次 `beginPath` + `arc` + `fill` 的固定调用开销，
平均每个点 **1.08 µs**。真正做运动计算的数学部分只占一帧的 1.6%。

## 实测结果

**滚动时的帧间隔**（43,991 点，测量人物所在这一层）：

| 设备 | Canvas2D | **webgl-particles** |
|---|---|---|
| 平板 · 1024×1366 · dpr 2 | 57.0 ms（约 18fps） | **16.9 ms（60fps）** |
| 手机 · 412×915 · dpr 3 | 53.5 ms（约 19fps） | **16.6 ms（60fps）** |
| 桌面 · 1440×900 · dpr 1 | 60fps | 60fps |

**与 Canvas2D 逐像素比对**（在深底上合成后比较）：

| 状态 | 亮度比 | 逐像素平均差 | 差异超过 40 的像素 |
|---|---|---|---|
| 密集 / 聚合 | **0.9991** | **0.5427 / 255** | **0.085%** |
| 过渡中 | 1.08 ~ 1.23 | 68 ~ 75 | 59% ~ 71% |

静止画面的差异肉眼看不出来，92.9% 的内容像素偏差在 ±0.5/255 以内。快速散开的过渡阶段
WebGL 侧平均偏亮 8~23%，在真机上要刻意对比才看得出来。原因见[已知问题](#已知问题)。

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

### 3. 不要做 alpha 修正

这一条是**否定式**的，也是这个项目里最容易被绕进去的地方。

WebGL 换上去之后画面会偏暗。量一块被完全覆盖的密集区域（点色 `rgb(120,110,180)`）：

| 每点 alpha | Canvas2D | WebGL | 比值 |
|---|---|---|---|
| 0.10 | 117.4 | 37.6 | 0.32 |
| 0.20 | 119.8 | 64.4 | 0.54 |
| **0.34** | **120.0（已饱和）** | 92.2 | 0.77 |
| 1.00 | 120.0 | 120.0 | 1.00 |

Canvas2D 每次 `fill()` 都是独立的源覆盖合成，4.4 万次叠下来，密集区在 alpha 0.34 就已被
推到满色；WebGL 逐片元累加，要 alpha 1.0 才到同样的颜色。**看起来只要给 alpha 乘一个系数
就能对齐。**

这个念头很自然，我也确实做了，而且当时的指标很漂亮。但它后来被真实数据否定了，详见
[走过的弯路](#走过的弯路按密度修正-alpha别用)。**当前代码里没有任何 alpha 修正。**

## 演示

**▶ [并排对比](https://xiaozhi-6.github.io/webgl-particles/demo/versus.html)** —— 推荐先看这个。
同一帧、同一套点云，两个后端同时渲染，各自计时，一眼能看出差距。

**[交互演示](https://xiaozhi-6.github.io/webgl-particles/demo/)** —— 可以切换后端、拖动半径和
设备像素比。本地点云是用几何图形现场生成的，**仓库里不含任何图片素材**。

本地跑：

```bash
python -m http.server 8080
# 并排对比  http://127.0.0.1:8080/demo/versus.html
# 交互演示  http://127.0.0.1:8080/demo/
```

| 场景 | Canvas2D | WebGL2 | 倍数 |
|---|---|---|---|
| 并排对比 · 桌面 1280×1000 · 24,038 点 | 15.30 ms | **0.50 ms** | **31×** |
| 并排对比 · 手机 412×915 · 15,829 点 | 9.80 ms | **0.40 ms** | **33×** |

## 走过的弯路：按密度修正 alpha（别用）

> ⛔ **这一节的结论是「不要这么做」。** 它记录的是一个曾经上线、后来被真实数据否定并
> **已从代码中移除**的做法。列在这里只是因为踩坑本身有价值，**它不是实现步骤的一部分**。

当时的做法：用二分反解出「WebGL 需要多少 alpha 才能得到 Canvas2D 的收敛色」，
在一批**合成小块**上标定，得到：

| 半径 / 局部点间距 | 需要的倍数 |
|---|---|
| 0.20（稀疏） | ×1.897 |
| 0.50 | ×1.840 |
| 0.75（密集） | ×1.584 |

拟合成 `k = 2.03 - 0.60 * (radius / localPitch)`，`localPitch` 是每点的静态属性，
初始化时用空间网格数一次邻点，运行时零开销。加上之后密集态的逐像素差异从 253 降到
**1.12 / 255**，于是当时判断这套修正有效。

**后来在真实图形上重测，结论反了：**

| 方案 | 平均绝对亮度偏差（真实图形） |
|---|---|
| 上述 `k(density)`（取值 1.58~1.90） | **0.7987** |
| `k = 1`（完全不修正） | **0.5751** |

**这套修正比"什么都不做"更差 39%。** 原因有两条：

1. **系数是在合成小块上标定的。** 那些小块的密度分布、子像素相位都与真实点云不同。
   在小块上观察到的是「需要放大 1.6~1.9 倍」，在真实点云上最大只需要 **1.3**。
2. **修正只在稀疏区有用。** 真实图形的内容像素里 **98.2% 已经饱和**，饱和之后 `k` 取任何
   值结果都一样；而 `k(density)` 在占 **96%** 的密集区反而把误差从 0.18 抬到 0.48。

真实图形上按「每像素基础 alpha 累积 A0」分桶，修正倍数的真实需求其实是：

| A0 区间 | 占比 | 最优 k |
|---|---|---|
| [0.00,0.75) | 1.25% | **k = 1.3** |
| [0.75,1.50) | 0.95% | **k = 1.1** |
| [1.50,3.00) | 1.69% | **k = 1.05** |
| **[3.00,9.00)** | **96.1%** | **k = 1** |

形状是「k 从 1.3 单调降到 1.0」。即使按这条曲线做**逐点**的 `k(A0)`，实测也只有 0.5704，
比不修正的 0.5751 好 0.005，等于没有 —— 因为一个点覆盖多个像素，给点一个 `k` 会抹平它
覆盖像素之间的差异。要做到理想（0.4572）必须逐像素算 A0，那需要额外一次加法混合的 GPU
pass，不划算。

**最终处置：修正已从代码中移除**，连带删掉只服务于它的 `localPitch` 网格计算（少 1975 字节，
少一次初始化循环）。

| | 平均绝对亮度偏差 | >40 的像素 |
|---|---|---|
| 移除前（含 `k(density)`） | 0.7987 | — |
| **移除后（`k = 1`）** | **0.5751** | **0.11%** |

移动端帧时未退化（平板 16.7 ms、手机 16.6 ms）。

完整数据：[`docs/FINDINGS-real-figure.md`](docs/FINDINGS-real-figure.md) 与
├── docs/FINDINGS-expansion-fix.md   四边形扩边的修复（唯一的正向改动）
[`docs/TECHNICAL.md`](docs/TECHNICAL.md) 第 4 节。

## 目录结构

```
webgl-particles/
├── src/
│   ├── point-figure.js            WebGL2 实现
│   └── canvas2d-figure.js         Canvas2D 参考实现（观感基准，同时作为回退）
├── demo/
│   ├── versus.html                并排对比（同一帧，两个后端）
│   ├── index.html                 交互演示（可切后端、调参数）
│   └── points.js                  合成点云（无图片素材）
├── docs/
│   ├── TECHNICAL.md               全部实测数据、标定表、踩过的坑
│   ├── FINDINGS-real-figure.md    真实图形上的测量报告
│   ├── blog-18fps-to-60fps.zh.md  实战记录：三次推翻自己的过程
│   └── INTEGRATION.md             怎么安全地接进已有项目
├── assets/logo.svg
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

## 已知问题

1. **过渡状态偏亮 8~23%。** 静止和密集画面基本逐像素一致，但点云快速散开时会出现偏差。
   真实图形上测得的误差集中在稀疏边缘（占内容像素约 2.95%，最大偏差 25/255），
   密集区本身是准的。要再压下去需要解决「按点给的修正无法兑现按像素的理想值」这个问题。
2. **只在 Chrome / Edge / Safari 的 WebGL2 上验证过。** 老设备依赖 Canvas2D 回退。

## 致谢

- 关于合成饱和的那点发现和整套测量方法，是给个人网站做优化时摸索出来的，这里抽成独立库。
- 高性能画布方面参考过**米哈游**（空闲时段调度、可见性停帧）和**鹰角**（纯 `vw` 等比缩放、
  靠混合模式出效果）官网的做法。

## 许可

[MIT](LICENSE)
