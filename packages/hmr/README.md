# HMR 依赖重绑设计说明

`plugin-style` 的 DI 层（diod）用“构造函数引用”做依赖键；引用不一致即视为缺失。Vite HMR 会重新执行模块，但不会自动替换容器里已注册插件的依赖引用，因此会出现 “MissingDependency: KOOK -> WebSocketPlugin” 这类问题：新插件用新 ctor 注册，依赖者还持有旧 ctor 引用。

## 关键策略
- **在 `LoaderService.replaceModule` 热更后重绑依赖者**：记录旧模块导出的插件 ctor，利用 `pluginInfo.id -> current ctor` 映射，把其直接依赖者的构造参数列表中属于插件的旧 ctor 替换成当前主 ctor，再 `setParamTokens` 写回。这样 diod 看到的依赖引用与注册引用同步，避免 MissingDependency。
- **开销控制**：只触碰“被更新插件的直接 dependents”，依赖图来自 `pluginRegistry.lastContainer.dependents`，不会全量扫描所有插件。
- **不改 diod**：diod 仍按引用查找；这一层只是确保喂给 diod 的引用永远是最新 ctor。

## 触发流程
1. Vite/runner 触发 HMR，调用 `LoaderService.replaceModule`。
2. 停旧运行态，撤销旧声明，重新 declare 新模块导出的插件。
3. `syncRuntimeForModule` 按启用位启动需要的插件。
4. **refreshDependents**：对旧模块导出的 ctor，找出直接依赖者，若依赖引用对应的 `pluginInfo.id` 在 `registry.names` 里有新 ctor，就替换为新 ctor 并写回依赖 tokens。

## 注意事项
- 只替换 BasePlugin 子类的依赖引用；其他构造参数不动。
- 如果依赖者模块本身也被 HMR 重载，`design:paramtypes` 会是新 ctor，此步骤仍安全（多数情况下无修改）。
- 如果未来改为基于 token 的依赖解析，这一层可移除；当前方案是“最小改动、最少维护成本”的兼容路径。
