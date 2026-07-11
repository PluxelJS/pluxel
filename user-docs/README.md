# Pluxel User Docs

这个目录放用户向文档：面向插件作者、宿主集成者和应用开发者。

它和 `docs/` 的区别：

- `user-docs/` 解释怎么写插件、怎么组织应用、哪些写法是最佳实践。
- `docs/` 解释 Pluxel 内部设计边界、包边界、实现路线和维护约束。

## 阅读顺序

1. `plugin-authoring-model.md`
   插件能力边界、依赖/feature、Web Management、生命周期、错误模型和资源管理。

内部设计与迁移后的唯一 API 清单见 `docs/PLUGIN_AUTHORING_FINAL.md`。

## 写作原则

- 优先描述当前应遵守的使用模型。
- 不把未来提案写成已实现 API。
- 不把内部实现细节暴露成用户必须记住的概念。
- 示例代码表达意图即可，不要求覆盖每个具体包导入。
