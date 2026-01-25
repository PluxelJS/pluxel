# 插件系统（core/plugins）

这套目录承载的是 **核心插件系统**：装饰器/元数据、DI 定义层（draft/build/commit）、运行时 registry（commit/restart/unregister/fork），以及插件生命周期 actor；并提供“插件内组合”的 Feature 基础设施（BaseFeature/FeatureHost）。

插件系统的测试更适合集中放在 `packages/core/tests/`（黑盒/集成式，用 `@pluxel/core/test` 跑真实插件行为），这里主要放实现与约定说明。

## 目录结构（按职责分层）

对外 API 仍然通过 `plugins/index.ts` 统一导出；实现按职责分到 `runtime/`、`decorators/`、`composition/`，减少单目录噪音并提升可维护性。

### runtime/（运行时 orchestrator）

- `runtime/PluginService.ts`：运行时 orchestrator（commit、restart、unregister、fork 管理、实例缓存等）
- `runtime/PluginActor.ts`：单插件生命周期状态机（start/stop/retry/asyncError）+ selectors
- `runtime/LifecycleManager.ts`：把 actor 挂到插件实例上、封装超时/停止策略（供 `PluginService` 使用）
- `runtime/fork.ts`：fork ctor 的生成与 identity 规则（`id#forkId`）
- `runtime/PluginDefinitions.ts`：DI 定义层（draft 注册/撤销 + build/confirm/resetDraft）
- `runtime/commit.ts`：`PluginService` 使用的纯逻辑（init plan / start/stop scheduler）

### decorators/（装饰器与元数据）

- `decorators/PluginDecorator.ts` + `decorators/decorator/*`：`@Plugin/@Config`、元数据存储、param tokens、requiredDeps、configSource、clone definition
- `decorators/decoratorRuntime.ts`：跨插件 decorator 运行时（按 token resolve 依赖 + 注入 caller ctx + 缓存）

### composition/（实例侧基础设施）

- `composition/BasePlugin.ts`：`ctx` 注入与 lifecycle runtime 适配（构造热路径）
- `composition/FeatureHost.ts` / `composition/BaseFeature.ts`：插件内组合 + 可选依赖 `dep()`
- `composition/ConfigHost.ts`：`configs.use(schema)` 的声明型配置入口

## 维护原则

- 对外 API 通过 `plugins/index.ts` 统一导出；内部实现尽量收敛到三层目录（runtime/decorators/composition），减少主目录噪音。
- 任何改动优先用 `packages/core/tests/` 的黑盒场景验证行为不变。
- Feature 组合入口：插件通过 `this.features.use(FeatureCtor)` 绑定子模块；若 Feature 内部使用 `pluginMethodDecorator()` 声明 requiredDeps，则宿主插件需在“启动前”声明它（`@UseFeature(FeatureCtor)` / `@UseFeature(F1, F2, ...)`，或在 HMR/rolldown 流水线里让 `features.use(...)` 的 class-field 由 `configSource` 插件注入 `__registerUsedFeatures__(Ctor, FeatureCtor)`），这样依赖约束才能提升到宿主插件的 DI 校验层，保持行为可预测。
- Feature 配置归因：Feature 里也可以用 `@Config`；宿主插件在“启动前声明 Feature”时会把 Feature 的配置 schema 合并进宿主插件的 schema（namespaced key：`${FeatureCtor.featureKey ?? FeatureCtor.name}.${fieldName}`）。约定上建议 Feature 只暴露一个字段名为 `config`，这样 UI 会更像“一个 feature 一组配置”。
- 更推荐的写法：用 `configs.use(schema)` 代替 `@Config + :Config<typeof schema>`，例如 `config = this.configs.use(schema)`（零类型标注）；schema/source 会在构建时由 `configSource` 插件注入注册，从而在插件启动前即可被 HMR/UI 读取。
- 注意：`configs.use(schema)` 不支持 `#private` 字段（运行时无法注入）；请使用普通字段（`private foo = ...`）。
- 注意：`dep()`/依赖注入的 caller-injection 通过“对象委托 + 覆盖 ctx”实现；如果插件方法依赖 JS 私有字段（`#foo`），在被当作依赖使用时可能会触发 brand-check 错误。建议插件代码避免 `#private`，使用 `private foo` 或把状态放进闭包/服务里。

## 防呆规则（避免“能跑但 UI/DI 不对”）

- **不要在 constructor / field initializer 里读取 `configs.use(...)` 的值**：它在注入前是 sentinel，读取会抛错；把读取放到 `init()`/方法里。
- **Feature 如果有配置或 decorator-required deps，就必须“启动前声明”**：
  - 有工具链：用 class-field `foo = this.features.use(FooFeature)`，让 `configSourcePlugin` 注入 `__registerUsedFeatures__(PluginCtor, FooFeature)`。
  - 无工具链 / 动态 `init()` 里才 `features.use(...)`：用 `@UseFeature(FooFeature)`（或手动在模块加载时调用 `__registerUsedFeatures__(PluginCtor, FooFeature)`）。
  - 如果 Feature 既没有 `@Config/configs.use` 字段，也没有 `pluginMethodDecorator()` 声明 deps，则可以纯运行时组合，无需声明。

另外：core 在 DEV 模式会对“有 config/requiredDeps 但未声明的 Feature”打 warn，帮助尽早发现“能跑但 UI/DI 不对”的误用。
如需更强约束，可在 registry 配置里设置 `featureDeclarationPolicy: "error"`（或在测试中用 `commitStrict()`）让这类误用直接失败。

## Feature 的“唯一推荐 API”：`use()` + `dep()`

> 目标：**插件作者不用想太多**。Feature 负责“插件内组合”；`dep()` 负责“可选跨插件集成”。

### 1) `this.features.use(FeatureCtor)`（插件内模块化）

- 一个插件实例里，同一个 FeatureCtor 只会构造一次（缓存）。
- 若 Feature 继承 `HostBoundFeature<BasePlugin>`，则在插件里使用时会自动把宿主实例注入进去：

```ts
import { BasePlugin, HostBoundFeature, Plugin } from '@pluxel/core'

class CacheFeature extends HostBoundFeature<BasePlugin> {
  // constructor(ctx, host) 由 HostBoundFeature 提供；host 自动注入
  hit() {
    this.ctx.logger.info('cache hit', { host: this.host.ctx.pluginInfo.id })
  }
}

@Plugin({ name: 'MyPlugin' })
class MyPlugin extends BasePlugin {
  cache = this.features.use(CacheFeature) // 不需要 this.features.use(CacheFeature, this)
}
```

### 2) `this.features.dep(DepPlugin, cb?)`（可选跨插件集成）

`dep()` 是给“**可选依赖**”用的：依赖插件可能不存在、可能被关闭、也可能在下一次 commit 才出现。

- 直接取值（可能为 `undefined`）：

```ts
const dep = this.features.dep(OtherPlugin)
if (dep) dep.doSomething()
```

- 订阅式（推荐）：依赖出现 / 重启（实例变化）时回调会再次执行；依赖消失时会自动执行 cleanup。
- 若订阅时依赖已可用：会立即回调一次（同样支持 cleanup）。

```ts
this.features.dep(OtherPlugin, (dep) => {
  const off = dep.someChannel.on((x) => this.ctx.logger.info('got', { x }))
  return () => off() // dep 消失/重启时清理
})
```

语义约定：

- **回调只在“依赖可用”时执行**；不可用时不会执行。
- 若依赖在后续 commit 出现、或 restart 导致实例变化：会先跑 cleanup，再重新回调一次。
- `dep.ctx.caller` 会指向当前插件的 ctx（便于依赖侧用 `caller` 做 scope/权限/日志归因）。

### Required vs Optional：什么时候用哪个？

- **必须依赖（Required）**：用 constructor 注入 / decorator deps，让 commit 直接失败（语义最确定）。
- **可选集成（Optional）**：用 `features.dep(...)`；或做一个 `BridgePlugin` 专门负责“把两个插件可选地连起来”，让被集成的插件本体保持纯粹。
