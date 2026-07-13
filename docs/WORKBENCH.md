# Workbench

Workbench 是 host-owned 管理界面，不是插件布局 API。

## Ownership

- host：导航、selection、layout、tab/cache、config draft；
- runtime：status/config read models、extension manifest、browser clients；
- plugin remote：自身复杂内容；
- builtin contribution：由 host renderer 呈现；
- interaction：按 surface/offer contract 分配 placement、resource 和 apply ownership。

插件不能直接控制宿主 sidebar、panel 或页面骨架。新的 extension point 必须先回答谁拥有 placement、资源、提交和 cleanup，而不是只新增一个字符串 slot。

## Client state

Workbench store 只保存跨组件、需要命令式读取或持久化的 host UI 状态，例如 tabs、pane layout、tab-scoped state 和 dirty 标记。它不保存 runtime read model、请求 loading/error 或 GQLens 数据。组件局部的输入、弹窗和短期交互继续使用 React state。

当前 store surface 已通过 selector 和领域 action 隔离；具体 store library 不是插件或扩展 API。只有在新的客户端状态需求能实质减少 action、selector 或持久化代码时才更换实现，不为统一技术栈迁移。

## 实现入口

- `packages/components/src/app/plugins/`
- `packages/components/src/app/workbench/`
- `packages/runtime/src/web/`
- `packages/runtime/src/services/plugin-interaction/`

尚未实现的 workbench 扩展只能写入 `docs/proposals/`。
