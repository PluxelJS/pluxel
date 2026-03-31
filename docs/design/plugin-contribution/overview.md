# Plugin UI System Design

## Goal

Pluxel 的插件 UI 系统只解决两类明确问题：

- `builtin`
  宿主渲染的简单 UI。适合说明文档、标准表单、动作按钮、资源选择。
- `custom frontend`
  插件自己渲染的自由前端。适合复杂交互、品牌化页面、跨插件自定义 UI。

这两条路都应该存在，而且边界要故意拉开。系统真正统一的部分，不是把它们揉成一个抽象名词，而是让它们走同一条运行时脊柱。

## Current Code Reality

当前代码已经形成了这几个核心构件：

- runtime 侧的扩展与交互注册：
  `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
- 浏览器侧插件 UI authoring：
  `packages/runtime/src/web/plugin-ui/authoring.ts`
- builtin 宿主渲染：
  `packages/components/src/extension/builtin/*`
- custom frontend 会话宿主：
  `packages/components/src/extension/session/InteractionSessionHost.tsx`
- 宿主加载与 manifest 同步：
  `packages/components/src/app/ExtensionLoader.tsx`
- 诊断与状态观察：
  `packages/components/src/extension/internal/runtime-state.ts`
  `packages/components/src/extension/diagnostics.ts`

因此最优设计不是重新发明平台，而是把这套已经成型的结构收束成清晰规则。

## Final Decision

最终只保留两条产品路径、三类共享状态模型、一个统一运行时脊柱。

### 1. Product Paths

#### Builtin

作者只声明结构和绑定关系，由宿主统一渲染。

适合：

- `doc`
- `form`
- `action`
- `resourceSelect`

特点：

- 不需要插件 UI remote
- 一致的宿主体验
- 成本低
- 宿主可统一做 loading、error、confirm、notify

#### Custom Frontend

作者提供自己的 UI remote，宿主只负责装载、容器、会话、同步和诊断。

适合：

- 复杂页面
- 高自由度交互
- 跨插件自定义 UI
- 需要强定制视觉或复杂流程的界面

特点：

- 插件拥有渲染控制权
- 默认可直接使用宿主提供的状态同步能力
- `rpc / sse` 是增强能力，不是基础门槛

## Shared Runtime Spine

两条产品路径共享以下脊柱。

### 1. Module Packaging And Loading

- 服务端通过 `ctx.ext.ui.remote.packaged()` 暴露 UI remote
- 宿主通过 `ExtensionLoader` 拉取 manifest、加载模块、注册扩展点
- 浏览器侧通过 `definePluginUIModule(...)` 暴露 `extensions / routes / sessions`

这层和 builtin/custom frontend 无关，是统一底座。

补充一条实现约束：

- 插件 UI 的 dev/build 链路不会复用同一个 federation build 进程状态

原因不是架构偏好，而是当前 MF2 Vite 构建在同进程重复执行时会污染临时状态。对 Pluxel 来说，更优的做法是：

- 复用 root-scoped 调度
- 不复用具体 build 进程

这样可以把“不稳定的 federation 内部状态”隔离在单次构建里，不让它泄漏到插件系统设计本身。

### 2. Shared State Models

系统只承认三类一等公民状态：

- `plugin config`
  插件持久配置，来源于 `configs.use(...)`
- `SignalDB`
  服务端 authoritative、浏览器副本同步的集合状态
- `interaction session draft`
  一次交互会话里的临时状态

不要额外发明第四套“通用 state/action 框架”。

### 3. Shared Host Capabilities

两条路径都应该能使用：

- `transport`
- `notify / confirm / locale`
- plugin/global extension context
- config schema/defaults/config save
- SignalDB replica query

custom frontend 不应退化成“只有裸 rpc / sse 可用”的模式。

### 4. Shared Diagnostics

诊断必须统一从 runtime manifest 派生，而不是 builtin 一套、custom 一套。

manifest 当前应关注：

- `modules`
- `builtins`
- `surfaces`
- `offers`
- `sessions`
- `interactions`
- `states`

宿主 UI 统一展示：

- 插件 UI 编译/加载状态
- 交互匹配状态
- active / waiting / rejected

## Ownership Rules

这是整套系统最重要的冻结规则。

### Builtin Ownership

- 插件拥有数据和声明
- 宿主拥有渲染
- builtin block 可以读写 config 或 SignalDB
- builtin 不负责复杂自定义前端

### Custom Frontend Ownership

- provider 插件拥有 UI 和资源准备
- consumer 插件拥有自己的持久状态
- 宿主拥有 session 生命周期、同步与 commit

具体到跨插件 interaction：

1. consumer 用 `surface(...)` 声明入口、输入和最终 `apply`
2. provider 用 `offer(...)` 声明兼容 contract 的 UI 能力
3. host 解析出 active session
4. provider session UI 通过 `loadSession / syncDraft / commitSession` 工作
5. consumer 在 `apply(...)` 中落持久状态

禁止回到旧模型：

- provider 直接知道 consumer 的配置字段路径
- provider 直接写 consumer 的 config/SignalDB
- host 只负责挂载、不负责交互语义

## Authoring Surface

### Service Side

推荐 API 就这几个：

- `this.ctx.ext.ui.remote.packaged()`
- `this.ctx.ext.ui.builtin.doc(...)`
- `this.ctx.ext.ui.interaction.surface(...)`
- `this.ctx.ext.ui.interaction.offer(...)`

其中：

- `doc(...)` 只服务 builtin
- `surface / offer` 只服务跨插件 custom frontend interaction

不要再增加新的并行 authoring 入口。

### Browser Side

推荐入口：

- `definePluginUIModule(...)`
- `const plugin = pluginUi('MyPlugin')`

推荐能力：

- `const app = plugin.use()`
- `plugin.useGlobal()`
- `app.db.collection('foo').useList({ where, sort, limit, skip })`
- `app.db.useDocById()`
- `app.db.collection('foo').useDocById()`
- `app.db.useCount()`
- `app.db.useLiveQuery()`
- `sessions: { ... }`

`rpc / sse` 保留为 escape hatch，但默认开发体验应该优先使用宿主已经提供的 config/SignalDB/session 同步能力。

其中 SignalDB authoring 的规则应当明确：

- 单文档主路径永远优先 `useDocById(...)`
- 列表查询统一写成结构化 spec，而不是 React render 里拼 `selector + options` 两个临时对象
- 只有复杂派生读取才进入 `useLiveQuery(...)`

## What Is Actually Unified

系统真正应该统一的是：

1. 状态模型
2. 同步生命周期
3. 宿主容器与上下文
4. 诊断和观测

系统不应该强行统一的是：

1. 渲染 ownership
2. builtin 和 custom frontend 的 authoring 形态
3. 所有 UI 都叫同一个抽象名词

一句话：

**统一的是状态与运行时脊柱，分开的是渲染 ownership。**

## Practical Lifecycle

### Builtin Lifecycle

1. 插件声明 `doc(...)`
2. runtime 把 builtin 定义放进 manifest
3. host 读取 manifest 并注册到扩展点
4. `BuiltinDoc` / `BuiltinSignalDbForm` / `BuiltinSignalDbAction` / `BuiltinResourceSelect` 渲染
5. 通过 config 或 SignalDB 完成读写

### Custom Frontend Lifecycle

1. 插件声明 `packaged()`
2. consumer 声明 `surface(...)`
3. provider 声明 `offer(...)`
4. runtime 解析 `session + interaction diagnostics`
5. host 加载 provider UI module
6. `InteractionSessionHost` 调用 `loadSession`
7. provider UI 编辑 draft，调用 `syncDraft`
8. provider UI 调用 `commitSession`
9. consumer `apply(...)` 写入持久状态

## What To Optimize Next

后续优化和清理不再继续堆在这份主设计文档里，统一转到：

- [future-work.md](./future-work.md)

这样做是刻意的：

- `overview.md` 只描述当前已经接受的系统设计
- `future-work.md` 单独记录未来要继续完成的优化、清理和架构债

当前代码已经完成两件最关键的收敛：

- runtime 侧把 interaction 逻辑拆进 `ExtensionInteractionRegistry`
- host 侧把 manifest/module 观察合并进 `runtime-state`

因此接下来应当坚持的是边界稳定，而不是继续发明新层。

### 1. Keep ExtensionService As A Facade

`ExtensionService` 现在应该保持成 facade:

- 模块注册与编译状态
- manifest 广播
- 委托 interaction registry 解析 surface / offer / session

除非后面再次明显膨胀，否则不要继续拆出更多 service class。

### 2. Keep Host State Centralized

宿主侧现在保留两层就够了：

- `pluginUiRegistry`
  负责已加载 UI module 的 route/session/component 注册
- `runtime-state`
  负责 module state、manifest diagnostics、manifest sync request

`ExtensionLoader` 只做同步与装载，不再额外演化成第三套状态中心。

### 3. Keep Builtin As A Host Protocol

builtin 不要继续长成“半自定义前端框架”。它应该稳定停留在：

- 标准 block 协议
- 统一宿主渲染
- 低成本可维护

复杂 UI 直接进 custom frontend。

### 4. Keep RPC/SSE Optional

custom frontend 默认先吃：

- config
- SignalDB
- session draft

只有这三种不够时，才自己上 `rpc / sse`。

## Non-Goals

- 不把 builtin 和 custom frontend 抽成一个统一 DSL
- 不把 SignalDB 降级成“只是某种 backend”
- 不让 provider 直接 cross-write consumer 状态
- 不让 `rpc / sse` 成为 custom frontend 的基础前提
- 不继续保留旧的 `slot / widget / binding` 模型

## Summary

Pluxel 的插件 UI 系统最终应该稳定为：

- 两条产品路径：
  `builtin` 和 `custom frontend`
- 三类共享状态：
  `config`、`SignalDB`、`session draft`
- 一个统一运行时脊柱：
  packaging、loading、context、sync、diagnostics

最重要的设计原则不是“高度抽象”，而是：

**简单 UI 交给宿主，自由 UI 交给插件；但状态模型、同步语义、宿主诊断必须统一。**

## Plugin Workbench Points

随着插件工作台改成固定的三向布局，插件扩展点也需要按区域收敛，而不是继续把所有内容都塞进旧的 `plugin:info`。

当前宿主约定如下：

- `plugin:header`
  主工作区头部的紧凑扩展位。只放状态 chip、轻量按钮、筛选器这类横向内容。
- `plugin:tabs`
  主工作区标签页内容。适合页面级主内容。
- `plugin:actions`
  插件状态与辅助动作区。适合启动、停止、重启以及少量附加动作。
- `plugin:context`
  右侧上下文栏。适合摘要卡片、说明、辅助信息、上下文状态。
- `plugin:dock`
  底部 dock。适合日志相关补充、诊断输出、运行期辅助面板。

兼容策略：

- `plugin:info` 继续保留一段时间，但只作为 legacy fallback
- 新实现统一优先迁到 `plugin:context`
- 需要横向紧凑展示的扩展不要再挂到 `plugin:tabs` 或 `plugin:info`
