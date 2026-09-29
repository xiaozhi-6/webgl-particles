# 接入指南：怎么接到已有项目里

目标是**风险可控地**换掉一个已经很满意、但在移动端卡的粒子层。

---

## 1. 最保守的接法：加一个开关，默认先不开

不要一上来就换默认路径。先让两条渲染路径并存，用 URL 参数切换：

```js
// 默认走 WebGL；地址加 ?gl=0 立刻回到 Canvas2D
var useGL = !/[?&]gl=0\b/.test(location.search);
```

好处：

- **不需要重新部署就能回退** —— 出问题时用户/你自己加个参数就切回去了
- 真机上可以直接对比（同一个页面、同一套数据）
- 上线后先让一部分人用（对内测链接加 `?gl=1`，或反过来默认关）

确认没问题之后，再把默认值反转成「默认开、`?gl=0` 关」。

> 本项目作者就是这么做的：先默认 Canvas2D + `?gl=1` 试用，
> 手机和平板真机验收通过后才改成默认开启，并保留 `?gl=0` 作为回退。

---

## 2. 数据准备

`points` 是 `Float32Array`，格式 `[x0,y0, x1,y1, ...]`，单位 **CSS 像素**。

如果你的点云是从**一张立绘**采样来的，推荐流程：

| 步骤 | 做法 | 为什么 |
|---|---|---|
| 1 | 用**透明背景**的立绘，拿 **alpha 通道**当掩膜 | 白底立绘不能用颜色阈值去底 |
| 2 | 若必须是白底：从**图像边缘 flood fill** 去底 | 直接用亮度阈值会把画面里的白色区域（眼罩、白衣服）一起删掉 |
| 3 | 形态学**开/闭** + 取**最大连通域** | 去掉孤立噪点与细碎区域 |
| 4 | **抖动网格**采样（`CELL ≈ 1.5~1.9 px`） | 纯随机采样会有疏密不匀的斑块 |
| 5 | 把采样到的颜色归类到**语义调色板**（同一部位同一色槽） | 否则 JPEG 噪点会让画面变成彩色麻点 |
| 6 | 坐标按包围盒归一化到 `0~255`，每点 4 字节 `(x, y, 色槽, 存在感)`，base64 存 | 体积小、解析快（本项目 43,991 点约 235 KB） |

---

## 3. 接到已有的动画循环里

```js
import { createPointFigure } from './src/point-figure.js';

// —— 初始化（一次）——
const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: basePoints,          // 静态的基准位置
  palette: PALETTE,
  radius: computedRadius,
  alpha: 0.34,
  dpr: Math.min(devicePixelRatio || 1, 2)
});

// 逐点颜色/透明度（从点阵的色槽与"存在感"算出来）
figure.setPointColors(rgb255, alphaPerPoint);

function layout() {
  const r = wrap.getBoundingClientRect();
  figure.resize(r.width, r.height);
}
layout();
window.addEventListener('resize', debounce(layout, 160));

// —— 每帧 ——
const cur = new Float32Array(n * 2);     // 复用，别每帧 new
function frame() {
  updatePositions(cur);                  // 你自己的物理/插值
  figure.setTone(mix, globalAlpha);      // 可选：色调随进度变化
  figure.render(cur);                    // 传入位置；不传则用静态 points
}
```

### ⚠️ 两个必须注意的点

**① canvas 尺寸必须用 `offsetWidth/offsetHeight`，不要用 `getBoundingClientRect()`**

如果父级有 `transform: scale(.85)` 之类的进场动画，
`getBoundingClientRect()` 返回的是**缩放后**的尺寸。把它写进 canvas 缓冲区，
会导致**右侧约 15% 永远填不满**，而打开 DevTools 触发一次 resize 后又"自己好了" ——
非常难查。

```js
// ✅ 布局尺寸，不受 transform 影响
const w = el.offsetWidth, h = el.offsetHeight;
// ❌ 会被 scale 污染
const r = el.getBoundingClientRect();
```

**② 离屏时一定要停帧**

滚动事件里别无条件调 `start()`。如果 `IntersectionObserver` 已经把循环停了，
`scroll` 处理器再把它唤醒，就会在**用户根本看不见的地方**持续烧掉 40ms/帧。

```js
let heroVisible = false;
io.observe(hero);                       // isIntersecting 时置位
window.addEventListener('scroll', () => {
  if (!heroVisible) return;             // ← 关键
  computeTarget();
  start();
}, { passive: true });
```

---

## 4. 参数怎么调

| 参数 | 建议 | 说明 |
|---|---|---|
| `radius` | 1.5 ~ 3.0 px | 越小越细腻但越吃调用开销（点数不变时开销不变，是**观感**取舍） |
| `alpha` | 0.25 ~ 0.5 | 密集处会自然饱和；本库会自动放大到饱和所需的值 |
| `dpr` | `min(devicePixelRatio, 2)` | 超过 2 对这么小的点几乎没有画质收益，纯浪费填充率 |
| `palette` | 4 ~ 10 色 | 语义分组，同一部位一个色槽 |

`k` 的拟合系数（`2.03` 与 `0.60`）是在 `radius/pitch ∈ [0.2, 0.75]` 上标定的。
如果你的点云密度超出这个范围，建议按 [TECHNICAL.md §4](TECHNICAL.md) 重新标定一遍。

---

## 5. 上线检查清单

- [ ] 支持 WebGL2 的设备走 GL，不支持的自动回退 Canvas2D（已内置）
- [ ] `?gl=0` 能立刻切回（不需要改代码/重新部署）
- [ ] 移动端真机（至少一台手机 + 一台平板）实测滚动流畅度
- [ ] 逐像素比对密集态与过渡态（用 `drawImage` 拷回 2D canvas 再读，别用 `readPixels`）
- [ ] 页面隐藏 / 元素离屏时确实停帧（数一下 rAF 调用次数）
- [ ] `resize` 后缓冲区与显示尺寸一致（`canvas.width === Math.round(cssW * dpr)`）
- [ ] 备份当前版本，随时可整目录还原
