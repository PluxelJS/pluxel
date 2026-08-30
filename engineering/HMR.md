# HMR Architecture

HMR 是 Plugin definition replacement，不是对运行中 instance 的字段修补。Module、Core graph、owner effects、
Workbench publication 和构建产物必须按一个确定边界切换。

## Definition replacement

Source/module 变化以 `PluginDefinitionSlot` 为 invalidation unit。同一 definition 的 default 与已创建 forks 在同一个
graph commit plan 中 replacement，保留各自 node address/slot 和 config；不能逐 fork 发布而留下 mixed constructor
generation。UI producer build input 按 definition/declaration 共享，不含 `forkId`；node publication 与 generation lease
仍隔离。身份作用域见 [`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md#各领域作用域)。

```text
module batch
  -> immutable catalog candidate
  -> coordinator prepare/commit
  -> stop old consumer/provider closure
  -> drain effects
  -> start new generations
  -> publish new Workbench Definitions
  -> build/validate MF producer candidate
  -> commit producer inventory
  -> close browser socket epoch
  -> full document reload
```

Route 对新 module namespace 只消费一个 immutable candidate，并把整批 catalog snapshot 交给 runtime-common
coordinator。Coordinator 在旧 generation 仍开放时完成 role/collision、forkability、binding 和 combined graph prepare；
catalog/RuntimeState revision race 会丢弃 prepared overlay 并重新 plan。

Structural reject 保留旧 catalog revision。第一次关闭旧 generation admission 是 point of no return；之后的 drain/init
failure 形成新 revision 的 lifecycle facts，不尝试复活旧 implementation。Optional provider 出现、消失或 replacement
也走同一个 consumer closure stop/start plan。

Database handle 固定引用一个 active instance。Replacement 先拒绝旧 handle 的新操作并等待已接纳操作排空；同 lineage
新 generation 复用 instance，schema-derived lineage 改变时构建空 candidate 并原子激活。Database backend、pool、instance
registry 和 durable rows 属于 root。

## Canonical Vite module graph

每个 `ViteDevServer` 只有一个 Pluxel SSR ModuleRunner 和 evaluated module namespace。Static application、dynamic
config、fixed plugins、mutable source anchors 和普通 ESM dependencies 都通过该实例求值；HMR layer 只增加分类、
invalidation、source anchor 和诊断，不创建第二个 cache。

Core、Runtime 与 Elysia host bridge 是 singleton identity 边界。Public、internal 和 workspace source path 都必须解析到
host 安装的 ESM entry；解析使用 import conditions，不能通过 CJS path 冒充 ESM singleton。Standalone
`@pluxel/context` 只有 host 直接安装时才进入 bridge。

Runtime-dev classifier 固定优先级：

1. host bridge singleton；
2. CommonJS/native package 保留在 Node host；
3. workspace ESM source 进入 Vite transform/HMR graph。

Bare specifier 与 `/@fs/` 边界使用同一 classifier，workspace alias 不能绕过分类。Project 不注入第二份 Vite
`InlineConfig` 或自定义 bridge policy。

## Static 与 dynamic route

`staticRuntimeVitePlugin({ entry })` 通过 ModuleRunner 加载 canonical `defineStaticRuntime()` entry。普通 Plugin
dependency 变化精确失效 importer graph；application entry/configure graph 变化重建 host。Single-active logging root
要求先停止旧 host；新 application start 失败时可以从上一次成功 application definition 创建一个新 host，以便开发服务器
继续重试，但不会保留旧 running generation。

Dynamic route 先提交 fixed baseline，再处理显式 mutable sources。Source 只接受精确文件或不能逃逸 source directory 的
正向 include glob，结果最多 10,000 entries。Initial discovery 与 watcher add/change/unlink 共用同一 batch 路径；
普通 import dependency 变化沿 importer graph 回到 source anchor。

Dynamic host 的扫描、存储、module resolution 与日志路径都显式锚定 resolved `root`。启动和 replacement 不得调用
`process.chdir()`；同进程 Vite 持有自己的 config/root 解析上下文，Plugin 中明确声明为“相对当前工作目录”的路径则继续以
launcher cwd 为准。两者不同时，宿主配置应传绝对 Plugin 数据路径。

Source producer 只原子发布普通 ESM entry；package acquisition、lockfile、registry、安装状态、RPC 和 UI 都属于 producer
Plugin。Dynamic batch 拥有一次 update 内的 unpublished draft，commit 后唯一 authority 是 coordinator immutable snapshot。
不保留第二份 committed registry 或 post-commit route callback。

Shutdown 顺序是：停止 watcher/batch admission → 丢弃未开始 debounce → 等待 active batch → Core lifecycle/effects
cleanup → Vite hooks → ModuleRunner close。

## Workbench producer build

`PluginArtifactCompiler` 位于 `packages/runtime-dev/src/workbench/`。Route attachment 总是可以安装 Node source provider，
只在 Workbench enabled 时安装 UI source provider；Workbench-disabled 路径不加载 MF builder。

Semantic lowering 在 TypeScript 擦除前读取 `workbench.define()` 和 literal `workbench.entry()`，一次生成 owning Plugin
definition 的完整 producer plan。Compiler 不重新发现 declarations 或计算第二个 build revision。

同一 producer task 去重；同一 definition 的新 plan supersede 旧 in-flight build。不同 producer 的 source hash、图准备和
cache lookup 可以并行，实际 `@module-federation/vite` builder 位于 process-wide exclusive section，因为当前上游 Vite
integration 仍包含 module-scoped normalized config、virtual module registry 和 caches。只有真实并发回归证明这些状态已
归属 MF instance 后才可缩小临界区；同 output transaction ordering 始终保留。

每个 candidate 必须验证：

- producer name 和 build revision；
- `mf-manifest.json` 与标准 Snapshot；
- exact `./views/<key>` expose inventory；
- `remoteEntry.js`、全部 JS/CSS/type files 均存在；
- fixed singleton shared 包和 exact versions；
- generated React Bridge declaration identity。

验证失败不提交。成功 candidate 原子进入 `WorkbenchArtifactService` 的 immutable producer inventory；production freezer
写入同构的 `pluxel-workbench-producers.json`，runtime 不从 source 重新编译。

## Browser update policy

Workbench 不实现页内 remote HMR。Producer inventory commit 或 Plugin publication epoch 改变后：

1. Server invalidates current Cap’n Web session；
2. Shell destroy active Bridges 并 dispose opened handles；
3. 当前 document 显示 reload boundary；
4. 新 document 创建一条新 socket、重新认证/bootstrap、读取 layout；
5. MF Runtime 加载 pinned new manifest/expose 并创建 fresh roots/Bridge。

旧 document 不注册新 remote，不把新 roots 接到旧 renderer，不保存 old remote fallback。Candidate build failure 不会
推进 inventory 或 reload。Vite HMR socket 可以作为 toolchain update signal carrier，但 Workbench 产品动作仍是 full reload。

## Node module update

Node module declaration 保持独立 artifact lifecycle。`ctx.nodeModules.use()` 对每个 consumer 串行 staged setup：新 setup
成功后才 cleanup previous；失败保留 last-known-good。Owner stop 使 pending generation 失效，迟到 setup cleanup 立即执行。
Worker task 的新 dispatch 读取 content-addressed 新 module URL，已运行 task 继续使用原 module；取消/stop 仍等待真实 worker
退出。

## 验证

- definition-wide default/fork replacement 不出现 mixed constructor generation；
- structural reject 保留旧 catalog，PONR 后 failure 只报告 lifecycle facts；
- optional provider replacement 正确重启 consumer closure；
- database accepted operations 在 replacement 前 drain；
- static/dynamic 共享一个 ModuleRunner 与 source classifier；
- dynamic host generation 不改变 Vite 进程 cwd；
- Workbench candidate failure 保持当前 inventory；
- stale/superseded producer 不能 commit；
- successful producer commit 关闭 socket epoch 并触发 full reload；
- 新 document 不复用旧 roots、Bridge、host facade 或 MF registration；
- Workbench-disabled host 不加载 MF builder；
- Node module staged setup 保持 last-known-good。
