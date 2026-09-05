# Canvas 插件设计

`@pluxel/canvas` 在 `@napi-rs/canvas` 之上提供 Pluxel lifecycle 与宿主资源预算，但不重新实现 Canvas 2D API。

## Capability surface

- `CanvasPlugin` 是 `FontsPlugin` 的 required consumer；provider 必须先启动并恢复统一的 managed collection，Canvas
  只读取字体快照。
- `createCanvasSync()` 返回原生 raster Canvas，`createSvgCanvasSync()` 返回原生 SVG Canvas；绘制、测量和编码继续使用上游
  标准对象，避免维护第二份 context API。两个 factory 会把 `FontsPlugin.defaultFont` 应用为新 context 的初始
  `10px` family；provider preference 变更影响之后创建的 context，不改写已有原生对象。
- 上游 `SvgExportFlag` 实际是三个互斥 enum variant，并不接受 `0` 或 bitwise 组合；公开 API 因此使用一个
  `mode`，默认 `compact`，不暴露无法实现的 boolean 组合。
- `decodeImage()` 只接受调用方已经取得的 bytes。URL 下载、认证、重试和 outbound policy 应由 Wretch 或领域 HTTP
  client 完成，Canvas 不建立第二套网络策略。
- `Path2D`、DOM geometry 和 path enums 是无 lifecycle 的 value primitives，可从本包直接导入；`GlobalFonts`、
  `FontKey`、裸 `Canvas` constructor 和上游全局 cache 不导出。
- root 不公开裸 Image placeholder factory，因为 native `src` setter 无法拦截，会绕过 `decodeImage()` budget。
- `@pluxel/canvas/table` 是 plugin-free 的静态表格子入口。它只接受 caller 的 Pretext preparation callback 与 native
  context，计算 column/cell snapshot 并执行 draw；不分配 surface、编码文件、拉取图片或持有字体/Context。它不是排序、分页、
  二维码或图表 renderer。

## Worker boundary

`CanvasPlugin` 包含 caller lease、Fonts dependency、effects 和可选 Workbench publication，不能 structured clone，也不会在线程中
重新启动。主线程通过 `canvas.workerSnapshot` 输出 nested-frozen 纯数据：native/text/decode limits、默认 CSS family、Fonts
revision，以及具体默认 family 存在时的验证名。它不包含字体文件、native key、registry mutation 或 Context。

`@pluxel/canvas/worker` 是无 Pluxel runtime dependency 的 Node-only adapter。每个 task 用 snapshot 创建轻量 adapter；
`@napi-rs/canvas` module 和 ESM cache 仍按 worker lifetime 复用，只有 caller-owned Canvas/Image/ECharts surface 按任务创建。
adapter 在 native allocation/decode 前后执行与主插件相同的 limit contract，并在 worker registry 中验证具体默认字体。
每个线程只保留最近一个按值匹配的 normalized snapshot；相同 Fonts revision 与 limits 的连续任务跳过重复 freeze 和
font registry lookup。adapter 本身是 caller-owned scheduler lifecycle，任务结束时 `close()` 会拒绝 queued decode，并等待
已经提交且不可取消的 native decode 真正 settle，之后不再接受新操作；此前返回的 native surface 仍由 caller 持有。
CanvasPlugin 同样在 generation init 后缓存 config-derived limit snapshot。
`decodeImage()` 默认 snapshot borrowed bytes；明确的 `dataOwnership: 'owned'` 永久移交 storage，允许 ECharts 等已经拥有
render-local bytes 的调用方直接提交 native decoder。

worker adapter 的 `createImage()` 只为 ECharts 一类必须同步返回 placeholder 的 platform contract 保留；它返回上游裸
Image，直接写 `src` 不受 adapter byte budget 约束。`decodeImageInto()` 把 bounded bytes 写入并返回同一个 trusted
placeholder，直到 Promise settle 前都独占该对象，避免“先 decode、再写 src”造成双重 native decode。worker snapshot
携带 adapter-local concurrency/queue，多个图片 decode 不会绕过 admission。root decode 默认并发 2；每个 worker adapter
默认并发 1，因为 Runtime worker pool 已经提供外层并行，避免默认 4 workers 再各提交 4 个 libuv work。该入口不是面向
不可信输入的资源边界，Worker 本身也不是安全 sandbox。

`@pluxel/canvas/worker/pretext` 只提供 `createCanvasWorkerTextLayout()`；纯 layout/walker 从 worker-safe 的
`@pluxel/canvas/pretext` 导入。它与主 CanvasPlugin 复用同一个输入校验、font revision invalidation、字符预算和 1×1 measurement shim；拆分子入口确保只做 Canvas raster 的
worker artifact 不加载 Pretext。worker thread 退出会自然回收其 ESM/native/Pretext cache，不需要模拟 owner generation lifecycle。

## Pretext 排版

`@chenglou/pretext` 0.0.8 的测量入口仍只寻找 browser `OffscreenCanvas` / DOM。Canvas 在第一次受控 prepare 时临时
安装一个只允许 1×1 measurement canvas 的 shim，让 Pretext 缓存 native 2D context 后立即恢复原 global property；不向
进程暴露可任意分配的 OffscreenCanvas constructor。prepare API 由 CanvasPlugin 承担 lifecycle、文本/inline item 输入
限制和默认 font shorthand，纯 layout/materialize/walk helper 从 `@pluxel/canvas/pretext` 作为无资源 value operation 导出。

Pretext 自己的 segment/font cache 是进程共享且无大小参数。Canvas 以累计输入字符限制其存活窗口，并在达到预算时调用
上游 `clearCache()`。FontsPlugin 提供 native registry/default revision；revision 改变时也清 cache，避免同 family alias
更换 font bytes 后复用旧 measurement。prepared value 已包含宽度和分段，清共享 cache 不会让已有 value 失效。

Pretext 是 line breaking/measurement，不是完整 shaping renderer；mixed-direction 精确 glyph positioning、自动断词和完整
CSS inline formatting 仍遵循上游 caveat。调用方按返回 line/range 用原生 context 绘制。

## 预算与取消

带 `Sync` 后缀的 root factory/Pretext API 在原生分配前检查 width、height、pixel/text count，明确表示它们直接
占用调用线程；重 drawing consumer 应通过独立 task 使用 worker adapter。图片解码在提交 native work 前限制 encoded bytes，并在完成后
检查 decoded dimensions。默认 pixel budget 对应 64 MiB RGBA。返回的原生 Canvas 允许调用方随后 resize，因此预算契约
明确只覆盖本插件的创建入口，不宣称代理原生对象的全部 mutation。

文本 prepare 默认限制单次 100,000 UTF-16 characters、rich inline 2,048 items，并在累计 1,000,000 characters 后重置
Pretext cache；这些值可由 Canvas config 收紧或放宽到 schema ceiling。

`decodeImage()` 接受 `AbortSignal`。上游 native decode 当前不可取消；abort 会立即停止等待并丢弃迟到结果，底层工作可能
继续到本次 decode 完成。默认 borrowed bytes 在 async 方法 settle 前保持不变，并以 cooperative chunk snapshot；选择 `owned` 后即使 abort/failure
也不返还 data ownership。consumer/provider stop 使用相同等待信号。已经返回的 Canvas/Image 是 caller-owned native
对象，由 GC 管理，不会在 provider stop 时被隐式销毁。

root decode 先进入 generation-local owner-fair scheduler，再 snapshot bytes；global/per-caller queue 满时不会先复制。
上游 decode 无法取消，因此 caller Promise abort 后，held native Promise 仍占用 concurrency slot；provider cleanup 会
拒绝 queued task 并等待所有 held decode settle，避免 replacement generation 与旧 native work 无界重叠。

## Workbench composition

Canvas 自己不实现字体管理 UI。它作为 Fonts 的 direct required consumer 放置
`FontsWorkbench.selection`，只决定 tab placement 并绑定 exact provider handle；renderer、catalog、默认选择与 mutation
都由 `FontsPlugin` 提供，不创建 Canvas consumer target。
selector 只能读取候选和修改统一默认值，上传/删除仍只在 FontsPlugin 的 canonical View。Workbench disabled 时 managed
fonts 和 Canvas 业务能力保持完整。`canvas.defaultFont` 返回同一 provider snapshot，调用方调整字号时可以复用其中的
`cssFamily`。

## Runtime boundary

constructor dependency、caller-bound Context、effects、persistence 与 typed Attachment 已经覆盖依赖、归属、回收和 UI 组合。
把 native Canvas 或字体路径加入 runtime 会制造单一集成特例。唯一反馈给通用工具链的规则是 package-local native
ownership：artifact graph 中每个 package 可以拥有自己 direct 声明的 native dependency；构建器生成 owner-aware loader bridge，
不能要求最外层业务插件重复声明 `@napi-rs/canvas`，也不能借传递依赖越过 package contract。
