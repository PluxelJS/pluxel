# Workbench

Workbench 是 host-owned 插件工作台。它消费 runtime 的 read model 和 plugin UI protocols，但不应该让插件直接拥有宿主布局。

## 当前模型

当前 `/plugins` workbench 的核心原则：

- 左侧负责插件或对象选择。
- 主区域/详情区域渲染选中对象的视图。
- config/status surfaces 是 host-owned runtime views。
- dirty state 和 config draft state 属于 workbench state，不属于插件内部状态。
- 日志、状态、配置、插件 UI 要能共存，不能互相抢主任务空间。

## Contribution ownership

插件贡献模型按 ownership 拆：

- builtin/doc：host-rendered，由宿主决定视觉和交互框架。
- custom frontend：compiled remote UI，由插件提供复杂 UI。
- interaction surface：consumer-owned placement、输入和最终 apply。
- interaction offer：provider-owned 资源准备和 session UI。
- shared state：SignalDB/RPC/SSE 等 runtime services。

这个模型比通用 slot 更明确：extension point 不只回答“放什么”，还要回答“谁拥有 placement、谁拥有资源、谁拥有最终提交”。

## 当前实现边界

- Workbench 负责 layout、selection、tab/cache/draft state。
- runtime 负责 status/config/read model 和 browser clients。
- plugin UI remote 只负责自己的 custom frontend 内容。
- builtin/doc extension 不走独立前端体系，统一由 host render。

## 实现入口

- `packages/components/src/app/plugins/**`：插件 workbench 主 UI。
- `packages/components/src/app/plugins/config/**`：配置表单和 layout UI。
- `packages/components/src/app/workbench/**`：workbench layout primitives。
- `packages/runtime/src/web/**`：workbench/browser client。
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`：extension runtime 协调。
- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`：共享状态服务。
- `packages/runtime/src/services/plugin-interaction/RpcService.ts`：RPC 服务。
- `packages/runtime/src/services/plugin-interaction/SseService.ts`：SSE 服务。

## 未来模型放哪里

Editor/sidebar/panel 的 `WorkbenchView`、多 tab 系统、commands/status items、迁移顺序等都属于未来设计，放在 `proposals/README.md`，不要写成当前行为。
