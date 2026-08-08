# Canvas 插件设计

`@pluxel/canvas` 在 `@napi-rs/canvas` 之上提供 Pluxel lifecycle 与宿主资源预算，但不重新实现 Canvas 2D API。

## Capability surface

- `CanvasPlugin` 是 `FontsPlugin` 的 required consumer；provider 必须先启动并恢复统一的 managed collection，Canvas
  只读取字体快照。
- `createCanvas()` 返回原生 raster Canvas，`createSvgCanvas()` 返回原生 SVG Canvas；绘制、测量和编码继续使用上游
  标准对象，避免维护第二份 context API。两个 factory 会把 `FontsPlugin.defaultFont` 应用为新 context 的初始
  `10px` family；Workbench 变更影响之后创建的 context，不改写已有原生对象。
- 上游 `SvgExportFlag` 实际是三个互斥 enum variant，并不接受 `0` 或 bitwise 组合；公开 API 因此使用一个
  `mode`，默认 `compact`，不暴露无法实现的 boolean 组合。
- `decodeImage()` 只接受调用方已经取得的 bytes。URL 下载、认证、重试和 outbound policy 应由 Wretch 或领域 HTTP
  client 完成，Canvas 不建立第二套网络策略。
- `Path2D`、DOM geometry 和 path enums 是无 lifecycle 的 value primitives，可从本包直接导入；`GlobalFonts`、
  `FontKey`、裸 `Canvas` constructor 和上游全局 cache 不导出。
- `createImage()` 只创建未加载 placeholder，服务需要同步返回 Image 的 platform adapter。真实 bytes 仍通过
  `decodeImage()`，所以 placeholder factory 不能绕过 decode budget。

## Worker boundary

`CanvasPlugin` 包含 caller lease、Fonts dependency、effects 和可选 Workbench mount，不能 structured clone，也不会在线程中
重新启动。主线程通过 `canvas.workerSnapshot` 输出 nested-frozen 纯数据：native/text limits、默认 CSS family、Fonts revision，
以及具体默认 family 存在时的验证名。它不包含字体文件、native key、registry mutation 或 Context。

`@pluxel/canvas/worker` 是无 Pluxel runtime dependency 的 Node-only adapter。每个 task 用 snapshot 创建轻量 adapter；
`@napi-rs/canvas` module 和 ESM cache 仍按 worker lifetime 复用，只有 caller-owned Canvas/Image/ECharts surface 按任务创建。
adapter 在 native allocation/decode 前后执行与主插件相同的 limit contract，并在 worker registry 中验证具体默认字体。

`@pluxel/canvas/worker/pretext` 单独提供 `createCanvasWorkerTextLayout()` 和纯 layout/walker exports。它与主 CanvasPlugin
复用同一个输入校验、font revision invalidation、字符预算和 1×1 measurement shim；拆分子入口确保只做 Canvas raster 的
worker artifact 不加载 Pretext。worker thread 退出会自然回收其 ESM/native/Pretext cache，不需要模拟 plugin stop。

## Pretext 排版

`@chenglou/pretext` 0.0.8 的测量入口仍只寻找 browser `OffscreenCanvas` / DOM。Canvas 在第一次受控 prepare 时临时
安装一个只允许 1×1 measurement canvas 的 shim，让 Pretext 缓存 native 2D context 后立即恢复原 global property；不向
进程暴露可任意分配的 OffscreenCanvas constructor。prepare API 由 CanvasPlugin 承担 lifecycle、文本/inline item 输入
限制和默认 font shorthand，纯 layout/materialize/walk helper 直接作为无资源 value operation 导出。

Pretext 自己的 segment/font cache 是进程共享且无大小参数。Canvas 以累计输入字符限制其存活窗口，并在达到预算时调用
上游 `clearCache()`。FontsPlugin 提供 native registry/default revision；revision 改变时也清 cache，避免同 family alias
更换 font bytes 后复用旧 measurement。prepared value 已包含宽度和分段，清共享 cache 不会让已有 value 失效。

Pretext 是 line breaking/measurement，不是完整 shaping renderer；mixed-direction 精确 glyph positioning、自动断词和完整
CSS inline formatting 仍遵循上游 caveat。调用方按返回 line/range 用原生 context 绘制。

## 预算与取消

factory 在原生分配前检查 width、height 和 pixel count；图片解码在提交 native work 前限制 encoded bytes，并在完成后
检查 decoded dimensions。默认 pixel budget 对应 64 MiB RGBA。返回的原生 Canvas 允许调用方随后 resize，因此预算契约
明确只覆盖本插件的创建入口，不宣称代理原生对象的全部 mutation。

文本 prepare 默认限制单次 100,000 UTF-16 characters、rich inline 2,048 items，并在累计 1,000,000 characters 后重置
Pretext cache；这些值可由 Canvas config 收紧或放宽到 schema ceiling。

`decodeImage()` 接受 `AbortSignal`。上游 native decode 当前不可取消；abort 会立即停止等待并丢弃迟到结果，底层工作可能
继续到本次 decode 完成。consumer/provider stop 使用相同等待信号。已经返回的 Canvas/Image 是 caller-owned native
对象，由 GC 管理，不会在 provider stop 时被隐式销毁。

## Workbench composition

Canvas 自己不实现字体管理 UI。它作为 Fonts 的 direct required consumer 挂载 `FontsSelectionPort`，只决定 `Fonts`
tab placement，并绑定 provider-owned selector RPC；renderer、候选集合、默认选择与 mutation 都由 `FontsPlugin` 提供。
selector 只能读取候选和修改统一默认值，上传/删除仍只在 FontsPlugin 的 canonical View。Workbench disabled 时 managed
fonts 和 Canvas 业务能力保持完整。`canvas.defaultFont` 返回同一 provider snapshot，调用方调整字号时可以复用其中的
`cssFamily`。

## Runtime boundary

constructor dependency、caller-bound Context、effects、persistence 与 typed Port 已经覆盖依赖、归属、回收和 UI 组合。
把 native Canvas 或字体路径加入 runtime 会制造单一集成特例。唯一反馈给通用工具链的规则是 package-local native
ownership：artifact graph 中每个 package 可以拥有自己 direct 声明的 native dependency；构建器生成 owner-aware loader bridge，
不能要求最外层业务插件重复声明 `@napi-rs/canvas`，也不能借传递依赖越过 package contract。
