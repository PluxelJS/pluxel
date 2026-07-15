# Lazy package-optional plugin integration

> 状态：设计已收敛，等待实现。本文定义目标模型，不是当前 API；实现完成前，当前作者用法仍以
> [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 为准。

## 结论

普通 optional plugin dependency 使用由 Pluxel 执行的 lazy import descriptor：

```ts
const Audit = defineOptionalPlugin(() =>
	import('pluxel-plugin-audit').then((module) => module.AuditPlugin),
)

@Plugin({ name: 'OrdersPlugin' })
export class OrdersPlugin extends BasePlugin {
	override init() {
		this.plugins.use(Audit, (audit) => audit.registerSource(this))
	}
}
```

provider 保持普通插件，不增加任何 optional-specific API：

```ts
@Plugin({ name: 'AuditPlugin' })
export class AuditPlugin extends BasePlugin {
	// normal plugin lifecycle and public API
}
```

`defineOptionalPlugin()` 不立即 import。consumer 正常完成 start 后，Pluxel route 异步解析 descriptor；包不存在、模块损坏或
provider start 失败都不会把 consumer 变成 failed。import 成功的 constructor 进入正常 graph transaction，之后仍由
PluginService running watcher 驱动 callback 和 cleanup。

这是真正的 package-optional：provider implementation package 在 consumer 运行、部署或不包含该 capability 的 application
build 中可以不存在；optional resolution 失败只是 availability fact，不是 consumer required dependency failure。独立插件包在
生成 dts/typecheck 时仍通常把 provider 作为 dev dependency 安装，这不进入发布后的 runtime dependency。

## 作者模型

| 意图 | 唯一作者入口 | 加载方式 | consumer start 是否等待 |
| --- | --- | --- | --- |
| 没有 provider 就无法工作 | constructor parameter | static import / host catalog | 是 |
| provider 只提供增强能力 | `defineOptionalPlugin()` + `plugins.use()` | system-owned lazy import | 否 |
| plugin 内部 lazy composition | `defineLazyFeature()` + `features.load()` | consumer-owned feature import | 按调用点决定 |

constructor 继续是 required dependency 的唯一事实源。optional descriptor 只声明“如果这个 implementation 能被加载并运行，
就执行 integration”，不创建 required graph edge。

## API

### Descriptor

```ts
type OptionalPluginLoader<T extends PluginConstructor> = () => Promise<T>

interface OptionalPlugin<T extends PluginConstructor> {
	readonly load: OptionalPluginLoader<T>
	/** @internal toolchain/runtime metadata */
	readonly key?: string
}

function defineOptionalPlugin<T extends PluginConstructor>(
	load: OptionalPluginLoader<T>,
): OptionalPlugin<T>
```

标准写法要求 loader 最终返回一个 plugin constructor，而不是整个 module：

```ts
const Audit = defineOptionalPlugin(() =>
	import('pluxel-plugin-audit').then(({ AuditPlugin }) => AuditPlugin),
)
```

这样 TypeScript 直接推导 callback 类型，不写 plugin ID 字符串，也不要求 provider 声明 contract/`provide()`。descriptor 必须是
module-level `const`，loader 必须包含静态可分析的 literal dynamic import；这与现有 `defineLazyFeature()` 约束一致，便于
Rolldown/Vite 保持确定语义。

名字使用 `defineOptionalPlugin`，不使用 `definePluginContract`：它明确指向一个 implementation package 并请求系统尝试加载，
不是 implementation-neutral protocol。需要多个可替换 provider 时，仍可使用现有 abstract base token/host provider selection，
但那不是普通 optional dependency 的默认复杂度。

### Integration

```ts
plugins.use<T extends PluginConstructor>(
	optional: OptionalPlugin<T>,
	callback: (plugin: InstanceType<T>) => void | (() => void),
): () => void

plugins.get<T extends PluginConstructor>(
	optional: OptionalPlugin<T>,
): InstanceType<T> | undefined
```

规则：

- `use()` 注册 availability subscription，并请求 route 解析 descriptor；
- consumer start 不 await optional import、provider registration 或 provider start；
- provider running 后执行 callback；
- provider stop/replacement 前执行旧 callback cleanup；
- replacement running 后用 caller-bound 新 instance view 重绑；
- consumer stop 时 unsubscribe 并 cleanup；
- `get()` 只读取当前 running snapshot，不触发同步等待；长期集成必须使用 `use()`；
- callback/cleanup failure 只产生 integration diagnostic，不改变 provider/consumer lifecycle state。

不再把 concrete provider constructor 直接传给公开 `plugins.use()`。required 使用 constructor，optional 使用
`OptionalPlugin<T>`，调用点不会混淆“包必须存在”和“包可以不存在”。

## Runtime ownership

dynamic import 由 descriptor 声明，但由 Pluxel 执行和接管：

```text
consumer init
  -> plugins.use(optional descriptor)
  -> subscription 进入 consumer effects
  -> consumer 正常完成 current graph commit

route optional scheduler
  -> load descriptor
     ├─ absent: record unavailable，结束
     ├─ broken: record diagnostic，结束
     └─ ctor: validate @Plugin metadata
              -> dedupe by canonical plugin ID/module owner
              -> normal graph update transaction
              -> RuntimeState 决定是否 enabled
              -> running watcher bind callback
```

core 不负责 package import。`OptionalPlugin` descriptor 与 `PluginHost` 类型位于 core/作者入口，但真正执行 loader 和提交 graph
update 的 scheduler 由 static/dynamic route 提供；这保持 `core <- runtime <- route` 依赖方向。

### Provider ownership

成功解析的 provider 成为 route-owned 正常 plugin node，不由某个 consumer 私有持有：

- 多个 consumers 请求同一 provider 时复用同一 graph node；
- consumer stop 只移除自己的 subscription，不自动卸载共享 provider；
- provider 卸载、replacement 和 shutdown 继续走现有 graph/effects；
- route reload/shutdown 决定 provider node 的最终所有权，不使用 consumer reference count；
- optional descriptor 不绕过 RuntimeState enabled/config/persistence policy。

这避免“consumer 自己 new/register/start plugin”，也避免为 optional integration 新建第二套 lifecycle。

### 调度时机

`plugins.use()` 常在 consumer `init()` 中调用，而当前 graph commit 尚未结束。scheduler 只记录请求，在当前 commit 完成后再开启
optional load/update，禁止 nested graph transaction。consumer 在 import 完成前 stop 时取消 subscription；若没有其他活跃请求，
尚未开始的 load 可以取消，已经完成注册的 route-owned provider 不做隐式卸载。

### Absent 与 broken

只有“目标 package/module 本身无法解析”属于正常 absent。以下情况属于 broken provider，仍不阻塞 consumer，但必须记录明确
诊断：

- provider 存在但其 transitive dependency 缺失；
- module evaluation 抛错；
- loader 没有返回 `@Plugin` constructor；
- graph registration/verification 冲突；
- provider init failure。

不能把所有 import exception 都静默吞成“可选包不存在”，否则真实发布错误无法发现。

### Retry

- production static distribution 对 build 时 absent 的 optional package 不做运行时安装或无界重试；
- Vite/dynamic route 可在 package discovery、lockfile/workspace change 或显式 reload 后重试；
- 同一个 descriptor generation 的失败不做循环重试；
- HMR replacement 产生新 generation，复用现有 module ownership 和 watcher rebind。

## Toolchain

工具链必须识别 `defineOptionalPlugin(() => import(<literal>).then(<export selection>))`，因为普通 bundler 无法区分“允许缺失的
import”与真正的依赖错误。

### Independent plugin package

`pluginPackage()`：

- 保留 provider 为 external lazy import，不打入 consumer package；
- 将 provider package 同步为 `peerDependencies` + `peerDependenciesMeta.optional = true`；
- optional descriptor 是 package optional 的唯一源码事实，不再用任意 dynamic import 猜语义；
- dts/typecheck 构建通常仍需在 authoring workspace 安装 provider 作为 dev dependency；发布/部署不要求安装；
- metadata 同步必须幂等，不能在第二次构建丢失 optional 语义。

### Static application

`staticApplication()` 在完整应用 graph 中处理 optional import：

- provider 在 build workspace 可解析：作为 fixed distribution 的 optional candidate bundle/chunk，runtime 可按 descriptor 注册；
- provider 不可解析：生成明确 absent descriptor，不使 build 失败，也不留下 deployment external import；
- build 完成后 catalog candidate closure 固定，目标机不能临时安装包把 absent candidate 提升为 available；
- RuntimeState 仍决定已打包 candidate 是否 enabled；
- nf3 只追踪实际进入 distribution 的 provider residual dependencies。

因此 static 路线仍是可搬运、无外部 `@pluxel/*` deployment import 的固定产物；“optional”发生在 build-resolved candidate 和
runtime enabled state，不把目标机重新变成 package install host。

### Vite development

- descriptor 在真正请求前不执行 import；
- missing import rejection 由 optional scheduler分类，不击穿 consumer lifecycle；
- package 后安装/出现时，route invalidation 可以重试；
- import 必须通过同一个 Vite SSR ModuleRunner/source conditions，保持 constructor identity 与 HMR ownership；
- 不使用 `@vite-ignore` 绕过 module graph。

### Import tracker

dependency collector 应按作者语义采集：

- constructor static import：required plugin package；
- `defineOptionalPlugin()` 内 literal import：optional plugin package；
- 其他 dynamic import：普通代码，不自动解释成 plugin dependency。

producer/consumer manifest schema、optional peer metadata 和连续构建幂等性仍按
[`PLUGIN_PACKAGE_DEPENDENCY_METADATA.md`](PLUGIN_PACKAGE_DEPENDENCY_METADATA.md) 修正。

## 与 abstract contract 的关系

abstract plugin base 仍适合另一类问题：consumer 依赖一个 implementation-neutral capability，由 host 在多个 providers 中选择。
它要求共享 contract package，并由 provider `@Plugin(AbstractBase)` 实现。

普通“如果这个具体插件包存在就增强”的场景不强制抽 contract：

```text
具体 optional implementation  -> defineOptionalPlugin(() => import(...))
可替换 provider abstraction    -> abstract base token + host selection
```

两者解决的问题不同，不要求每个 provider 为 optional consumers 建协议层。

## 不采用的方案

- consumer 直接执行 raw `import()`：缺少 route scheduler、graph transaction、dedupe 和错误分类；
- 顶层 static import + `plugins.use(ConcreteCtor)`：包缺失时模块加载先失败，不是真 optional；
- `plugins.provide()`/capability lease：要求 provider 感知 optional integration，并重复 graph lifecycle；
- string plugin ID：类型、export selection 和 package provenance 都需手工维护；
- target deployment runtime external import：破坏 static distribution closure；
- 把任意 dynamic import 当 optional plugin：误判普通 lazy code，metadata 不可靠。

## 迁移计划

1. 在 core 定义 `OptionalPlugin<T>`/`defineOptionalPlugin()`，PluginHost 接受 descriptor；
2. 在 static/dynamic route 增加共享 optional scheduler contract，各自接入现有 graph update；
3. Rolldown production pipeline 和 Vite source preset 识别同一 descriptor 语义；
4. static freezer 支持 resolvable candidate bundling 与 unresolved absent replacement；
5. package build 同步 optional peer metadata，并修复 manifest schema/幂等性；
6. 迁移所有 `plugins.use(ConcreteCtor)` 用例，不要求 provider 增加代码；
7. 覆盖缺包、broken package、disabled、dedupe、HMR、rollback、static closure 和跨平台 fixture；
8. 同步 active docs、user docs、templates 和 package README，完成后删除本 proposal。

## 验收条件

1. 独立 consumer plugin 只在 authoring/dev 使用 provider，发布产物不要求 provider；application build/start 在 provider
   未安装时成功且核心功能正常；
2. provider 不包含 optional-specific runtime 逻辑；
3. optional import 不延迟或阻塞 consumer running；
4. absent 与 broken provider 有不同、可行动的诊断；
5. 多 consumer 请求只产生一个 provider graph node，consumer stop 不误卸载共享 provider；
6. provider disabled、failed、stop、replacement、rollback 的 callback/cleanup 次数确定；
7. Vite ModuleRunner 下 constructor identity、module invalidation 和 HMR ownership 正确；
8. static provider absent 时无 external import/residual，present 时进入固定 candidate closure；
9. plugin package 正确生成 optional peer metadata，连续构建保持幂等；
10. constructor required dependency 与 optional descriptor 不混淆；
11. Workbench enabled/disabled 不改变 optional plugin lifecycle 语义。
