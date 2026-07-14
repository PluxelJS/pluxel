# Frontend Architecture

业务 HTTP 与 Management UI 是两条独立路径。管理前端是 optional capability，不得成为插件核心能力的
启动前提。

## Contract 与 ownership

`ManagementModule` 是唯一服务端声明单元：

- `resources` 声明 typed API、collection、stream；
- `contributions` 声明 view、consumer port 或 provider renderer；
- `ui` 只声明 remote entry，不执行注册；
- plugin Context/effects 拥有 mount 和所有资源 cleanup。

placement 由宿主解析。普通 view 只能投给自己；required-dependent 的自动投影只允许进入
`plugin.capabilities`。任意 consumer Tab、route、action 等位置必须由 consumer 声明 port，provider 只
提供匹配 renderer。

## Server/browser boundary

- server contract：`@pluxel/runtime/management`；
- browser contract：`@pluxel/runtime/management/ui`；
- artifact contract：`@pluxel/runtime/management/federation`；
- Workbench 请求 target-specific layout，不读取全局 session manifest；
- remote view 只能读取当前 layout item 授予的 resource bindings。

global layout 可下发 `plugin.routes` 的 `addToNav` 导航描述，但不附带资源 binding，也不因此加载 remote；
用户打开 `/ext/:owner/*` 后，route screen 才请求该 owner 的 target layout 并加载对应 artifact。

UI entry 通过 type-only import 引用 `ManagementModule` 或 port，并调用
`managementApp<typeof contract>()`。服务端 module declaration 不进入 remote module graph，浏览器不会执行
`managementUi()`，也不会携带 core Context 或 Node API。

layout 不公开资源 owner/name，只下发 opaque binding。API、collection、stream transport 在每次请求时
由 registry 解引用并校验 kind；module、实例或依赖资源图变化会推进 grant revision 并撤销旧 binding，
artifact 编译状态更新只刷新 catalog/layout，复用仍然有效的 binding。
collection SSE 按 owner 与实际 resource 隔离；一个 opaque binding 只接收它获授权的 collection 事件，
不能复用 plugin-wide stream 后再由浏览器猜测 collection 名。同一 browser transport 的 active collection
bindings 可以复用一条 multiplex SSE，服务端仍按 opaque binding 独立鉴权和路由；custom stream 保持独立生命周期。

## 更新与隔离

module mount、unmount、owner running state 和 artifact build 共用 Management catalog/layout revision；
资源 grant 使用独立 revision，artifact-only 更新不会撤销它。Workbench 对每个
transport 只维护一条 revision SSE，按需重新请求 global 或 target layout，并仅加载 layout 实际引用的
remote artifact。首次构建中的 remote 暂不注册 view，artifact ready revision 到达后重试；只有明确的
artifact error 才显示加载失败。revision 事件是 cache invalidation epoch：后端重启即使 revision 从较小值
重新开始也会重取 catalog；新 layout/remote 完成后原子替换工作版本，owner 真正移除时才卸载旧 remote 和
route cache。

gate 随 plugin Context 隔离，registry 和 artifact store 由 host 共享。registry 不保存可切换的“当前
Context”；每个 resource factory 保留 immutable owner Context。

## 实现入口

- `packages/runtime/src/management/`
- `packages/runtime/src/services/management/`
- `packages/components/src/management/`
- `packages/rolldown/src/vite/management-ui.ts`
