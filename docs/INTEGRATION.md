# 接入指南

给一个已经在跑、观感也满意，只是移动端卡的粒子层做替换。下面按风险从低到高的顺序写。

---

## 1. 先加开关，别急着改默认值

不要一上来就把默认路径换掉。两条渲染路径并存，用 URL 参数切换：

```js
// 默认走 WebGL，地址带 ?gl=0 就回到 Canvas2D
var useGL = !/[?&]gl=0\b/.test(location.search);
```

这么做有几个好处：

- 出问题不用重新部署，加个参数就切回去了
- 真机上对比方便，同一个页面同一套数据
- 可以只放给一部分人用（内测链接加 `?gl=1`，或者反过来默认关）

确认没问题之后，再把默认值反过来。

> 这个库本身就是这么上线的：先默认 Canvas2D，用 `?gl=1` 试，
> 手机和平板真机都过了才改成默认开，`?gl=0` 留着当回退。

---

## 2. 点云怎么准备

`points` 是 `Float32Array`，格式 `[x0,y0, x1,y1, ...]`，单位是 CSS 像素。

如果点云是从立绘采样来的，按下面这个顺序做：

| 步骤 | 做法 | 原因 |
|---|---|---|
| 1 | 用透明背景的立绘，拿 alpha 通道当掩膜 | 白底立绘没法靠颜色阈值去底 |
| 2 | 只有白底素材时，从图像边缘 flood fill 去底 | 直接卡亮度阈值，画面里的白色部分（眼罩、白衣服）会一起被删掉 |
| 3 | 形态学开闭运算，再取最大连通域 | 去掉孤立噪点和细碎区域 |
| 4 | 抖动网格采样，`CELL` 取 1.5 ~ 1.9 px | 纯随机采样会有疏密不匀的斑块 |
| 5 | 把采样颜色归到少数几个语义色槽 | 不归的话，JPEG 噪点会让画面变成彩色麻点 |
| 6 | 坐标按包围盒归一化到 0~255，每点 4 字节 `(x, y, 色槽, 存在感)`，base64 存 | 体积小、解析快，43,991 点大约 235 KB |

---

## 3. 接进已有的动画循环

```js
import { createPointFigure } from './src/point-figure.js';

// 初始化，只做一次
const figure = createPointFigure({
  canvas: document.getElementById('figure'),
  points: basePoints,          // 静态基准位置
  palette: PALETTE,
  radius: computedRadius,
  alpha: 0.34,
  dpr: Math.min(devicePixelRatio || 1, 2)
});

// 逐点颜色和透明度，由色槽和"存在感"算出来
figure.setPointColors(rgb255, alphaPerPoint);

function layout() {
  // 用 offsetWidth / offsetHeight，理由见下面第 3.1 节
  figure.resize(wrap.offsetWidth, wrap.offsetHeight);
}
layout();
window.addEventListener('resize', debounce(layout, 160));

// 每帧
const cur = new Float32Array(n * 2);     // 复用这个数组，别每帧 new
function frame() {
  updatePositions(cur);                  // 你自己的物理或插值
  figure.setTone(mix, globalAlpha);      // 可选，让色调随进度变化
  figure.render(cur);                    // 不传则用初始化时的静态位置
}
```

### 3.1 canvas 尺寸用 `offsetWidth`，别用 `getBoundingClientRect()`

父级如果有 `transform: scale(.85)` 之类的进场动画，`getBoundingClientRect()` 拿到的是
缩放之后的尺寸。把这个值写进 canvas 缓冲区，右侧大约 15% 会永远填不满。麻烦的是打开
DevTools 触发一次 resize，它又自己好了，很难往这个方向想。

```js
// 布局尺寸，不受 transform 影响
const w = el.offsetWidth, h = el.offsetHeight;
```

### 3.2 离屏时必须停帧

滚动事件里不要无条件调 `start()`。`IntersectionObserver` 已经把循环停了，
`scroll` 处理器又把它叫醒，用户看不见的地方就会一直按 40ms 一帧烧下去。

```js
let heroVisible = false;
io.observe(hero);                       // isIntersecting 时置位
window.addEventListener('scroll', () => {
  if (!heroVisible) return;             // 这一行是关键
  computeTarget();
  start();
}, { passive: true });
```

---

## 4. 参数取值

| 参数 | 建议 | 说明 |
|---|---|---|
| `radius` | 1.5 ~ 3.0 px | 越小越细腻。点数不变时开销也不变，所以纯粹是观感取舍 |
| `alpha` | 0.25 ~ 0.5 | 密集处会自然饱和，库会自动放大到饱和需要的值 |
| `dpr` | `min(devicePixelRatio, 2)` | 超过 2 对这种小点几乎没有画质收益，只是白耗填充率 |
| `palette` | 4 ~ 10 色 | 按部位分组，一个部位一个色槽 |

`k` 的两个拟合系数（`2.03` 和 `0.60`）是在 `radius/pitch` 落在 0.2 到 0.75 之间标定的。
点云密度超出这个范围的话，按 [TECHNICAL.md 第 4 节](TECHNICAL.md) 重新标一遍。

---

## 5. 上线前过一遍

- [ ] 支持 WebGL2 的设备走 GL，不支持的自动退回 Canvas2D（库内置）
- [ ] `?gl=0` 能立刻切回去，不需要改代码或重新部署
- [ ] 至少一台手机加一台平板，真机测滚动流畅度
- [ ] 密集态和过渡态都做过逐像素比对。读回用 `drawImage` 拷进 2D canvas，不要用 `readPixels`
- [ ] 页面隐藏、元素离屏时确实停了帧，数一下 rAF 的调用次数
- [ ] resize 之后缓冲区跟显示尺寸对得上：`canvas.width === Math.round(cssW * dpr)`
- [ ] 当前版本有备份，能整目录还原
