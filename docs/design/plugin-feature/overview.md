# Plugin Feature Design

## Decision

Feature 从设计上分成两类，不再混用同一套语义：

- `use(FeatureCtor)`
  Required Feature。它是宿主插件的静态组成部分，依赖必须满足，允许参与启动前声明提取。
- `tryUse(spec)`
  Optional Feature。它按环境或配置决定是否启用，不影响主插件存活，允许缺依赖，允许不加载模块。

这份设计刻意拒绝两种旧思路：

- 不把 “optional” 放进 plugin constructor DI
- 不把 “可选 feature” 写成静态 `import` + 静态 `FeatureCtor`

原因很直接：

- `plugin` 是装载单元，constructor 依赖应该只表达 hard deps
- `feature` 才是可裁剪能力单元，optional 应该表达“是否激活”，不是“插件能否构造”
- 只做 runtime 依赖可选、不做 module loading 可选，是伪 optional

## Core Model

### 1. Required Feature

`use()` 对应“宿主结构的一部分”：

- 同一个宿主实例里，同一个 `FeatureCtor` 只构造一次
- 允许使用 `@UseFeature(...)` / `features.use(...)` 的声明期元数据传播
- 允许把 feature config 合并进宿主 plugin config
- 若 feature 声明 hard deps，这些约束会提升到宿主 plugin 的 DI 校验层

推荐写法：

```ts
class CacheFeature extends BaseFeature {
	// ...
}

@Plugin({ name: 'SearchPlugin' })
class SearchPlugin extends BasePlugin {
	cache = this.features.use(CacheFeature)
}
```

语义：

- `use()` 只接受静态 `FeatureCtor`
- 返回值始终存在：`T`
- 这是唯一允许参与 class-field 元数据提取的 feature 形式

### 2. Optional Feature

`tryUse()` 对应“条件挂载能力”：

- 条件可能来自依赖插件环境
- 条件也可能来自宿主配置
- 条件不满足时，feature 不启用，但主插件继续工作
- optional feature 默认必须支持 lazy load，避免静态 import 把主插件拖进 hard link

推荐模型：

```ts
type OptionalFeatureSpec<T extends BaseFeature> = {
	key: string
	requires?: readonly PluginToken[]
	when?: (ctx: Context) => boolean | Promise<boolean>
	load: () => Promise<new (ctx: Context, ...args: unknown[]) => T>
}
```

调用：

```ts
const ai = await this.features.tryUse({
	key: 'ai',
	requires: ['pluxel.ai'],
	when: (ctx) => ctx.configService.tryGetValidatedConfig()?.['feature.ai.enabled'] === true,
	load: () => import('./features/AiFeature').then((m) => m.AiFeature),
})

if (!ai) return
```

语义：

- `tryUse()` 返回 `Promise<T | undefined>` 或等价结果对象
- 只有它才允许 optional dependency / conditional activation / lazy loading
- `tryUse()` 不适合 class field，应在 `init()` 或其它运行期阶段调用

## Why Plugin Optional DI Is Rejected

对 plugin 来说，optional constructor dependency 没有稳定意义：

- plugin 经常是单独装载、启停、发布的单位
- constructor parameter 一旦出现，就会被读作 “这个依赖是启动前必须存在的”
- 把 `dep?: FooPlugin` 放进 plugin ctor，会把 hard/soft dependency 混成一层

因此：

- plugin constructor 只表达 required deps
- 可选集成不放进 plugin ctor
- 如果主插件要做软集成，应把它下沉到 feature 层

一句话：

**plugin 负责生存；feature 负责降级。**

## Runtime Optional vs Link-Time Optional

这是这套设计最重要的边界。

### Runtime Optional

指的是：

- 插件类型存在
- 模块已经能被当前包正常加载
- 只是宿主这次没有注册/启动该依赖插件

这种场景可以通过 registry 查询或 `features.dep(...)` 处理。

### Link-Time Optional

指的是：

- 依赖 feature 或依赖插件实现包本身可能不存在
- 一旦写成静态 `import`，主插件就会在模块求值阶段被连坐

这种场景不能只靠 `dep()` 或 requiredDeps 元数据解决。

所以真正的 optional feature 必须同时满足两点：

1. 依赖判定可选
2. 模块加载可选

如果只做到第 1 点，没有做到第 2 点，那只是“实例可缺失”，不是“feature 可选”。

## Loading Boundary

### `use()`

`use()` 只能接静态 class：

- 允许工具链提取 `features.use(FeatureCtor)` 元数据
- 允许 `@UseFeature(...)` 直接注册
- 允许 feature config merge 到宿主 config

所以它天然要求：

- feature class 可静态导入
- feature 模块属于宿主的 hard code path

### `tryUse()`

`tryUse()` 不能接静态 `FeatureCtor`，而是接 descriptor/spec：

- 先做条件判断
- 只有通过后才 `load()`
- `load()` 负责动态导入真正 feature 实现

这能避免：

- optional feature 模块求值过早
- optional 插件包不存在时拖垮主插件
- class-field 提取链路误把 optional feature 当静态组成部分

## Dependency Expression

### Required Feature Dependency

如果 feature 本身是 required feature，它的 hard deps 仍然应该是 required：

- 可以来自 feature ctor metadata
- 也可以来自 decorator-required deps
- 最终都必须提升回宿主 plugin 做校验

因为真正被 host 注册和验证的主体仍然是 plugin，不是 feature。

### Optional Feature Dependency

optional 依赖不应该默认编码成 ctor param `dep?: FooPlugin`。

原因：

- `reflect-metadata` 只能拿到类型，拿不到“这个参数是 soft dep”语义
- ctor 一旦半初始化，错误边界会变差
- optional feature 更像“激活条件”，不是“构造参数松绑”

因此 optional feature 的依赖应该写在 spec 上：

```ts
await this.features.tryUse({
	key: 'bridge',
	requires: ['pluxel.remote-search'],
	load: () => import('./features/RemoteSearchFeature').then((m) => m.RemoteSearchFeature),
})
```

如果 feature 需要在启用后继续监听外部插件生命周期变化，运行期仍然使用：

```ts
this.features.dep(RemoteSearchPlugin, (dep) => {
	// ...
})
```

也就是说：

- `tryUse()` 负责“要不要启用这个 feature”
- `dep()` 负责“启用之后，如何做可选跨插件协作”

两者不是重复关系。

## Config Boundary

配置也必须分 required / optional 两套边界。

### Required Feature Config

required feature 可以继续使用当前模型：

- feature 自己声明 `configs.use(...)` / `@Config`
- 启动前注册 feature 时，把 config schema 合并进宿主 plugin config
- UI 上以 namespaced key 呈现

这和 `use()` 的静态特性是匹配的。

### Optional Feature Config

optional feature 默认**不参与**启动前 feature config merge。

原因：

- 它不应该要求主插件静态导入 feature class
- 一旦要靠静态导入来拿 config schema，就已经接近 hard dependency

因此 optional feature 的配置建议分两层：

1. 宿主拥有的 gate config
   例如 `feature.ai.enabled`
2. feature 启用后的运行期私有状态

如果某个 optional feature 还需要一整套稳定、启动前可编辑的 schema：

- 要么把这部分 schema 提升成宿主拥有的静态 config
- 要么承认它已经不是严格意义上的 link-time optional
- 要么拆出一个稳定、轻量、总是可导入的 descriptor/contracts 模块

不要同时要求：

- feature 模块完全 optional
- 又要像 required feature 一样参加完整静态 schema 提取

这两件事天然冲突。

## Type Model

收敛后的类型应明确区分两条通道：

```ts
type RequiredFeatureCtor<T extends BaseFeature> = new (ctx: Context, ...args: unknown[]) => T

type OptionalFeatureSpec<T extends BaseFeature> = {
	key: string
	requires?: readonly PluginToken[]
	when?: (ctx: Context) => boolean | Promise<boolean>
	load: () => Promise<RequiredFeatureCtor<T>>
}

interface FeatureHost<Host> {
	use<T extends BaseFeature>(Ctor: RequiredFeatureCtor<T>, ...args: unknown[]): T
	tryUse<T extends BaseFeature>(spec: OptionalFeatureSpec<T>): Promise<T | undefined>
	dep<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined
	dep<T extends PluginIdentifier>(id: T, cb: (dep: InstanceType<T>) => unknown): () => void
}
```

关键点：

- `use()` 返回 `T`
- `tryUse()` 返回 `T | undefined`
- 只有 `tryUse()` 有 optional activation 能力
- `dep()` 继续是运行期 optional integration primitive

## Toolchain and Metadata Rules

### `use()`

保留当前静态提取能力：

- `features.use(...)` 仍要求 class field 在 module top-level
- `@UseFeature(...)` 仍然是无需工具链即可工作的声明方式
- required feature 的 config / required deps 仍会在声明期向宿主 plugin 传播

### `tryUse()`

不走 class-field metadata 提取：

- 不要求 `@UseFeature(...)`
- 不自动参与 feature config merge
- 不把 optional feature 声明提升成宿主 plugin hard deps

toolchain 只需要保证：

- `tryUse()` 不被误判成静态 feature 注册
- `load()` 的模块边界不被错误内联成硬依赖

## Recommended Authoring Rules

1. 一个能力如果宿主必须拥有，用 `use()`。
2. 一个能力如果缺失时应当优雅降级，用 `tryUse()`。
3. plugin constructor 不写 optional deps。
4. optional feature 不要静态 import 其实现 class。
5. optional feature 的 gate config 放在宿主自己手里。
6. 若 feature 启用后还需要跟随外部插件出现/消失，用 `dep()`。

## Migration

现有系统里已经稳定存在的是：

- `use()`
- `@UseFeature(...)`
- `dep()`
- feature config merge

下一步收敛目标是：

1. 保留 `use()` 作为 required feature 通道
2. 新增 `tryUse()` 作为 optional feature 通道
3. 明确 optional 只属于 feature activation，不属于 plugin constructor DI
4. 文档、lint、demo 全部围绕这条边界统一

## Summary

一句话：

**`use()` 表达“这个 feature 属于宿主结构本身”；`tryUse()` 表达“这个 feature 只是宿主在满足条件时挂上的能力”。只有后者才允许 optional dependency。**
