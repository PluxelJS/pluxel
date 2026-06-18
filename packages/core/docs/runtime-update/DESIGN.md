# Runtime Update Design

本文档描述一次克制的 runtime core 重设：让 core 高效支持 HMR、动态加载、配置变更和未来 package refresh，同时避免把 Vite、Module Federation、worker 编译等开发期细节塞进 core。

当前落地状态和接手清单见 `packages/core/docs/runtime-update/STATUS.md`；设计合理性和推进判断见 `packages/core/docs/runtime-update/RATIONALE.md`。本文档只记录目标设计、边界和被否决的方向。

核心判断：

- HMR 不是 core 的概念，"运行时声明更新"才是 core 的概念。
- 插件身份不能依赖 constructor 引用；constructor 只是某次 module evaluation 产出的实现。
- 只把能删除现有补丁的抽象放进 core；不能删除补丁、只让代码更像架构的抽象暂不做。

## 1. 当前问题

现有系统已经有不少正确的底层能力：

- `PluginService.replace()` 能替换实现并重启受影响子树。
- `PluginService.commit()` 有 draft/build/confirm、拓扑 stop/start、失败隔离。
- loader 有 module -> exported plugin declaration 的索引。
- HMR pipeline 能用 Vite module graph 找到变更入口。

问题不是缺能力，而是边界错位。

### 1.1 Core 事务边界不完整

HMR 更新现在横跨多个状态面：

- loader transaction
- core registry draft
- config enablement
- module anchor
- commit retry
- rollback

因此外层需要知道 core draft 在什么时候失效，失败后要怎么 `resetDraft()`，以及 retry 前如何把 module declaration 再同步回 core draft。这使 HMR pipeline 变成 runtime 事务协调器。

这类逻辑应该收进 core/registry 的更新事务，外层只提供变更事实。

### 1.2 插件身份依赖 constructor 引用

当前 DI token 很大程度上依赖 constructor 引用。在 HMR、monorepo link、不同 exports condition、Vite SSR runner、builtin preload 等场景下，同一个插件 id 可能被评估出多个 constructor 引用。

结果是 loader 必须做 constructor 参数 token 归一化，修复"同 id 不同引用"导致的假缺依赖。

这是根因问题，不是小实现问题。

### 1.3 Dev adapter 侵入 runtime 语义

HMR handles、UI federation compiler、worker watcher 等开发期能力通过 side channel 挂到 runtime context。它们能工作，但让 authoring API、runtime API、dev server 生命周期互相知道太多。

core 不应该知道这些工具；但 core 应该暴露足够清晰的 commit summary，让这些工具可以低成本响应 runtime 更新结果。

## 2. 设计目标

### 2.1 必须满足

1. **删除 constructor token normalization 这类补丁**
   - 同一个插件 id 的不同 constructor 引用不应破坏依赖解析。

2. **统一 runtime declaration update 的事务边界**
   - declare/replace/remove、validate、commit、rollback、retry 必须在一个语义闭包内。

3. **保持热路径性能**
   - 插件实例化、依赖解析、watcher 通知不能因为设计重设而每次多层 Map/Promise/事件总线。

4. **保留 adapter 自由度**
   - Vite HMR、static build、package install、Module Federation artifact 编译可以各自存在，不强制进入统一 provider 框架。

5. **逻辑必须比现在更容易推理**
   - 失败路径必须能一句话解释：update commit 成功则声明和运行态一起前进，失败则声明和 draft 都回滚。

### 2.2 非目标

- 不把 Vite module graph 放进 core。
- 不把 Module Federation 放进 core。
- 不把 worker/UI artifact 编译抽成 core provider。
- 不做事件溯源或全量 update log。
- 不要求所有运行模式一次性迁移到新 API。

## 3. 核心设计

只引入两个 core 能力。

## 3.1 PluginKey：插件身份与实现分离

### 设计

插件身份用稳定 key 表示：

```ts
type PluginKey = {
	id: string
	fork?: string
}
```

一次具体实现用 implementation 表示：

```ts
type PluginImplementation = {
	key: PluginKey
	ctor: PluginConstructor
	moduleId: string
	exportKey: string
	revision: string
}
```

依赖图、enablement、fork selection、status、watcher 都以 `PluginKey` 为语义身份。constructor 只在实例化时使用。

### 必要性

这是唯一能从根上解决 constructor 引用漂移的设计。

如果继续用 constructor 做 DI token，就必须继续在 HMR path 上修参数 token；而每新增一个 module realm 或 authoring pattern，都可能再补一次。

### 性能影响

负面影响：

- declaration build 阶段需要把 decorator 参数从 constructor token 解析成 `PluginKey`。
- 兼容旧 API 时，constructor -> key 需要一次 lookup。
- graph build 期间会多一些 key normalization 成本。

控制方式：

- commit/build 阶段把 `PluginKey` 编译成 slot number。
- runtime hot path 继续走 slot/array，不在插件注入时反复 Map 查找。
- `PluginKey` 内部可 canonicalize 为字符串 key，例如 `id` 或 `id#fork`，避免对象比较。

预期结果：

- 启动和 HMR commit 有小幅额外成本。
- 插件运行中读取依赖、watch instance、生命周期检查不增加可见成本。
- 删除 token normalization 后，HMR 更新的总成本可能下降，尤其是多插件、多 dependent 场景。

### 逻辑清晰度

清晰度显著提升：

- "插件是谁"由 key 决定。
- "这次加载到哪个 class"由 implementation 决定。
- "是否需要重启"由 key 的 implementation revision 变化决定。

这比"同一个 constructor 既是身份又是实现"更符合 HMR 语义。

### 风险

- 迁移期必须兼容 `features.dep(SomePluginCtor)` 这类 API。
- decorator metadata 仍然可能记录 constructor，需要在 graph build 阶段解析。
- fork key 的格式必须稳定，否则持久配置会受影响。

## 3.2 RuntimeUpdateTransaction：core 拥有声明更新事务

### 设计

新增最小事务 API：

```ts
type RuntimeUpdateReason =
	| 'startup'
	| 'hmr'
	| 'config'
	| 'package-refresh'
	| 'test'

type RuntimeModuleDeclaration = {
	moduleId: string
	implementations: PluginImplementationInput[]
}

type RuntimeUpdateCommitOptions = {
	missingDeps?: 'fail' | 'disable-and-retry'
	maxRetries?: number
	strict?: boolean
}

interface RuntimeUpdateTransaction {
	upsertModule(module: RuntimeModuleDeclaration): void
	removeModule(moduleId: string, options?: { scope?: 'runtime' | 'persistent' }): void
	restart(key: PluginKeyLike, options?: { cascadeDependents?: boolean }): void
	commit(options?: RuntimeUpdateCommitOptions): Promise<Result<RuntimeUpdateSummary, Error>>
	rollback(): void
}

ctx.registry.beginUpdate({ reason: 'hmr' })
```

外层 adapter 的职责只剩：

1. 评估或读取模块。
2. 把 exports 解析成 `RuntimeModuleDeclaration`。
3. 调用 transaction。

HMR 不再直接协调 loader tx、core draft 和 retry。

### 必要性

这是为了删除 HMR pipeline 中对 core 内部 draft/rollback/retry 的知识。

如果没有这个事务，任何外层更新来源都会重复实现：

- replace declarations
- sync enabled modules to draft
- commit
- on failure rollback declaration state
- reset core draft
- missing deps retry

这不是 HMR 特有逻辑，是 runtime declaration update 的共同语义。

### 性能影响

负面影响：

- 每次更新会创建一个 transaction 对象和 change set。
- 单文件 HMR 更新会多一次 module declaration normalization。
- retry 逻辑收进 core 后，commit path 分支更多。

控制方式：

- transaction 只记录 touched modules，不复制整个 registry。
- module declaration 层使用 journal/undo log，而不是 deep clone。
- startup path 可以直接用同一个 transaction API，但内部保留 fast path：无 retry、无 rollback journal 扩展时少分配。
- no-op update 必须短路，不触发生命周期 stop/start。

预期结果：

- HMR 单次更新的 orchestration 分配略增或持平。
- 由于少了外层 re-sync、重复 normalization、重复 rollback，复杂更新的总成本应下降。
- core commit hot path 需要 benchmark，不能凭感觉合并。

### 逻辑清晰度

清晰度提升点：

- update 成功：module declarations、core graph、runtime instances 同步前进。
- update 失败：module declarations 和 core draft 同步回滚。
- retry 策略在 commit options 中声明，不散落在 pipeline。

事务的职责边界也很窄：只处理 plugin declarations 和 lifecycle commit，不处理 UI artifact、worker、Vite graph。

### 风险

- 如果 transaction API 设计太大，会把 adapter 问题吸进 core。
- 如果 summary 不足，adapter 又会重新读取内部状态。
- 如果 rollback journal 粒度太粗，会影响大批量更新性能。

## 4. 运行时数据模型

### 4.1 Declaration Registry

core 需要维护 module ownership：

```ts
moduleId -> PluginImplementation[]
pluginKey -> current implementation
pluginKey -> owning moduleId
```

这部分可以从 loader 下沉到 core，但只下沉纯 runtime declaration，不下沉文件扫描、workspace profile、Vite id normalization。

### 4.2 Graph Build

graph build 输入从 constructor set 变成 implementation set：

1. 收集 enabled `PluginKey`。
2. 解析每个 key 当前 implementation。
3. 从 implementation ctor 读取 decorator metadata。
4. 把 dependency token 规范化为 `PluginKey`。
5. 编译为 slot graph。

graph 内部仍应使用 slot number，以保持现有性能优势。

### 4.3 Replacement Semantics

当同一个 `PluginKey` 的 implementation revision 变化：

- 该 key 标记为 replaced。
- 依赖它的子树按现有 cascade 规则 restart。
- 旧 constructor 可以作为 alias 兼容旧 token，但 alias 只存在于 build/compat 层，不作为身份来源。

### 4.4 Commit Summary

commit summary 要成为 adapter 的稳定观察面：

```ts
type RuntimeUpdateSummary = {
	reason: RuntimeUpdateReason
	added: PluginKey[]
	removed: PluginKey[]
	replaced: Array<{ key: PluginKey; fromRevision: string; toRevision: string }>
	restarted: PluginKey[]
	failed: PluginKey[]
	touchedModules: string[]
	autoDisabled: PluginKey[]
}
```

UI compiler、worker watcher、plugin status/workbench consumers 可以消费 summary，但不需要知道 core draft 细节。

## 5. Adapter 边界

### 5.1 Vite/HMR Adapter

Vite adapter 负责：

- 监听文件变化。
- 使用 Vite module graph 选择需要重新评估的 entry。
- import module。
- 从 exports 收集 plugin constructors。
- 调用 `beginUpdate({ reason: 'hmr' })`。

Vite adapter 不负责：

- core draft rollback。
- missing deps retry。
- dependent restart 计算。
- constructor token normalization。

### 5.2 Module Federation/UI Compiler

UI federation 仍留在 runtime-dynamic/runtime adapter。

短期只做一件事：从 runtime commit summary 或 plugin effect lifecycle 获取信号，而不是挂在 HMR transaction 内。

暂不引入统一 ArtifactProvider，原因：

- UI remote build、worker bundle、static build 的缓存和错误模型不一致。
- 现在抽象 provider 不能删除足够多的补丁。
- 会引入额外异步调度层，增加状态推理成本。

### 5.3 Static Runtime

static runtime 可以使用同一个 update transaction：

- startup: batch upsert modules
- static HMR: upsert changed module
- removed plugin: remove module

但 static runtime 不需要引入 Vite 或 HMR API。

## 6. 性能预算

### 6.1 允许的新增成本

- commit/build 阶段做 `PluginKey` normalization。
- update transaction 创建小型 journal。
- commit summary 构造稳定数组。

这些都发生在更新边界，不在插件业务热路径。

### 6.2 不允许的新增成本

- 插件实例方法调用时查 runtime registry。
- 每次依赖访问都做 string Map lookup。
- 每个 plugin start 都经过全局事件总线。
- HMR 单文件更新复制整个 declaration registry。
- UI/worker artifact 编译被迫进入 core commit critical path。

### 6.3 Benchmark 要求

迁移前后至少测：

- cold startup: 100/500/1000 plugins
- single plugin HMR replace
- base provider replace with 100 dependents
- commit failure + missing deps retry
- no-op commit

通过条件不是"绝对更快"，而是：

- no-op commit 不变慢到可见程度。
- single replace 不因 key model 明显退化。
- dependent cascade 逻辑更少重复 work。
- 删除 normalization 后复杂 HMR 不更差。

## 7. 逻辑清晰度标准

每个设计点必须能回答：

1. 这是不是 runtime core 的事实？
2. 它能不能删除一个现有补丁或重复事务逻辑？
3. 它是否进入插件业务热路径？
4. 失败时状态如何回滚？
5. 外层 adapter 是否还需要知道 core 内部 draft？

如果答案不清楚，就不要进 core。

## 8. 拒绝的设计

### 8.1 全局 RuntimeKernel + SourceDriver + ArtifactProvider

暂不做。

优点：

- 概念完整。
- 长期可能统一 HMR、static、package refresh、UI artifact。

拒绝原因：

- 当前证据不足。
- 抽象面积太大，会把 artifact 编译生命周期带进 core。
- 增加 Promise、状态机、错误聚合和调度层。
- 不能直接解决 constructor token 漂移这个根因。

### 8.2 继续保留 constructor identity，只加强 bridge

不接受作为长期设计。

优点：

- 迁移少。
- 短期风险低。

拒绝原因：

- 每个新 module realm 都可能再触发同类问题。
- bridge 越强，runtime 事实来源越不清晰。
- HMR 正确性依赖补丁顺序。

### 8.3 把 Vite module graph 抽象进 core

不做。

Vite module graph 是 adapter 的事实，不是 runtime core 的事实。core 只需要知道 module declaration changed。

## 9. 迁移计划

### Phase 1: 引入 transaction 外壳

- 新增 `ctx.registry.beginUpdate()`。
- 内部先复用现有 `register/replace/unregister/commit/resetDraft`。
- HMR pipeline 只改到通过 transaction commit，不改变 PluginKey 模型。

目标：先收敛 rollback/retry 边界。

### Phase 2: Declaration ownership 下沉

- 将 module -> plugin declarations 的纯运行时索引迁入 core。
- loader 保留 workspace scan、entry resolve、profile、path normalization。
- `LoaderService.beginBatch()` 变成兼容层，委托 core transaction。

目标：减少 loader 对 core draft 的直接操作。

### Phase 3: PluginKey graph

- 引入 `PluginKey` normalization。
- graph build 使用 key -> slot。
- constructor API 通过 compat resolver 转成 key。
- 保留旧 constructor token alias 一段时间。

目标：删除 HMR path 上的 constructor token normalization。

### Phase 4: Adapter 清理

- HMR executor 不再 reset core draft。
- HMR executor 不再 sync affected modules to core draft after failure。
- UI compiler 只消费 commit summary 或 plugin lifecycle，不参与 runtime transaction。

目标：让 HMR adapter 回到"evaluate module + submit declaration update"。

### Phase 5: 删除旧补丁

- 删除 constructor param normalization。
- 删除外层 retry re-sync。
- 删除不再需要的 HMR runtime handles 中与 core transaction 重叠的能力。

## 10. 推荐 API 草案

```ts
const tx = ctx.registry.beginUpdate({ reason: 'hmr' })

tx.upsertModule({
	moduleId,
	implementations: collectPluginImplementations(moduleId, mod),
})

const result = await tx.commit({
	missingDeps: 'disable-and-retry',
	maxRetries: 8,
})

if (!result.ok) {
	ctx.logger.error('runtime update failed', { error: result.err })
}
```

`collectPluginImplementations()` 可以留在 adapter 或 helper 包中。core 不 import Vite，也不 import file system。

## 11. 最终判断

这次重设只应该做两件事：

1. 用 `PluginKey` 解除插件身份和 constructor 引用的绑定。
2. 用 `RuntimeUpdateTransaction` 让 core 拥有声明更新的事务边界。

其他抽象先克制。UI federation、worker、static build 的 artifact 生命周期不属于本轮 runtime core 设计；除非未来有新的充分证据，否则不要抽 provider。

设计成功的标志不是类变多，而是这些代码变少：

- token normalization patch
- HMR pipeline 中的 `resetDraft`
- commit failure 后的外层 re-sync
- runtime handles 中用于绕过正式边界的入口
