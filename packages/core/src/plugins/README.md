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
- `defineOptionalFeature(spec)`
- `this.features.tryUse(spec)`
- `@UseFeature(...)`
- `this.features.dep(DepPlugin, cb?)`
- feature config merge 到宿主 plugin config

当前推荐理解：

- `use()`：required feature，属于宿主静态组成
- `tryUse()`：optional feature，负责条件启用与 lazy load
- `dep()`：运行期 optional integration primitive
- plugin constructor：只表达 required deps

`tryUse()` 的边界以 `docs/design/plugin-feature/overview.md` 为准，不要再回到旧的“所有 feature 都一套模型”。

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
- `features.tryUse(...)` 不参与声明期 metadata 提取；不要写在 class field 或 constructor，它应在 `init()` 或其它运行期阶段调用。
- `features.tryUse(...)` 只接受 module top-level `const defineOptionalFeature(...)` 产出的命名 spec；不要在调用点直接拼 object literal，也不要用 `let`/`var` 保存 optional spec。
- `features.tryUse(...)` 不接受额外 constructor args；optional feature 的运行期输入要放到 spec、host plugin state 或 feature 自身状态里。
- 如果 optional provider 的类在宿主静态路径上不可安全 import，就不要在 host 文件引用它；改用稳定字符串 token 放进 `spec.requires`，并把 provider-specific import 留在 `load()` 懒加载边界之后。
- Feature 若声明 config 或 decorator-required deps，就必须在启动前被注册：
  - 用 `@UseFeature(...)`
  - 或让工具链从 class-field `this.features.use(...)` 注入 `__registerUsedFeatures__(...)`
- optional feature 不允许声明期 feature 语义：
  - 不要在 `tryUse()` 目标 feature 里放 `configs.use(...)`
  - 不要在 `tryUse()` 目标 feature 里声明 decorator-required deps
  - `load()` 必须返回 Promise，并且真正经过 dynamic import 边界；不要让它直接或间接回到静态 import 的 feature ctor
  - 这些 feature 应改回 `use()`
- `@Plugin` 构造函数里按类注入的依赖不能 `import type`；它依赖 runtime constructor metadata。
- `dep()`/caller injection 采用对象委托 + 覆盖 `ctx`；若依赖插件方法依赖 JS `#private`，被作为依赖视图使用时可能触发 brand-check。

## 验证入口

- 黑盒测试集中在 `packages/core/tests/`
- feature 相关行为优先看：
  - `packages/core/tests/DecoratorDeps.test.ts`
  - `packages/core/tests/FeatureDeps.test.ts`
  - `packages/core/tests/FeatureConfig.test.ts`
  - `packages/core/tests/FeatureTryUse.test.ts`
