# Workbench

Workbench 是 host-owned 管理界面，不是插件布局 API。

## Ownership

- host：导航、selection、layout、tab/cache、config draft；
- runtime：status/config read models、extension manifest、browser clients；
- plugin remote：自身复杂内容；
- builtin contribution：由 host renderer 呈现；
- interaction：按 surface/offer contract 分配 placement、resource 和 apply ownership。

插件不能直接控制宿主 sidebar、panel 或页面骨架。新的 extension point 必须先回答谁拥有 placement、资源、提交和 cleanup，而不是只新增一个字符串 slot。

## 实现入口

- `packages/components/src/app/plugins/`
- `packages/components/src/app/workbench/`
- `packages/runtime/src/web/`
- `packages/runtime/src/services/plugin-interaction/`

尚未实现的 workbench 扩展只能写入 `docs/proposals/`。
