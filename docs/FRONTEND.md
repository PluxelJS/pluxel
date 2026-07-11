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

## Context isolation

plugin gate 随 Context 隔离；registry 由 host 共享。每次注册保留插件 id、logger 和 effects owner，异步或并发初始化不能切换共享“当前 ctx”。

## 实现入口

- `packages/runtime/src/web/`
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
- `packages/runtime/src/services/plugin-interaction/ExtensionInteractionRegistry.ts`
- `packages/components/src/app/plugins/`
- `packages/rolldown/src/vite/plugin-ui.ts`
