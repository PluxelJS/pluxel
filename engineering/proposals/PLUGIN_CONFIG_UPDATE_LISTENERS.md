# Plugin Config Update Listeners

> 状态：research proposal。本文描述尚未实现的行为；当前 API 和运行时事实仍以
> [`../CONFIG.md`](../CONFIG.md) 与 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 为准。

## 问题

当前 config patch/reset 在校验和持久化后自动 restart 运行中的 Plugin。配置保存与 Plugin restart 是两个不同意图：

- 保存配置只改变 durable desired state；
- restart 创建新 generation，并在启动时使用最新 desired config；
- 原地更新由当前 generation 把 desired config 投影到自己拥有的连接、缓存、并发限制和普通字段。

config mutation 不应隐式表达 restart。没有主动注册更新行为的 Plugin，配置保存后不应 restart，也不应被框架静默覆盖字段并
假装派生资源已经同步。

## 假设

- config mutation 是低频控制面操作，普通 Plugin method/property read 才可能位于高频路径；
- Plugin 作者负责把配置投影到自己拥有的运行时状态，框架只负责校验、持久化、串行调用和生命周期撤销；
- durable desired config 可以暂时领先 running generation 的 applied config，显式 restart 最终消费最新 desired config。

## 设计结论

- `configs.use(schema)` 保持现有签名和纯声明语义；
- Plugin 与 PluginPart 都可以在 `init()` 中为自己的 config declaration 显式注册一个 update listener；
- config patch/reset 默认只校验并保存 desired config，不自动 restart；
- 只有本次真正变化的所有 config declaration 都有 listener 时，才尝试原地应用；缺少任何 listener 就不调用任何 listener；
- 所有 listener 成功后，框架统一替换对应 config fields 并推进 owning Plugin 的 applied revision；
- listener 缺失或失败时保留 desired/applied 差异，等待后续 config update、显式 restart 或自然重启；
- listener 不返回 restart 指令。restart 始终是用户或宿主发起的独立 control-plane 操作；
- Plugin 热路径继续读取普通 number/object，不引入 signal、Proxy 或 framework getter。

## 作者 API

```ts
const Settings = v.object({
	timeout: v.number(),
	concurrency: v.number(),
})

@Plugin()
export class GatewayPlugin extends BasePlugin {
	private config = this.configs.use(Settings)

	private options = {
		timeout: 0,
		concurrency: 0,
	}

	async init() {
		this.options = projectOptions(this.config)

		this.configs.onUpdate(this.config, ({ desired }) => {
			this.options = projectOptions(desired)
		})
	}

	async request(input: Request) {
		const options = this.options
		return this.client.request(input, { timeout: options.timeout })
	}
}
```

候选公共类型：

```ts
export type ConfigUpdate<T extends object> = Readonly<{
	applied: Readonly<T>
	desired: Readonly<T>
	signal: AbortSignal
}>

export type ConfigUpdateListener<T extends object> = (
	update: ConfigUpdate<T>,
) => void | Promise<void>

export class PluginConfigs {
	use<TSchema extends StandardSchemaV1>(schema: TSchema): StandardSchemaV1.InferOutput<TSchema>

	onUpdate<T extends object>(current: Readonly<T>, listener: ConfigUpdateListener<T>): void
}
```

`onUpdate(this.config, listener)` 中的 `current` 有两个作用：

1. 从已注入字段推导 listener 的完整类型，不重复声明 schema output；
2. 验证 listener 绑定的是当前 Plugin/Part generation 的真实 config field，而不是任意相似对象。

它不是 ref，也不是响应式读取入口。listener 每次直接收到 revision-bound、deep-frozen 的 `applied` 与 `desired` snapshot。
`onUpdate()` 是纯运行时 registration，不进入 schema、decorator、toolchain metadata 或 `configs.use()` lowering。

## 注册与生命周期

`onUpdate()` 只允许在声明该 config field 的 Plugin 或 PluginPart 的 `init()` active window 中调用：

- 每个 config declaration、每个 generation 至多一个 listener；
- listener 自动绑定该 Plugin/Part 的 owner effects；
- init rollback、stop、restart、replacement 和 shutdown 自动撤销 listener；
- generation stop 会关闭新调用、abort `signal` 并等待已接纳 listener 退出，再清理其余 owner effects。

重复注册或传入非当前 config field 的对象直接 fail-fast。框架不定义多个 listener 的顺序，因为一个 declaration 根本不允许多个
listener；插件需要拆分逻辑时在自己的 callback 内组合普通函数。

## Desired 与 applied

每个 Plugin node 继续只有一个 durable config record 和一个 revision owner，但运行时需要保留两份事实：

```text
desired normalized composite + desired revision
    ConfigService 持有，持久化确认后推进

applied normalized composite + applied revision
    当前 generation 持有，启动或整次 listener apply 成功后推进
```

回调使用 `applied` / `desired`，不用 `previous` / `next`。如果 revision 2 应用失败，之后又保存 revision 3，新的 callback 基线仍是
最后成功应用的 revision 1：

```text
appliedRevision = 1
desiredRevision = 3
```

Plugin 应直接从 applied runtime 收敛到最新 desired runtime，不需要重放失败的 revision 2。

## Config mutation 行为

持久化路径保持现状：

```text
validate once
  -> stage normalized immutable snapshot
  -> flush
  -> confirm desired revision
```

确认 persistence 后不构造 restart operation，而是在当前 coordinator transaction 中完成以下步骤：

1. node 未运行：返回 `deferred`；下次启动自然使用最新 desired config。
2. node 运行：比较 generation 的 applied composite 与本次 desired composite，找出真正变化的 root/Part declaration slices。
3. 没有 slice 变化：直接推进 applied revision，不调用 listener，也不替换值相同的 field identity。
4. 任一变化 slice 没有 listener：不调用任何 listener，返回 `saved-not-applied`。
5. 所有变化 slice 都有 listener：按现有 children-before-owner 生命周期顺序逐个 `await` listener。
6. 全部成功：统一替换变化 declaration 的 config fields，然后推进整个 owning Plugin applied snapshot/revision。
7. 任一 listener 失败或 generation 被撤销：不替换 config fields、不推进 applied revision，也不自动 restart/stop。

先检查 listener 完整性再调用任何 callback，避免 root 已经更新而某个 Part 因没有 listener 永远无法参与。Plugin 与 Part 共用一个 owner
revision，因此只有整次 composite update 成功才能标记 applied，不建立 Part revision 或 partial-applied 状态。

normalized config 已被限制为有界的 JSON-compatible plain tree。config mutation 是低频操作，直接 structural compare 各 declaration
slice 足够清晰；不引入 signal graph、hash identity 或 canonical stringify contract。

## 并发

config patch/reset、fork/catalog mutation 和 explicit restart 继续复用现有 coordinator exclusive queue。listener 在同一 config mutation
中被 await，因此：

- 同一 node 不会并发执行两个 config update；
- 不需要新的 apply lane、scheduler、coalescing protocol 或 background task；
- listener resolve 时，对应的 desired snapshot 仍是本次 transaction 的确定输入；
- restart 与 update 不会同时修改同一 generation。

这会让一个慢 listener 延长当前 control-plane transaction，但它替代的是更昂贵的 restart，而且配置更新本来就是低频操作。只有实际
测量证明它阻塞无关 node 成为问题时，才在不改变作者 API 和 revision 语义的前提下调整内部调度；本提案不预先增加第二套队列。

listener 不得同步等待另一个需要进入同一 coordinator 的 config mutation、restart 或 graph operation。已知重入入口应 fail-fast，
避免自锁。

## Plugin 的责任

listener resolve 表示该 declaration 对应的 desired slice 已完整投影到 runtime。框架不理解、也不回滚 Plugin 的任意字段和外部资源。

普通参数应构造后一次替换：

```ts
this.configs.onUpdate(this.config, ({ desired }) => {
	this.options = {
		timeout: desired.timeout,
		concurrency: desired.concurrency,
	}
})
```

异步资源应先 prepare，再 publish：

```ts
this.configs.onUpdate(this.config, async ({ applied, desired, signal }) => {
	const client =
		applied.endpoint === desired.endpoint
			? this.state.client
			: await Client.connect(desired.endpoint, { signal })

	if (signal.aborted) {
		if (client !== this.state.client) await client.dispose()
		return
	}

	const old = this.state
	this.state = {
		client,
		timeout: desired.timeout,
	}

	if (old.client !== client) await old.client.dispose()
})
```

listener 应可重复从最后 applied state 收敛到 desired state。若多个 declaration listener 中后一个失败，框架无法撤销前一个已经产生的
任意副作用；相关 Plugin/Part 必须让 callback 幂等并尽量在 publish 前完成可能失败的工作。框架会保持 applied revision 不变，下一次
config update 可以从最后 confirmed applied snapshot 重试整次变化。

如果某类 config 只能通过完整重建应用，Plugin 就不注册 listener。保存后状态自然显示为 `saved-not-applied`，由用户在合适时机显式
restart。

## 结果与诊断

management result 继续区分保存和应用：

- `application: applied`：没有 normalized 变化，或所有相关 listener 成功；
- `application: deferred`：node 未运行；
- `application: saved-not-applied` + `listener-not-registered`：至少一个变化 declaration 没有 listener；
- `application: saved-not-applied` + `listener-failed`：listener reject；
- `application: saved-not-applied` + `generation-changed`：执行期间 generation 被撤销。

reason 使用稳定 code，不依赖 error message。listener error 的安全摘要进入 apply report，完整 cause 进入 owner logger；config mutation
本身不拥有 restart、stop 或 rollback policy。

显式 restart 成功后，新 generation 使用最新 desired composite，并把该 revision 标记为 applied。restart 失败继续走现有 lifecycle
report。

## 为什么不使用 signal 或自动字段覆盖

Plugin 作者已经明确知道哪些 runtime state 受 config 影响。显式 listener 把低频 desired update 投影为普通 number/object/client，热路径
没有函数调用、dependency tracking 或 Proxy 成本。

signal 不能替代异步 resource prepare、错误处理和 cleanup ownership；自动覆盖 `this.config` 也不能同步缓存、连接池、watcher 或第三方
registration。alien-signals 等响应式库仍可由个别 Plugin 内部使用，不成为 Pluxel config contract 或 production dependency。

## 实现边界

- config declaration 和 toolchain lowering 保持不变；
- Core generation config binding 保存 applied composite、各 declaration field binding 和 listener registration；
- Plugin/Part 的 `configs` protected facade 提供 owner-bound `onUpdate()`，不暴露 ConfigService；
- Runtime ConfigService 继续只拥有 desired raw record、validated snapshot、revision 和 persistence；
- runtime coordinator 在 persistence confirmed 后调用 Core internal apply，不再为 config mutation 创建 `restartNodes`；
- listener registration 进入现有 effects 与 generation invocation drain，不建立第二条 teardown；
- management projection 增加稳定的未应用 reason；
- explicit restart 保持独立入口并消费最新 desired config。

Runtime ConfigService 不 import Plugin implementation、不持有 Core slot，也不直接调用 raw instance。Core internal apply 使用现有 interned
node/generation identity 和 composite config metadata。

## 验证矩阵

至少覆盖：

1. 无 listener 的 running Plugin 保存后不 stop/start、不修改字段，desired/applied revision 分离；
2. root listener 成功后普通 runtime field、config field 和 applied revision 一起推进；
3. PluginPart listener 使用自己的 config 类型与 child effects，并随 owner generation 撤销；
4. root 与多个 Part 同时变化时，缺少任一 listener 会让所有 listener 都不执行；
5. 多个相关 listener 全部成功后才推进整个 owner revision；
6. listener reject 后不自动 restart，config fields/applied revision 保持旧值并报告稳定 reason；
7. revision 2 失败、revision 3 成功时，回调基线是最后 applied snapshot；
8. normalized output 没有变化时不调用 listener即可推进 revision；
9. stop/replacement 会 abort pending listener，迟到结果不能写入新 generation；
10. config mutation、explicit restart 和 catalog update 由 coordinator 串行，不发生 generation 串线；
11. listener 内已知 coordinator 重入 fail-fast，不死锁；
12. fork 的 listener、snapshots 和 revision 互相隔离；
13. 真实 Vite lowering fixture 证明 `configs.use(schema)` 的生成 facts 和作者调用完全不变。

## 验收条件

- config patch/reset 不再隐式 restart；
- 没有 listener 时 generation、effects、dependency facade、config field 和普通 runtime state 全部不变；
- Plugin 与 PluginPart 使用同一个 `onUpdate(this.config, listener)` 模型，无版本或降级 API；
- listener 不进入 build metadata，不修改 `configs.use()` contract；
- 所有变化 declaration listener 成功后才推进 owner applied revision；
- listener cleanup 与 generation effects 共享唯一 teardown；
- 热路径可以保持普通 property read；
- management API 不把“已保存”误报为“已应用”。

## 否决条件

- config mutation 在任何 listener 缺席或失败分支自动 restart；
- `configs.use()` 增加 `live`、`updates` 或 callback option；
- root 与 Part 使用不同 listener API 或建立 Part config revision；
- 缺少部分 listener 时仍调用其余 listener 并产生可避免的 partial apply；
- listener registration 进入 toolchain metadata；
- 框架声称能够回滚 Plugin 任意 runtime mutation；
- 为此暴露 raw ConfigService、Core slot、generation object 或 Context installation；
- signal/deep Proxy 成为所有 Plugin 的基础读取成本。

## 未决问题

1. listener error 应只进入 config apply report 和 owner logger，还是还需要不改变 running 状态的 lifecycle diagnostic phase？
2. 如果实测出现长期不 resolve 的 listener，应该复用哪一个现有 host operation timeout，而不是增加 Plugin decorator option？
