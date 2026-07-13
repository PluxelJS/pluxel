# Frontend Architecture

插件业务 HTTP 与管理前端是两条独立路径。管理前端属于 optional Web Management。

## Contribution models

- remote UI：插件拥有浏览器代码和复杂交互；
- builtin UI：宿主渲染可序列化描述；
- interaction surface：consumer 拥有 placement、input 和 apply；
- interaction offer：provider 准备资源和 session UI；
- management state：服务端权威、供管理 UI 同步的状态。

这些模型共享插件 namespace，但不能折叠成失去 ownership 的通用 slot。

## Server/browser boundary

- server declaration：`@pluxel/runtime/web-management`；
- browser plugin API：`@pluxel/runtime/web`；
- host workbench：消费 runtime read model 和 extension manifest；
- plugin remote：只拥有自己的内容，不控制宿主布局。

`ui()` 是纯 declaration，`web.ui.register()` 是唯一注册动作。开发期编译源码，生产期注册 artifact，作者 API 不变。

## State ownership

- GQLens store 是 GraphQL 服务端状态在浏览器中的唯一 cache；领域 hook 可以投影视图模型，但不能再维护可独立写入的镜像 cache。
- RPC 写操作完成后应失效或刷新对应的 GQLens selection；已有 GraphQL mutation 时优先使用生成的 mutation descriptor。
- 尚未进入 GraphQL 的 RPC 数据由所属领域 resource 管理。多个消费者共享时，resource 必须提供稳定 snapshot、并发请求去重和 mutation result commit；单消费者数据直接留在组件，不建立全局 TTL cache。
- 刷新由 mutation 调用方或领域 resource 直接触发，不使用无所有者的全局 topic invalidation bus。
- 跨组件、需要命令式读取或持久化的 host UI 状态由 workbench store 管理；组件局部交互仍留在 React state。
- loading、error、refetch 和乐观结果跟随拥有请求的 data layer，不能复制进通用客户端 store。

## Context isolation

plugin gate 随 Context 隔离；registry 由 host 共享。每次注册保留插件 id、logger 和 effects owner，异步或并发初始化不能切换共享“当前 ctx”。

## 实现入口

- `packages/runtime/src/web/`
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
- `packages/runtime/src/services/plugin-interaction/ExtensionInteractionRegistry.ts`
- `packages/components/src/app/plugins/`
- `packages/rolldown/src/vite/plugin-ui.ts`
