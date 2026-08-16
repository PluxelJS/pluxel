# Plugin System Architecture

本文定义当前插件系统边界。作者用法以 [`user-docs/getting-started/index.md`](../user-docs/getting-started/index.md)
为准。

```text
plugin source
	├─ constructor dependencies
	├─ optional Plugin refs and one object config declaration
	├─ separately-built Node module / worker task declarations
	└─ Workbench Contract / Extension declarations
          ↓
@pluxel/core: committed graph / DI / lifecycle / effects
          ↓
@pluxel/runtime: HTTP / persistence / config / commands / optional capabilities
          ↓
static or dynamic route: catalog / Vite / HMR / host policy
          ↓
optional Workbench Plane: target layout / artifacts / bound resources
```

## 依赖与组成

| 意图                 | API                                      | 生命周期含义                 |
| -------------------- | ---------------------------------------- | ---------------------------- |
| required plugin      | constructor parameter                    | provider 失败会阻塞 consumer |
| optional plugin      | `definePluginRef<T>()` + `plugins.use()` | provider 变化时重启 consumer |
| internal composition | 普通 class/function + owner effects      | 随 owner generation 回收     |

constructor 是 required dependency 的唯一作者声明。required 使用目标 package 根入口的 value import；optional 使用
目标 Plugin 的 type-only root import 和 non-exported module-level ref。两者都由 semantic pass lower 成 definition slot edge。
static/dynamic route 必须读取同一 committed core graph；Workbench resolver 不依赖 loader 私有图。

宿主修改 runtime dependency override 时，commit 必须重启被修改 plugin 与其 dependent closure。只重建 provider
而保留 dependent 的旧 caller-bound view 会破坏 Context isolation，并让 Workbench 中的实现选择表面成功、实际继续
调用旧 provider。

`PluginRef<T>` 是 opaque author declaration，只能由工具链从目标 root named export 的 type provenance lower。ref 不
import、安装、注册或默认启用 package。`plugins.use(Ref, callback)` 只允许作为 `init()` 中的直接语句，callback 必须
同步且返回的 cleanup/disposable 自动进入 consumer effects。provider absent、disabled 或 start-failed 时 callback 不执行，
但不阻塞 consumer；running generation 出现、消失或 replacement 时，core 把 consumer 及其 required dependent closure
合并进一次 restart plan。required/optional ordering edge 的合并图必须无环。

## Identity 与入口

具体 Plugin definition 的唯一身份是 opaque `PluginDefinitionSlot(canonical entry, root named export)`；runtime node 是
`PluginNodeSlot(definition, default | forkId)`。class name、constructor object、package display name 和
`@Plugin({ displayName })` 都不是 graph、state、config、logging、Workbench 或 HMR identity。

跨进程和持久化边界使用经过校验的结构化 address snapshot：entry 只允许 `package-root` 或 `source-entry`，definition
增加 `exportName`，node 再增加 `instance: 'default'` 或结构化 fork。Core intern address 后只按 slot object 查图，不把
address 拼成作者协议。不同 package/export 的同名 class 或相同 `displayName` 可以共存；Workbench 用
`displayName ?? rootExportName` 和 package/export provenance 展示、消歧。

一个具体插件包只有一个 plugin-bearing entry：package root `"."`。根入口可以唯一 named-export 多个 Plugin；同一
constructor 的多个根名称、plugin-bearing subpath 与跨包 Plugin re-export 都由 build 拒绝。Workbench、worker、contract
等 plugin-free subpath 只在确有独立消费边界时保留。

## 生命周期与资源

core commit 顺序为 `draft graph -> verify -> stop plan -> start plan -> CommitSummary`。provider 先启动、
consumer 先停止；失败插件不进入 running，required dependents 被阻塞。generation 停止时先关闭 owner invocation
gate、abort generation，再 drain effects。正常停止、init rollback、replacement、optional restart 与 root shutdown
没有第二条 Plugin teardown hook。

Workbench mount 从 Context 推导 owner 并绑定 owner effects。contribution 只有在 owner 真正 running 后才进入
layout；init 失败不会留下可见 View 或 resource。HMR replacement 会撤销旧 layout binding、factory、stream、
live query 和 grant；rollback 通过重新 mount 获得新 lease。

constructor 注入的 dependency 是覆盖 `ctx.caller` 的轻量 prototype view。顶层字段读取会委托 provider instance，
但在 caller method 中直接给 `this.someField` 赋值会落到当前 view。provider-wide mutable state 因此放在 constructor
创建的稳定 state/registry 对象中并修改其内容；caller-owned state 继续以 `Context` 为 key。不要用顶层标量赋值暗中
表达共享 mutation，也不要依赖可变全局 current caller。

第三方库只有不可撤销的进程级 registration/platform callback 时，全局部分只保存稳定且在无 active scope 时 inert 的
路由实现；caller registration、mutable resource 与 cleanup 继续保存在以 `Context` 为 key 的 registry。并发异步调用
使用平台原生 async context 传递 invocation scope，不使用可变 module-level current owner。若第三方 API 接受对象而非
全局名称，优先直接传 caller-owned snapshot，避免把无法 unregister 的外部表伪装成可回收 Pluxel resource。

`ctx.database.use()` 保留 immutable plugin owner，并在返回 handle 前解析 active database instance、完成 migration prepare。
handle 只允许短生命周期 `read()` 与完整 `transaction()` callback；stop/replacement 撤销旧 generation handle。默认
`migrations` evolution 用 checked immutable history；显式 `reset-on-schema-change` 由 compiler 从 schema snapshot 派生 lineage，
不要求作者维护 history。同 lineage 复用 active instance，新 lineage 原子激活 candidate 并归档旧 instance，不删除旧数据。

`ctx.commands.register()` 共享一个 root command catalog，但注册所有权属于调用插件的 Context。registration 会进入
owner effects，因此 generation stop、replacement、start rollback 和 shutdown 都会撤销对应命令。runtime registration
同时保留 owner invocation lease；generation 停止时先拒绝新调用、abort call/owner 合成 signal，并等待已接纳调用退出，
再 drain generation effects。此前取得的 command wrapper 也不能越过已关闭的 owner gate。手动 dispose 单个 registration 只撤销
publication，不取消已经开始的调用。runtime 自身固定注册基础插件查询与生命周期命令，这些 handler 只调用既有
runtime use case，不复制 graph 或 commit 逻辑。

## Optional Workbench Plane

插件只看到 `ctx.workbench.enabled` 和 `ctx.workbench.mount()`。宿主通过顶层 `workbench` 配置安装
backend。disabled 时不创建 registry、compiler、watcher、route 或 transport，mount 返回 `undefined`。

browser-safe `WorkbenchContract` 声明 resource、View、placement 和 Port；server-only `WorkbenchExtension`
只绑定 Contract 与 UI entry。`workbench.mount(extension, bindings)` 是唯一发布动作，owner 不在 Extension 重复
声明。registry
生成 target-specific layout，并把每个 resource 转成 resource-graph-revision-scoped opaque grant。
artifact 状态更新可以复用相同 grant；module、实例或依赖图变化会立即撤销旧 grant。浏览器不能按插件
namespace 任意访问未授予资源。

跨插件 UI 只使用 typed Port：consumer 选择 placement 并绑定自己的 resource，provider 提供 renderer。
Workbench 不根据 dependency graph 隐式投影 provider View。

不维护服务端 UI session/draft。交互状态属于 consumer resource、浏览器局部状态或明确的业务 API。

## Node module capability

插件用 module-level `defineNodeModule(import.meta.url, literal)` 声明单独构建的 Node ESM entry，并在
`init()` 中通过 `ctx.nodeModules.use(declaration, setup)` 消费。`NodeModuleService` 是常驻 runtime 能力；
首次 artifact build/load 或 setup 失败会让插件启动失败。开发期更新先完成新 setup，再清理上一成功消费者；
更新失败保留 last-known-good。owner stop/replacement 通过 effects 自动释放 source lease 和 active cleanup。

declaration key、build revision 和 owner node address 是三个独立身份。相同 declaration 的多个 owner/consumer 共用
build 与 watcher，但各自拥有 setup/cleanup。Node module 只输出自包含单文件 ESM，不定义 worker、线程或任务协议。

`defineWorkerTask()` 是同一 artifact primitive 上的 typed specialization。`ctx.workers` 把不同插件的 cloneable CPU/native
任务提交到 root 共享线程预算，执行 owner-aware bounded admission、round-robin、公用 cancellation 和 shutdown drain。
插件不 direct-depend Tinypool，也不各自按 CPU 数创建 pool。该能力不替代异步 I/O：网络、数据库和已经真正异步的 native API
继续使用原 capability；只有会长时间占用 JS event loop 且能用纯数据描述的工作才进入 worker task。

`workers.run()` 在返回前同步取得输入 snapshot，因此 caller 随后的 mutation 不会影响排队任务。大二进制可以通过
`{ transfer: [arrayBuffer] }` 显式转移 ownership；成功接纳后原 buffer 立即 detach，后续 artifact/execution 失败也不回滚
ownership。artifact 首次解析中的任务与 ready queue 使用同一 global/per-owner admission 上界，不能绕过队列预算。

## 包边界

- `@pluxel/core`：Context、graph、DI、lifecycle、effects；
- `@pluxel/runtime`：原样转发 core 作者面，并增加常驻 runtime 能力；
- `@pluxel/runtime/product`：browser-safe host product descriptor 与无副作用 `defineProduct()`；
- `@pluxel/commands`：独立的 command 定义、validation、registry 与 carrier projection 内核；
- `@pluxel/runtime/database`：server-only database definition 与 owner-bound handle；
- `@pluxel/runtime` 的 `NodeModuleService`：Node module owner lease、staged consumer 与 packaged resolver；
- `@pluxel/runtime` 的 `WorkerTaskService`：root shared pool、fair bounded admission 与 owner cancellation；
- `@pluxel/runtime/workbench/contract`：browser-safe Workbench Contract；
- `@pluxel/runtime/workbench`：服务端 Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource client；
- `@pluxel/core/federation`：Workbench bundle build contract；
- `@pluxel/runtime-static` / `runtime-dynamic`：route policy；
- `@pluxel/runtime-dev`：共享 UI/Node source graph、watch、cache 与 publication lifecycle 的 artifact compiler；
- `@pluxel/rolldown/vite/workbench-ui`：remote build primitive。
- `@pluxel/package-manager`：官方可选 source producer，拥有 pnpm、安装命令、owner-bound RPC 和 Workbench 页面。

dynamic route 与 package manager 之间只有文件协议：producer 在宿主声明的 `sources` 目录原子发布/删除 ESM entry，
route 观察文件并执行正常 graph transaction。runtime 不提供 package-manager capability、RPC DTO、内置页面或 market
抽象；其他 registry、离线 bundle 或本地开发工具也可以实现同一文件协议，不需要进入核心。

两条 route 的 catalog 语义是 `static = fixed plugins`、`dynamic = fixed plugins + mutable file sources`。Dynamic fixed catalog
使用普通 `plugins`，不拥有单独的 enablement、fork 或持久状态；fixed 与 mutable constructor 在同一个 Vite evaluated namespace
中求值。Package Manager 是宿主显式 import、RuntimeState 显式启用的 dynamic-only fixed plugin。

## 不变量

- 业务 capability 不依赖 Workbench Plane；
- disabled 表示零 backend 初始化；
- host 拥有 placement，provider 不能任意占据 consumer UI；
- static/dynamic 的作者 API 和 graph 语义一致；
- static/dynamic canonical module 共用可选 `product` named export，不把 host metadata 塞入 route config；
- active docs 只描述当前 API，历史由 Git 保存。
