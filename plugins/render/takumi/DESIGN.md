# Takumi Plugin 设计

`@pluxel/takumi` 是独立 renderer Plugin，不是 Canvas adapter，也不是 Pluxel runtime 特例。它只通过
`FontsPlugin` 的公开 capability、BasePlugin config、caller Context/effects 和可选 Workbench Attachment 组成。

## Pluxel 能力映射

- constructor required dependency 保证 FontsPlugin 先恢复 managed collection，provider failure 按正常 graph
  语义阻塞 Takumi 与 dependents；
- dependency caller facade 让每个消费方得到独立 caller Context，Takumi lease、AbortController 与 queue owner
  绑定该 Context effects；consumer stop/replacement 会取消等待和 native render；
- Plugin config 持有 host ceilings，renderer、font revision cache、queue 和 native task 属于 generation state；
- `ctx.workbench?.publish()` 只放置 provider-owned Fonts selection Attachment，Workbench disabled 不影响字体 replay 或 render；
- prototype methods 是唯一跨 Plugin callable surface，返回值是 caller-owned data，不暴露 raw Renderer、registry 或 queue。

这些现有能力已经覆盖 graph ordering、ownership、withdrawal、config、diagnostics 与可选 UI。Takumi 暴露出的缺口是
FontsPlugin 原来只投影 Canvas `GlobalFonts` family metadata，无法把 provider-owned bytes 交给第二种 native registry。
该问题属于字体 package 的跨 renderer 业务 contract，因此新增 `portableFonts` + `readPortableFont()`，而不向
core/runtime 添加 Takumi/font 专用 Context capability。

## 字体 revision 与资源所有权

FontsPlugin 为 managed 和 caller registration 保存内容寻址 source，metadata snapshot 可重复读取且不复制 bytes；
`readPortableFont()` 才返回 detached copy。相同 content/family ID 使用引用计数，最后一个 registration 释放时才改变
portable revision。system fonts 没有 provider-owned source，因此不进入该投影。

TakumiPlugin 按 portable revision 去重 renderer build。一个 build 顺序、cooperative 地取得 detached byte copies，再调用上游
`registerFont()`；并发 render 共享同一 promise。新 revision 准备成功后原子成为 current state，旧 state 只由已经
接纳的 render 引用，完成后可由 GC 回收。这样弥补 Takumi registry 没有 unregister API 的事实，不把 stale font
伪装成已撤销资源。`maxFonts` 与 `maxFontBytes` 在复制前检查整个 snapshot，避免大量小字体或大 byte 集合无界倍增到
另一个 native backend。

默认 family 只重排已经由 Takumi 成功注册的 portable families。不可移植 system selection 不会被当成已加载字体；
Takumi 自己的 embedded last-resort 保持最终 fallback。Workbench Attachment 使用 Fonts provider 的完整 selector；
portable filtering 保持 Takumi runtime policy，不通过无状态 consumer target 或第二个 Workbench collection 表达。

## 执行、队列与取消

Takumi 的 raster/SVG/font N-API 方法返回 napi-rs `AsyncTask`：JS-to-Rust 输入反序列化、stylesheet cache parse 与 task
建立仍在宿主线程，`Task.compute()` 则通过 `napi_queue_async_work` 占用进程共享的 libuv pool。Takumi 另有 lazy owned Rayon pool，但只在
本 Plugin 未暴露的 animation `compute()` 内并行帧渲染/编码，静态 raster/SVG 不使用它。按照 Pluxel worker 边界，
本 Plugin 继续使用原 API，不进入 `ctx.workers`；否则仍占一个共享 libuv slot，同时额外占用 Runtime Worker，并增加
一次 clone/dispatch。package-local scheduler 只负责 admission：默认并发 2、global/per-owner queue 上限和 owner
round-robin；默认不吃满 Node 的 4-slot libuv pool，host 可以结合启动时的 `UV_THREADPOOL_SIZE` 调整吞吐。
provider cleanup 会 abort generation/caller signals、拒绝 queued render，并等待所有已接纳 Promise settle 后才完成
generation 交接。

content、stylesheets 和 image bytes 在 render settle 前按 borrowed contract 保持不变。整个 snapshot/prepare/native
链先进入 package scheduler，queue full 不先复制资源；大 image/font copy 和 tree walk 在固定 checkpoint 让出 event loop。
node image 只接受 string source，所有 byte source 统一进入有 count/bytes ceiling 的 `images` 路径，避免
同步复制 inline buffer。结构化 node 在 admission 后验证 declarative shape/预算，但继续按 borrowed contract 直接使用，
不再额外执行一次同步 `structuredClone()`。caller/explicit
signals 合成为一次 signal；queued item 取消会 O(1) 释放 owner slot。尚未执行的 N-API async work 可以取消；一旦
`Task.compute()` 已运行，Node N-API 不提供抢占，Plugin 会保留 admission slot，等 native work settle 后拒绝 caller 并
丢弃结果。deadline 表示从 queue 开始的结果有效期，不承诺强制终止 native CPU work。Fonts
registration 按 revision 在 generation 内共享，不能安全地绑定任一 caller signal，而且 Takumi 发布包装器的注册入口当前
不接受 signal。generation signal 会在 registration 之间或完成后的 checkpoint 停止 build；generation-local cache 保证旧
build 不能回写下一代 renderer state。

### Document-adapter reservation

`reserveRender()` 是给有真实准备阶段的 document adapter 的最小 public seam。它先走已有 caller-aware fair scheduler，只有
取得一个 slot 后才返回 one-shot reservation；因此满队列不会先执行 Markdown parse、code highlight、asset copy 或 Typst worker
dispatch。reservation 固定 generation/caller/deadline 的 linked signal 与只读 render ceilings，只允许互斥的一次 `render()` 或
`renderSvg()`。

未 commit 时 `close()` 使 reservation task settle，立刻归还 slot。已 commit 时 `close()` / caller abort 会让 caller-visible
结果取消，但 task 继续等待 `executeRaster`/`executeSvg` 的真实 native settlement 后才让 scheduler 归还 capacity。这个区别避免
replacement work 与仍在 libuv `compute()` 中的 native work 重叠。它不暴露 scheduler、queue owner、native Renderer 或可重复使用
的 permit；普通业务仍使用 convenience render 方法。`@pluxel/takumi-markdown` 是该 seam 的具体消费者。

`fromHtml()` 是上游同步 parser，单次调用期间无法被 scheduler 或 AbortSignal 抢占；默认 1 MiB content ceiling、总
stylesheet/node/text/image-source 预算和 wall-clock benchmark 共同限制这段剩余 host-thread 风险。把完整 Takumi render 再套
一层 Worker 会重复占用 Worker 与 Takumi/libuv native slot 并复制字体/输入，因此当前边界保留这个明确、受限的同步段。

## 输入、IO 与预算

公开 content 只接受 HTML string 或 declarative Takumi `Node`。JSX/function component 可能执行任意异步
业务代码，无法在 queue admission 时形成诚实 snapshot；需要 JSX 的 caller 先用 Takumi helper 归一化成 Node，再提交。
Plugin 在 render 前检查 node count、depth、text length、distinct image-source count、image bytes、stylesheet count/bytes、
physical dimensions 和 pixels；structured node 的字符串与结构负载和 HTML 共用 `maxContentBytes`，避免 inline
style/attributes 绕过内容预算。
render 后检查 encoded/UTF-8 output bytes；大 HTML、node string、stylesheet 与 SVG output 的 UTF-8 计量分片让出 event loop。

`prepareImages()` 只用于枚举 remote references，并带 `allowUrl: () => false` 与 caller-provided sources；不会调用
global fetch。解码后的图片内存仍由 Takumi cache/pixel implementation 拥有，byte ceiling 不是安全 sandbox；native crash
仍可终止进程。

## 有意不包含

- raw `Renderer`、global glyph cache 或 Takumi thread-pool tuning；
- 从 system family 反查平台私有 font path 的第二套 scanner；
- 隐式 URL/font fetch、Google Fonts helper 或 Twemoji CDN；
- 为 Takumi 增加 Runtime capability、worker artifact 或 package aggregator；
- JSX component execution 与 animation API。出现真实调用方后，应先定义 snapshot、duration/frame budget 与取消语义再扩展。
