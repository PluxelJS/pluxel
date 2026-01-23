# 插件系统（core/plugins）

这套目录承载的是 **核心插件系统**：装饰器/元数据、DI 定义层（draft/build/commit）、运行时 registry（commit/restart/unregister/fork），以及插件生命周期 actor；并提供“插件内组合”的 Feature 基础设施（BaseFeature/FeatureHost）。

插件系统的测试更适合集中放在 `packages/core/tests/`（黑盒/集成式，用 `@pluxel/core/test` 跑真实插件行为），这里主要放实现与约定说明。

## 目录结构（“主文件 + internal 基础设施”）

### 主文件（入口更显眼）

- `PluginService.ts`：运行时 orchestrator（commit、restart、unregister、fork 管理、实例缓存等）
- `PluginActor.ts`：单插件生命周期状态机（start/stop/retry/asyncError）+ selectors
- `LifecycleManager.ts`：把 actor 挂到插件实例上、封装超时/停止策略（供 `PluginService` 使用）
- `fork.ts`：fork ctor 的生成与 identity 规则（`id#forkId`）

### internal/（底层设施与实现细节）

- `internal/BasePlugin.ts`：`ctx` 注入与 lifecycle runtime 适配（构造热路径）
- `internal/PluginDecorator.ts` + `internal/decorator/*`：`@Plugin/@Config`、元数据存储、param tokens、requiredDeps、configSource、clone definition
- `internal/PluginDefinitions.ts`：DI 定义层（draft 注册/撤销 + build/confirm/resetDraft）
- `internal/decoratorRuntime.ts`：跨插件 decorator 运行时（按 token resolve 依赖 + 注入 caller ctx + 缓存）
- `internal/runtime/*`：`PluginService` 使用的纯逻辑（init plan / start/stop scheduler）

## 维护原则

- 对外 API 通过 `plugins/index.ts` 统一导出；内部实现尽量收敛到 `internal/`，减少主目录噪音。
- 任何改动优先用 `packages/core/tests/` 的黑盒场景验证行为不变。
- Feature 组合入口：插件通过 `this.features.use(FeatureCtor)` 绑定子模块；若 Feature 内部使用 `pluginMethodDecorator()` 声明 requiredDeps，则宿主插件需在“启动前”声明它（`@UseFeature(FeatureCtor)` / `@UseFeature(F1, F2, ...)`，或在 HMR/rolldown 流水线里让 `features.use(...)` 的 class-field 由 `configSource` 插件注入 `__registerUsedFeatures__(Ctor, FeatureCtor)`），这样依赖约束才能提升到宿主插件的 DI 校验层，保持行为可预测。
- Feature 配置归因：Feature 里也可以用 `@Config`；宿主插件在“启动前声明 Feature”时会把 Feature 的配置 schema 合并进宿主插件的 schema（namespaced key：`${FeatureCtor.featureKey ?? FeatureCtor.name}.${fieldName}`）。约定上建议 Feature 只暴露一个字段名为 `config`，这样 UI 会更像“一个 feature 一组配置”。
- 更推荐的写法：用 `configs.use(schema)` 代替 `@Config + :Config<typeof schema>`，例如 `config = this.configs.use(schema)`（零类型标注）；schema/source 会在构建时由 `configSource` 插件注入注册，从而在插件启动前即可被 HMR/UI 读取。
- 注意：`configs.use(schema)` 不支持 `#private` 字段（运行时无法注入）；请使用普通字段（`private foo = ...`）。

## 防呆规则（避免“能跑但 UI/DI 不对”）

- **不要在 constructor / field initializer 里读取 `configs.use(...)` 的值**：它在注入前是 sentinel，读取会抛错；把读取放到 `init()`/方法里。
- **Feature 如果有配置或 decorator-required deps，就必须“启动前声明”**：
  - 有工具链：用 class-field `foo = this.features.use(FooFeature)`，让 `configSourcePlugin` 注入 `__registerUsedFeatures__(PluginCtor, FooFeature)`。
  - 无工具链 / 动态 `init()` 里才 `features.use(...)`：用 `@UseFeature(FooFeature)`（或手动在模块加载时调用 `__registerUsedFeatures__(PluginCtor, FooFeature)`）。
  - 如果 Feature 既没有 `@Config/configs.use` 字段，也没有 `pluginMethodDecorator()` 声明 deps，则可以纯运行时组合，无需声明。

另外：core 在 DEV 模式会对“有 config/requiredDeps 但未声明的 Feature”打 warn，帮助尽早发现“能跑但 UI/DI 不对”的误用。
如需更强约束，可在 registry 配置里设置 `featureDeclarationPolicy: "error"`（或在测试中用 `commitStrict()`）让这类误用直接失败。
