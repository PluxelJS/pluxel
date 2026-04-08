# 插件系统（core/plugins）

这套目录承载的是核心插件系统实现：

- 插件装饰器与元数据
- DI 定义层与运行时 registry
- 插件生命周期 orchestration
- 插件内组合的 `BaseFeature` / `FeatureHost`

权威设计文档见：

- `docs/design/plugin-feature/overview.md`

这份 README 只保留实现入口和当前实现基线，不再承担完整设计收敛说明。

## 当前实现基线

当前已经稳定存在的 feature 能力：

- `this.features.use(FeatureCtor)`
- `@UseFeature(...)`
- `this.features.dep(DepPlugin, cb?)`
- feature config merge 到宿主 plugin config

当前推荐理解：

- `use()`：required feature，属于宿主静态组成
- `dep()`：运行期 optional integration primitive
- plugin constructor：只表达 required deps

后续若引入 `tryUse()`，应以 `docs/design/plugin-feature/overview.md` 的边界为准，而不是继续扩展旧的“所有 feature 都一套模型”。

## 目录结构

对外 API 通过 `plugins/index.ts` 统一导出；实现按职责分到 `runtime/`、`decorators/`、`composition/`。

### runtime/

- `runtime/PluginService.ts`
- `runtime/PluginActor.ts`
- `runtime/LifecycleManager.ts`
- `runtime/fork.ts`
- `runtime/PluginDefinitions.ts`
- `runtime/commit.ts`

### decorators/

- `decorators/PluginDecorator.ts` + `decorators/decorator/*`
- `decorators/decoratorRuntime.ts`

### composition/

- `composition/BasePlugin.ts`
- `composition/FeatureHost.ts`
- `composition/BaseFeature.ts`
- `composition/ConfigHost.ts`

## 实现注意点

- `features.use(...)` 的 class field 必须保持在 module top-level class 上，方便工具链提取声明期 metadata。
- Feature 若声明 config 或 decorator-required deps，就必须在启动前被注册：
  - 用 `@UseFeature(...)`
  - 或让工具链从 class-field `this.features.use(...)` 注入 `__registerUsedFeatures__(...)`
- `@Plugin` 构造函数里按类注入的依赖不能 `import type`；它依赖 runtime constructor metadata。
- `dep()`/caller injection 采用对象委托 + 覆盖 `ctx`；若依赖插件方法依赖 JS `#private`，被作为依赖视图使用时可能触发 brand-check。

## 验证入口

- 黑盒测试集中在 `packages/core/tests/`
- feature 相关行为优先看：
  - `packages/core/tests/DecoratorDeps.test.ts`
  - `packages/core/tests/FeatureDeps.test.ts`
  - `packages/core/tests/FeatureConfig.test.ts`
