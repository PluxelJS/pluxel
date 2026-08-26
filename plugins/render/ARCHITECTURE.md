# Render execution architecture

`plugins/render/*` 共享资源模型，但不共享一种虚假的“所有 render 都进 Worker”规则。执行位置由真正占用
JavaScript event loop 的工作决定：同步 JS/native 计算进入 Worker，已经由 N-API 异步提交的计算留在原
realm，进程级 registry 留在唯一资源 owner。每条路径都必须显式描述仍在宿主线程执行的有界工作。

## 能力与执行边界

```text
FontsPlugin (process resource owner)
   ├─ CanvasPlugin (explicit synchronous primitives + worker adapters)
   │      └─ EChartsPlugin (worker-only renderer)
   └─ TakumiPlugin (bounded/cooperative JS preparation + async native renderer)
```

| 能力        | 宿主线程                                                                                          | Worker/native 边界                                                       | Admission owner                  |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Fonts       | lifecycle、metadata、最终 native registry mutation                                                | bounded 文件 IO 与大 byte snapshot/hash/record copy 是 async/cooperative | Fonts generation fair scheduler  |
| Canvas root | 名称带 `Sync` 的 allocation/drawing/text primitive                                                | `decodeImage()` native async；`./worker` adapter 供独立 task 使用        | Canvas generation fair scheduler |
| ECharts     | 小型 contract validation、含大字符串的 cooperative option walk、有界 transport serialization      | layout、ZRender、image decode、encode 全部在共享 Worker                  | Runtime root worker pool         |
| Takumi      | `fromHtml()`、borrowed graph validation、cooperative preparation、N-API input/stylesheet lowering | raster/SVG/font registration 使用共享 libuv pool 的 N-API async work     | Takumi generation fair scheduler |

Worker 是 event-loop isolation 和统一 thread admission，不是安全边界。native crash、内存分配和 CPU 饱和仍可影响
整个进程。反过来，返回 Promise 也不证明工作离开 event loop；同步 native 调用和 Promise 第一次 `await` 前的 JS
必须单独审计。Takumi 的静态 raster/SVG 核心计算确实位于 N-API `AsyncTask.compute()`，每个任务占一个进程共享的
libuv worker slot；上游另有 lazy owned Rayon pool，但只供本 Plugin 未暴露的 animation 帧并行，不是静态 render 的执行池。

## 输入所有权

- Runtime worker task 默认在 admission 时 `structuredClone`，适合调用方在返回 Promise 后立即复用或修改输入。
- `inputOwnership: 'borrowed'` 省略 admission clone，只保留 worker transport clone。调用方必须在 Promise settle 前不
  修改完整输入图；它不能和 `transfer` 同时使用。
- ECharts 使用 borrowed worker input，并在 public contract 中继承同一约束。它的 declarative option 先通过 bytes、
  values 和 depth 三个预算，遍历和单个大字符串计量都会 cooperative yield；`runPrepared()` 保证该遍历发生在
  shared fair admission 后，`postMessage` serialization 仍是有界宿主线程工作。
- Takumi 的 content、stylesheets 和 images 同样借用到 render settle。结构化 content 验证后直接使用 borrowed graph，不做
  第二次同步 clone；重 byte copy 和 UTF-8 计量发生在 fair scheduler admission 之后，并按固定内部 chunk 让出 event loop。
- Canvas/Fonts 的 borrowed bytes 在 async 方法 settle 前不得修改。明确 `owned` 的 Canvas decode 永久接管 storage。

所有权模式只在确实消除大 copy 时公开；普通 immutable string、small metadata 和返回 snapshot 不增加平行模式。

## 预算顺序

一次工作按以下顺序收紧：

1. 同步检查 scalar、维度、pixel、数量和明显类型错误；
2. 检查 admission/owner queue，满载立即以稳定 busy error 拒绝；
3. 在已接纳任务内完成有界 snapshot，并在大 byte/tree walk 间 cooperative yield；
4. 在 native allocation/decode/render 前重新检查对应 resource policy；
5. 检查 encoded output，并把 caller-owned data 与 generation cache 分开。

Bytes 预算不能代替 count/depth 预算：大量空数组、空 stylesheet 或短 image entry 仍会放大 JS 遍历。反过来，count
预算也不能覆盖一个巨大 `ArrayBuffer`。renderer config 因而同时限制 dimensions、pixels、bytes、count 和 depth。

## 取消和关闭

- queue 中的任务可以立即撤销，不开始 snapshot/native work；
- cooperative copy/walk 在 yield checkpoint 观察 signal；
- Runtime Worker cancellation 终止执行该 task 的线程；
- Takumi 把 signal 交给 native renderer；尚未开始的 N-API work 可撤销，已经进入 `compute()` 的 work 不可抢占，Plugin
  保留 admission slot，等待它结束后丢弃结果；shared font build 只接受 generation cancellation，不绑定任一 caller；
- Canvas native image decode 已提交后不能真正取消，abort 只停止等待并丢弃迟到结果；
- Fonts native registry mutation 是短小、有 byte ceiling、不可取消的 commit 段。

deadline 从 queue 开始计时并覆盖 prepare/render 的结果有效期，但不能抢占已经运行的 native work 或上游单次同步函数。
Takumi `fromHtml()`、Canvas `*Sync()` 和 Fonts 最终 `GlobalFonts.register()` 因此必须继续受输入上限与基准监控。

## 并发与容量

ECharts 使用 host-wide `workers.maxThreads/maxQueuedTasks/maxQueuedTasksPerPlugin`，不同 Worker consumer 共享公平预算。
Takumi 不占用 Worker slot；其 `maxConcurrentRenders/maxQueuedRenders/maxQueuedRendersPerConsumer` 约束占用进程共享
libuv pool 的 native work。默认并发为 2，给 Node 的 filesystem、crypto、DNS 和其他 N-API work 留出默认 pool 容量；
高吞吐 host 应联合设置启动时的 `UV_THREADPOOL_SIZE` 与 Plugin 并发，而不是只提高一个上限。把 Takumi 再套进 Worker
仍会占用同一 libuv slot，并额外占住 Runtime Worker，因此不解决这种竞争。

Canvas 不创建 thread pool；root native decode 只用 package-local fair admission，并在不可取消 work 真正 settle 前保留
slot，默认并发 2。worker adapter 从 snapshot 建立独立 decode admission，默认每 adapter 并发 1；默认 4 个 Runtime workers
因而最多由 ECharts 同时提交 4 个 decode，而不是形成 4 × 4 的内层乘法。adapter 是 caller-owned resource，`close()` 拒绝
queued decode 并等待 held native work settle。ECharts 用 `decodeImageInto()` 把 bytes 直接写入同步 placeholder，避免同一
source native decode 两次；普通 image failure 会撤销 render-local scope，并在 worker handler 返回前完成上述 adapter close。
这些局部 admission 不能控制进程共享 libuv，也不能覆盖 raw Canvas surface 上直接调用的 encoder。Fonts 同样用 fair scheduler
约束 caller copy/read/hash，用 pending ceiling 约束 managed serialized tail，并用 provider native registration count/bytes
ceiling 约束累计 key。
需要任意 Canvas drawing 的业务 Plugin 应声明一个 worker task，在 artifact 内使用
`@pluxel/canvas/worker`；root `*Sync()` surface 只服务明确接受同步执行的小型 primitive 调用。

累计资源与单项资源必须同时有界：ECharts named themes 有 provider count/bytes ceiling，Fonts 有 native key ceiling，Takumi
portable fonts 有 count/bytes ceiling。ECharts 默认 root surface 与累计 decoded images 分别最多约 64 MiB raw RGBA；默认
4 个 active Worker 仍可能合计约 512 MiB raw pixels，且不含 encoded bytes、Skia 和 transient allocation。ECharts/Takumi
encoded output 都在返回前检查，且明确该检查不能撤销已发生的编码成本；decoded-pixel 检查同样不能撤销当前图片的 decode。

Canvas native capacity probe 使用 `pnpm --filter @pluxel/canvas bench:native-capacity`；可再分别设置
`PLUXEL_CANVAS_BENCH_DECODE_CONCURRENCY=1` 与 `UV_THREADPOOL_SIZE=1`，观察 Promise 返回前同步耗时、event-loop timer gap、
filesystem queue delay 和 RSS delta。它是可重复诊断，不是跨机器固定阈值。

## 验证要求

功能测试之外，变更执行边界时至少验证：

- Worker-only API 不重新出现 inline fallback；
- queue full 在大 snapshot 前拒绝；
- borrowed/snapshot/transfer ownership 与实际 mutation/detach 行为一致；
- 大 byte snapshot 会在 checkpoint 响应 abort；
- max 合法输入的 event-loop delay、peak RSS 和 throughput 有基准数据；
- Fonts revision、worker realm cache、Takumi renderer build 和 Plugin replacement 不跨 generation 回写。
