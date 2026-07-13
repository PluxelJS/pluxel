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

layout 不公开资源 owner/name，只下发 opaque binding。API、collection、stream transport 在每次请求时
由 registry 解引用并校验 kind；registry revision 变化会撤销旧 binding。

## 更新与隔离

module mount、unmount、owner running state 和 artifact build 共用 Management revision。Workbench 对每个
transport 只维护一条 revision SSE，按需重新请求 global 或 target layout，并仅加载 layout 实际引用的
remote artifact。

gate 随 plugin Context 隔离，registry 和 artifact store 由 host 共享。registry 不保存可切换的“当前
Context”；每个 resource factory 保留 immutable owner Context。

## 实现入口

- `packages/runtime/src/management/`
- `packages/runtime/src/services/management/`
- `packages/components/src/management/`
- `packages/rolldown/src/vite/management-ui.ts`
