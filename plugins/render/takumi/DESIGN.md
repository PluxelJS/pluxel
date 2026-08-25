# Takumi Plugin 设计

`@pluxel/takumi` 是独立 renderer Plugin，不是 Canvas adapter，也不是 Pluxel runtime 特例。它只通过
`FontsPlugin` 的公开 capability、BasePlugin config、caller Context/effects 和可选 Workbench Port 组成。

## Pluxel 能力映射

- constructor required dependency 保证 FontsPlugin 先恢复 managed collection，provider failure 按正常 graph
  语义阻塞 Takumi 与 dependents；
- dependency caller facade 让每个消费方得到独立 caller Context，Takumi lease、AbortController 与 queue owner
  绑定该 Context effects；consumer stop/replacement 会取消等待和 native render；
- Plugin config 持有 host ceilings，renderer、font revision cache、queue 和 native task 属于 generation state；
- `ctx.workbench?.mount()` 只挂载 portable Fonts Selection Port，Workbench disabled 不影响字体 replay 或 render；
- prototype methods 是唯一跨 Plugin callable surface，返回值是 caller-owned data，不暴露 raw Renderer、registry 或 queue。

这些现有能力已经覆盖 graph ordering、ownership、withdrawal、config、diagnostics 与可选 UI。Takumi 暴露出的缺口是
FontsPlugin 原来只投影 Canvas `GlobalFonts` family metadata，无法把 provider-owned bytes 交给第二种 native registry。
该问题属于字体 package 的跨 renderer 业务 contract，因此新增 `portableFonts` + `readPortableFont()`，而不向
core/runtime 添加 Takumi/font 专用 Context capability。

## 字体 revision 与资源所有权

FontsPlugin 为 managed 和 caller registration 保存内容寻址 source，metadata snapshot 可重复读取且不复制 bytes；
`readPortableFont()` 才返回 detached copy。相同 content/family ID 使用引用计数，最后一个 registration 释放时才改变
portable revision。system fonts 没有 provider-owned source，因此不进入该投影。

TakumiPlugin 按 portable revision 去重 renderer build。一个 build 先同步取得全部 byte copies，再顺序调用上游
`registerFont()`；并发 render 共享同一 promise。新 revision 准备成功后原子成为 current state，旧 state 只由已经
接纳的 render 引用，完成后可由 GC 回收。这样弥补 Takumi registry 没有 unregister API 的事实，不把 stale font
伪装成已撤销资源。`maxFontBytes` 在复制前检查整个 snapshot，避免 Fonts 的合法大集合无界倍增到另一个 native backend。

默认 family 只重排已经由 Takumi 成功注册的 portable families。不可移植 system selection 不会被当成已加载字体；
Takumi 自己的 embedded last-resort 保持最终 fallback。Workbench outlet 使用 `selectionManager('portable')`，不会向用户
展示点击后无法加载的 system candidate。Fonts canonical 管理页面仍显示并管理完整 collection。

## 执行、队列与取消

Takumi N-API 使用真正异步的 native task。按照 Pluxel worker 边界，它继续使用原 API，不进入只为长时间阻塞 JS
event loop 的 `ctx.workers`；否则会同时占用 Pluxel worker 与 Takumi/libuv native slot，增加一次 clone/dispatch 和两层
线程预算。package-local scheduler 只负责 admission：固定并发、global/per-owner queue 上限和 owner round-robin；
generation config 的 wall-clock deadline 覆盖 queue、准备与 native render，避免卡住的任务永久占用 slot。

调用前同步 snapshot node tree、stylesheets 和 image bytes，避免 queued task 观察调用方后续 mutation；node 内拒绝
structured clone 仍会共享的 `SharedArrayBuffer` view，显式 `images` bytes 则总是复制。caller/explicit
signals 合成为一次 signal；queued item 取消会 O(1) 释放 owner slot，running task 把 signal 交给 Takumi。Fonts
registration 按 revision 在 generation 内共享，不能安全地绑定任一 caller signal，而且 Takumi 发布包装器的注册入口当前
不接受 signal。generation signal 会在 registration 之间或完成后的 checkpoint 停止 build；generation-local cache 保证旧
build 不能回写下一代 renderer state。

## 输入、IO 与预算

公开 content 只接受 HTML string 或 structured-clone-compatible Takumi `Node`。JSX/function component 可能执行任意异步
业务代码，无法在 queue admission 时形成诚实 snapshot；需要 JSX 的 caller 先用 Takumi helper 归一化成 Node，再提交。
Plugin 在 render 前检查 node count、depth、text length、inline/preloaded image bytes、stylesheet bytes、physical dimensions
和 pixels；structured node 的字符串与结构负载和 HTML 共用 `maxContentBytes`，避免 inline style/attributes 绕过内容预算。
render 后检查 encoded/UTF-8 output bytes。

`prepareImages()` 只用于枚举 remote references，并带 `allowUrl: () => false` 与 caller-provided sources；不会调用
global fetch。解码后的图片内存仍由 Takumi cache/pixel implementation拥有，byte ceiling 不是安全 sandbox；native crash
仍可终止进程。

## 有意不包含

- raw `Renderer`、global glyph cache 或 Takumi thread-pool tuning；
- 从 system family 反查平台私有 font path 的第二套 scanner；
- 隐式 URL/font fetch、Google Fonts helper或 Twemoji CDN；
- 为 Takumi 增加 Runtime capability、worker artifact 或 package aggregator；
- JSX component execution与 animation API。出现真实调用方后，应先定义 snapshot、duration/frame budget 与取消语义再扩展。
