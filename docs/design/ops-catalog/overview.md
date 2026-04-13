# Ops Catalog Design

## Goal

Pluxel 现有的 `@pluxel/ops` 已经收敛成一套正确的 control-plane kernel：

- 插件 / runtime 通过 `defineOp(...)` 声明能力
- `ctx.ops` 持有 live registry
- CLI / RPC / MCP / docs 都只投影同一个 descriptor

这一层不需要再扩展成“静态 API contract”或“UI schema 系统”。

这一轮要解决的问题只有两个：

1. host UI 需要一个**实用、稳定、可分组**的 op 视图
2. 这个视图不能直接绑定 raw registry 细节，也不能要求插件声明第二套 UI metadata

所以本设计只增加一个很薄的 read model：

- `ops catalog`

它是 `ctx.ops` 的派生视图，不是第二套 op 系统。

## Non-Goals

这轮明确不做：

- 不给 `ops` 增加 TypeScript module augmentation contract
- 不把 `ops` 变成插件静态依赖面
- 不让插件之间通过 op id 建立强依赖
- 不新增第二套 help / grouping DSL
- 不做独立的 op persistence store
- 不做复杂自动表单平台

原因很简单：

- `ops` 是 runtime live registry，插件停掉、禁用、卸载之后 op 就会消失
- 如果 A 真正依赖 B 的能力，应该直接依赖插件 / feature / RPC contract，而不是依赖某个 op id
- host UI 的分组是 host 的职责，不是类型系统职责

一句话：

**`ops` 是动态控制面，不是静态 API 面。**

## Current Boundary

现有边界保持不变：

- `@pluxel/ops`
  canonical op model
- `ctx.ops`
  runtime live registry
- `opsInvoke / opsDispatch`
  transport-level invocation surface
- MCP tools
  从 registry 实时投影

本设计只在 runtime / host 上补一个 read model。

## Final Model

最终只保留三层：

### 1. Live Registry

`ctx.ops` 继续负责：

- 注册
- 调用
- descriptor 暴露
- 生命周期绑定

插件启动时注册，停止时自动回收。

### 2. Ops Catalog

新增一个很薄的 runtime read model，供 host UI 消费。

它的职责：

- 暴露 `owner`
- 暴露 `ownerKind`
- 暴露 `pluginId`
- 暴露 public descriptor

它不负责：

- 执行
- 状态持久化
- second schema
- second doc model

建议数据形状：

```ts
type RuntimeOpCatalogEntry = {
  id: string
  owner: string
  ownerKind: 'runtime' | 'plugin' | 'context'
  pluginId?: string
  descriptor: RuntimeOpDescriptor
}
```

这个结构故意很薄：

- UI 仍然可以读 descriptor 的 `doc/policy/transports`
- 但不需要再去推断 registry owner

### 3. Host UI View

host workbench 只消费 catalog，不直接消费 raw registry。

当前迭代只做：

- 独立宿主页面 `/ops`
- 左侧 group/sidebar 导航
- 只展示 **RPC-exposed** ops
- 支持按宿主 / 变更型 / tool / plugin owner 分组
- 支持搜索 / 过滤 / 执行 / 最近结果反馈

不做：

- 自动复杂表单
- 历史持久化
- 插件级自定义分组布局

### 4. Host-Owned Toolsets

toolset 不是 plugin dependency，也不是新的 op schema。

它只是宿主持久化的一层极薄 metadata：

```ts
type OpsToolset = {
  toolsetId: string
  name: string
  description?: string
  opIds: string[]
}
```

语义约束：

- source of truth 仍然是 live registry
- toolset 只保存 `opIds` 和用途描述
- `opIds` 可以暂时指向当前不可见的 op
- 插件停掉时，toolset 不自动删除对应 id
- consumer 自己决定如何 join `opsToolsets + opsCatalog`

这样 host UI 可以做管理和浏览，但不会把 registry 反过来固化成依赖系统。

## Why Catalog Is RPC-Exposed Only

host workbench 运行在浏览器里，执行入口走的是 `rpc.opsInvoke(...)`。

因此 UI 不应该展示无法通过 RPC 调用的 op。

规则：

- catalog 默认只返回 `descriptor.exposure.rpc === true` 的 op
- `tool`-only op 继续服务 MCP / LLM
- UI 不为 `tool`-only op 提供“点了必失败”的按钮

这可以避免“registry 里存在，但 UI 无法执行”的语义错位。

## Ownership Rules

### Runtime / Host Ops

runtime canonical op 继续使用保留命名空间：

- `plugin.*`
- `plugins.*`
- `runtime.*`

这些 op 的 owner 应标记为 runtime。

### Plugin Ops

插件注册的 op owner 继续来自插件上下文：

- `plugin:<pluginId>`

插件停止时，这些 op 应自动从 registry 和 catalog 中消失。

### Context Ops

非插件上下文注册的 op 继续保留：

- `context:<name>`

但 host UI 当前不需要把它们放到主分组语义里，只要可识别即可。

## Lifecycle And Cleanup

这里继续依赖 `ctx.effects`，但只用在正确的位置。

### Registry cleanup

`ctx.ops.register(...)` 必须继续把 unregister 绑定到插件生命周期。

### Resource cleanup

如果某个 op 依赖：

- watcher
- stream
- worker
- cache
- polling

这些资源不放在 registry 里，而放在插件自己的 effect scope 里。

规则：

- registry 只负责“声明和调用”
- 长生命周期资源归插件
- 会话级资源归 `effects.scope()`
- 多资源注册用 `effects.transaction(...)`

## Host UI Rules

### Placement

这轮实现改成一个 host-managed 独立页面：

原因：

- `ops` 是宿主级 control plane
- 它不属于某一个插件详情页
- 它天然需要自己的分组导航和主工作面

因此它应该进入独立 `/ops` 页面，而不是插件工作台 sidebar。

### Grouping

页面左侧同时支持两层导航：

- catalog 派生筛选
  - 全部
  - 宿主
  - 变更型
  - tool
  - plugin owner
- host-owned `opsToolsets`

toolset 编辑能力保持最小闭环：

- 创建
- 重命名
- 删除
- 管理成员

成员管理只修改 host 侧 `opIds` 列表和 `description`，不改 registry。

列表项展示：

- `doc.title`
- `doc.description`
- `doc.tags`
- `policy.mutating`
- `policy.confirm`
- `tool`/`cli` 标记

### Execution UX

当前阶段只做高效、朴素的执行体验：

- 无输入 op：直接执行
- object input op：提供 JSON 编辑器
- 默认根据常见参数做轻量预填充
  - 例如 required string `name` 字段可预填当前插件名

不做复杂自动表单系统。

## RPC Surface

catalog 不注册成一个新的 op。

原因：

- 它是 transport-level read model
- 不是 runtime canonical control action
- 不应该混入 canonical runtime op namespace

因此它应该作为 `RuntimeRpcApi` 的一个直接方法：

- `opsCatalog()`

与现有：

- `opsList()`
- `opsInvoke(...)`
- `opsDispatch(...)`

保持同一层级。

`opsToolsets` 也走同一层级的 direct RPC：

- `opsToolsets()`
- `updateOpsToolsets(toolsets)`
- `resolveOpsToolset(toolsetId)`

原因一致：

- 它是 host metadata
- 不是 canonical control action
- 不应该再塞回 runtime op namespace

## Iteration Scope

本轮只实现：

1. runtime `opsCatalog()` read model
2. browser RPC / web client 类型与 helper
3. host-owned `opsToolsets` persistence + RPC
4. 独立 `/ops` 页面
5. 基础搜索 / 执行 / 结果反馈
6. 分组创建 / 重命名 / 删除 / 成员管理
7. 生命周期相关测试
8. demo plugin symbolic ops 示例

后续若需要，再考虑：

- 全局 ops explorer
- 最近执行记录持久化
- 更好的 input editor
- confirm / audit UI

但这些都不进入本轮。

## Summary

一句话：

**保留 `ops` 作为 live control-plane registry，不给它加静态类型 contract；只在 runtime 上补一个薄 catalog 和 host-owned `opsToolsets`，并把它落成宿主级 `/ops` 页面。**
