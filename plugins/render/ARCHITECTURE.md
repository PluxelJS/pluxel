# Render execution architecture

`plugins/render/*` 按能力所有者决定执行位置。N-API async 只移走 native task 内的计算；JSX、HTML、CSS 与输入
转换仍可能占用调用线程。需要隔离这部分工作时使用现有共享 Workers。上游 SDK 的输入、输出和失败语义由上游维护；
业务转换、文档会话和字体管理分别由自己的 Plugin 负责。

## 能力与执行边界

```text
FontsPlugin (process resource owner)
   ├─ CanvasPlugin (explicit synchronous primitives + worker adapters)
   │      └─ EChartsPlugin (worker-only renderer)
   └─ TypstPlugin (stateful sessions + stateless SVG compilation)
          └─ optional provider for TakumiMarkdownPlugin

TakumiPlugin (native methods + HTML/Node *InWorker methods)
   └─ TakumiMarkdownPlugin (GFM, highlighting, optional restricted math)
          └─ one final Takumi worker render

Business Worker task (local JSX template + plain input)
   └─ @pluxel/plugin-takumi/worker (worker-local Renderer cache)
```

| 能力          | 宿主线程                                                                                     | Worker/native 边界                                                       | Admission owner                  |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Fonts         | lifecycle、metadata、最终 native registry mutation                                           | bounded 文件 IO 与大 byte snapshot/hash/record copy 是 async/cooperative | Fonts generation fair scheduler  |
| Canvas root   | 名称带 `Sync` 的 allocation/drawing/text primitive                                           | `decodeImage()` native async；`./worker` adapter 供独立 task 使用        | Canvas generation fair scheduler |
| ECharts       | 小型 contract validation、含大字符串的 cooperative option walk、有界 transport serialization | layout、ZRender、image decode、encode 全部在共享 Worker                  | Runtime root worker pool         |
| Takumi root   | 上游 JSX、HTML、CSS/资源准备与 N-API 输入转换                                                | raster/SVG 核心使用 libuv 的 N-API async work；动画沿用上游实现          | 上游实现与调用方                 |
| Takumi Worker | cloneable HTML/Node/options 的 snapshot 与 transport                                         | HTML/JSX、CSS 与资源准备在 Worker；native 仍使用进程共享 libuv           | Host Worker pool                 |
| Markdown      | GFM、Rangi、受信任扩展与 render-local asset 准备                                             | 最终 HTML/Node raster/SVG 通过 Takumi 的官方 task 执行                   | 文档 limits + Host Worker pool   |
| Typst SVG     | source/option 校验与已接纳任务的字体快照准备                                                 | `TypstPlugin.renderSvg()` 通过共享 Worker 执行 stateless SVG 编译        | Host Worker pool                 |

Takumi 的三个原生 prototype methods 直接调用 `takumi-js`，保留原生输入、options、bytes/string 返回值和异常。
显式的 `renderInWorker`、`renderSvgInWorker`、`renderAnimationInWorker` 只接收 cloneable HTML/Node/options，统一提交官方
task。业务 JSX 在自己的 task 中构建，并通过 `@pluxel/plugin-takumi/worker` 的 `render`、`renderSvg`、`renderAnimation` 使用
同一缓存机制。插件不创建私有线程池或第二层 queue。

Takumi Markdown 拥有 GFM parse、Rangi static highlighting、document limits、extension 与 render-local assets；转换后只调用一次
Takumi Worker render。它使用可跨线程的 render options，并增加 Markdown theme；图片默认禁止远程加载，显式
`images.allowRemote: true` 开启。内置数学通过 type-only optional Plugin ref 选择 `TypstPlugin`，没有该 provider 时保留
普通 Markdown；provider 出现、撤回或替换时重启 Markdown 与下游，旧 renderer 失效。数学层只拥有受限公式、SVG 容量与
asset sink 接线；compiler、字体和编译 Worker 由 TypstPlugin 维护。

Worker 是 event-loop isolation 和统一 thread admission，不是安全边界。native crash、内存分配和 CPU 饱和仍可影响
整个进程。反过来，返回 Promise 也不证明工作离开 event loop；同步 native 调用和 Promise 第一次 `await` 前的 JS
必须单独审计。Takumi 的静态 raster/SVG 核心计算确实位于 N-API `AsyncTask.compute()`，每个任务占一个进程共享的
libuv worker slot；animation 帧并行沿用上游 lazy owned Rayon pool，不是静态 render 的执行池。

Typst 文档会话是有状态例外：通过正式 NodeModules artifact 创建会话专用 Worker，maxSessions 限制线程数，session 队列限制更新；native compiler/VFS 保留增量状态。输入及可选模板快照在 session 接纳后准备，关闭或取消等待专用线程退出。详见 [Typst 设计](typst/DESIGN.md)。

## 输入所有权

- Runtime worker task 默认在 admission 时 `structuredClone`，适合调用方在返回 Promise 后立即复用或修改输入。
- `inputOwnership: 'borrowed'` 省略 admission clone，只保留 worker transport clone。调用方必须在 Promise settle 前不
  修改完整输入图；它不能和 `transfer` 同时使用。
- ECharts 使用 borrowed worker input，并在 public contract 中继承同一约束。它的 declarative option 先通过 bytes、
  values 和 depth 三个预算，遍历和单个大字符串计量都会 cooperative yield；`runPrepared()` 保证该遍历发生在
  shared fair admission 后，`postMessage` serialization 仍是有界宿主线程工作。
- Takumi 原样接收 JSX、HTML 或 node tree 与上游 options，不 clone React 函数，也不转换成自有输入格式。
  `*InWorker()` 只接受可序列化输入；业务 task 在 Worker 内构建 JSX 并使用 `/worker` adapter。React、组件执行与 JSX
  resolver 留在同一个 task bundle，缓存不保留 React dispatcher、Context、模板函数或调用方闭包。
- Takumi Markdown 只复制 extension 生成的 render-local asset bytes；document walk 与资产 copy 受自己的输入预算约束。
  TypstPlugin 输出 cloneable SVG bytes，通过 Markdown asset sink 进入同一次 Takumi image input。
- Canvas/Fonts 的 borrowed bytes 在 async 方法 settle 前不得修改。明确 `owned` 的 Canvas decode 永久接管 storage。

所有权模式只在确实消除大 copy 时公开；普通 immutable string、small metadata 和返回 snapshot 不增加平行模式。

## 预算顺序

Canvas、Fonts 与 ECharts 的受管资源按以下顺序收紧：

1. 同步检查 scalar、维度、pixel、数量和明显类型错误；
2. 检查 admission/owner queue，满载立即以稳定 busy error 拒绝；
3. 在已接纳任务内完成有界 snapshot，并在大 byte/tree walk 间 cooperative yield；
4. 在 native allocation/decode/render 前重新检查对应 resource policy；
5. 检查 encoded output，并把 caller-owned data 与 generation cache 分开。

Bytes 预算不能代替 count/depth 预算；count 预算也不能覆盖一个巨大 `ArrayBuffer`。各能力在自己的资源边界维护这些检查。
Markdown 只限制源文本、AST、HTML、代码块、公式与扩展资产。Takumi root options 的合法性、资源加载与编码由上游负责；
Worker options 只暴露可跨线程的部分，fetch callback、loader、Renderer 与 WASM module 不跨线程。应用业务准入由调用方负责。

## 取消和关闭

- queue 中的任务可以立即撤销，不开始 snapshot/native work；
- cooperative copy/walk 在 yield checkpoint 观察 signal；
- Runtime Worker cancellation 终止执行该 task 的线程；
- Takumi root 原样传递上游 `signal`；已经进入 native `compute()` 的 work 不可抢占，实际完成阶段遵循上游契约；
- Takumi `*InWorker()` 的 signal 交给共享 Workers；运行中取消终止该线程并使其所有缓存失效，native work 结束前仍占执行 slot；
- Markdown renderer 的 `close()` abort 本 handle 的任务并等待其 settle；公式编译通过 TypstPlugin 使用同一 signal；
- Canvas native image decode 已提交后不能真正取消，abort 只停止等待并丢弃迟到结果；
- Fonts native registry mutation 是短小、有 byte ceiling、不可取消的 commit 段。

受管能力的 deadline 覆盖自身声明的 queue/prepare/render 阶段，不能抢占已运行的 native work 或上游单次同步函数。
Canvas `*Sync()` 与 Fonts 最终 `GlobalFonts.register()` 必须继续受自身输入上限与基准监控；Takumi 原生入口的 JSX/HTML
准备执行在当前 realm，调用方需要根据真实模板验证其 event-loop 成本。Worker 入口仍有宿主 snapshot/transport 成本。

## 并发与容量

ECharts 使用 host-wide `workers.maxThreads/maxQueuedTasks/maxQueuedTasksPerPlugin`，不同 Worker consumer 共享公平预算。
Takumi 的原生调用不占 Host Worker slot；`*InWorker()` 与业务 JSX task 使用同一个 Host Worker pool。它们隔离 JSX/HTML、
CSS 与输入准备，同时 native work 仍与 filesystem、crypto、DNS 及其他 N-API work 共享进程 libuv pool。结合启动时的
`UV_THREADPOOL_SIZE` 验证吞吐；Worker 数量不等于额外的 native pool 容量。

Takumi `/worker` adapter 通过 ABI 版本化的 `Symbol.for` registry，在每个存活 Worker 内按真实 native Renderer constructor
与完整字体集的内容/metadata hash 复用 Renderer。不同字体集独立，避免同名 family 污染；每个 backend 的 Renderer 数量和
累计字体 bytes 使用有界 LRU，超大字体集只使用本任务的临时 Renderer。每个 Renderer 的图片、SVG 与 parsed CSS cache
另有 byte ceiling。具体常量由 Takumi worker runtime 源码拥有，不作为部署配置重复维护。

这个缓存归线程寿命，不归某个 Plugin generation。不同 artifact 通过同一个 adapter 协议和 backend identity 共享缓存，
各自保留自己的 React 与 JSX resolver。共享 pool 不提供 task affinity；同一个输入可能落到另一个线程，取消、idle retirement
或 Host 关闭都会清除对应线程的缓存。native glyph cache 由同一已加载的上游 native binary 在进程内共享。图片下载 bytes
与 Renderer 解码 cache 分开，不能将后者描述为跨请求的 HTTP cache。

Typst stateless SVG 编译只占 Host shared Worker 的独立 task slot；返回 SVG 后，Markdown 再调用 Takumi，Worker 不等待
Takumi native task。Typst 文档会话继续持有专用 Worker，生命周期与 stateless 编译分别结算。

Canvas 不创建 thread pool；root native decode 只用 package-local fair admission，并在不可取消 work 真正 settle 前保留
slot，默认并发 2。worker adapter 从 snapshot 建立独立 decode admission，默认每 adapter 并发 1；默认 4 个 Runtime workers
因而最多由 ECharts 同时提交 4 个 decode，而不是形成 4 × 4 的内层乘法。adapter 是 caller-owned resource，`close()` 拒绝
queued decode 并等待 held native work settle。ECharts 用 `decodeImageInto()` 把 bytes 直接写入同步 placeholder，避免同一
source native decode 两次；普通 image failure 会撤销 render-local scope，并在 worker handler 返回前完成上述 adapter close。
这些局部 admission 不能控制进程共享 libuv，也不能覆盖 raw Canvas surface 上直接调用的 encoder。Fonts 同样用 fair scheduler
约束 caller copy/read/hash，用 pending ceiling 约束 managed serialized tail，并用 provider native registration count/bytes
ceiling 约束累计 key。
需要任意 Canvas drawing 的业务 Plugin 应声明一个 worker task，在 artifact 内使用
`@pluxel/plugin-canvas/worker`；root `*Sync()` surface 只服务明确接受同步执行的小型 primitive 调用。

累计资源与单项资源必须同时有界：ECharts named themes 有 provider count/bytes ceiling，Fonts 有 native key ceiling。
ECharts 默认 root surface 与累计 decoded images 分别最多约 64 MiB raw RGBA；默认
4 个 active Worker 仍可能合计约 512 MiB raw pixels，且不含 encoded bytes、Skia 和 transient allocation。ECharts
encoded output 在返回前检查，且该检查不能撤销已发生的编码成本；decoded-pixel 检查同样不能撤销当前图片的 decode。

Canvas native capacity probe 使用 `vp run @pluxel/plugin-canvas#bench:native-capacity`；可再分别设置
`PLUXEL_CANVAS_BENCH_DECODE_CONCURRENCY=1` 与 `UV_THREADPOOL_SIZE=1`，观察 Promise 返回前同步耗时、event-loop timer gap、
filesystem queue delay 和 RSS delta。它是可重复诊断，不是跨机器固定阈值。

## 验证要求

功能测试之外，按本次改变的执行边界选择相应验证：

- Worker-only API 不重新出现 inline fallback；
- queue full 在大 snapshot 前拒绝；
- borrowed/snapshot/transfer ownership 与实际 mutation/detach 行为一致；
- 大 byte snapshot 会在 checkpoint 响应 abort；
- max 合法输入的 event-loop delay、peak RSS 和 throughput 有基准数据；
- Fonts revision、worker realm cache 和 Plugin replacement 不跨 generation 回写；
- Takumi root 的 JSX、HTML、node tree、SVG、animation 和原生错误穿过 Plugin 入口后保持上游契约；
- Takumi 官方 task 与两个自包含业务 task 在同一 Worker 复用同 backend/字体集；字体差异、缓存上限、取消与重建分别验证；
- 真实 HeroUI 组件在 Worker 中构造 JSX，使用同 bundle 的 React resolver；
- Markdown 的 Worker render options、可选 Typst provider 与 SVG 资产能完成一次真实渲染。
