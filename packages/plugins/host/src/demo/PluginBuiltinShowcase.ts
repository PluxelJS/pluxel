// 展示型插件：尽量不注册自定义组件，仅使用宿主渲染扩展与配置 schema。

import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { SignalDbDocumentHandle } from '@pluxel/runtime/services'
import { doc } from '@pluxel/runtime/services'
import {
	BehaviorConfig,
	type BuiltinAction,
	type BuiltinActionWrite,
	type BuiltinState,
	type BuiltinTabMeta,
	DEFAULTS,
	DisplayConfig,
	FormatConfig,
	RUNTIME_ACTIONS_COLLECTION,
	RUNTIME_DOC_ID,
	RuntimeFormSchema,
	RuntimeToggleSchema,
	formatDuration,
} from './PluginBuiltinShowcase.shared'

type BuiltinDocBuilder = ReturnType<typeof doc>
type BuiltinDocContent = ReturnType<BuiltinDocBuilder>
type TabDocDefinition = {
	id: string
	tab: BuiltinTabMeta
	priority: number
	content: BuiltinDocContent
}

const BUILTIN_TABS = {
	controls: { id: 'controls', label: 'Controls', icon: 'form' },
	metrics: { id: 'metrics', label: 'Metrics', icon: 'activity' },
	guide: { id: 'guide', label: 'Guide', icon: 'book' },
} satisfies Record<string, BuiltinTabMeta>

const GUIDE_INTRO = `
# Builtin Doc
基于 markdown 的内容区域，可以注入内置组件。
`

const GUIDE_NOTES = `
- 纯文段和 builtin 表单可以混合排布
- 适合在说明文档中加入可交互控件

## 说明
本段用于拉长文本，测试目录与滚动条联动效果。

### 为什么选择 doc
doc 让插件作者可以先写一段解释，再插入交互组件。
同一页面里既能阅读，也能操作。

### 使用建议
- 段落要有结构
- 章节层级不要太深
- 关键点放在标题后几行

### 视觉测试
这里连续堆叠几段文本来制造滚动高度。
在真实插件里可以用配置说明、故障排查步骤、变更记录等填充。

#### 变更记录
1. 新增内置 doc 渲染
2. 支持 block 注入
3. 支持 TOC

#### 常见问题
Q: 为什么要统一入口？
A: 避免多套 UI 能力碎片化，降低维护成本。

Q: 是否支持更复杂组件？
A: 可以在 block 扩展里逐步加入。
`

@Plugin({ name: 'PluginBuiltinShowcase' })
export class PluginBuiltinShowcase extends BasePlugin {
	private startedAt = Date.now()
	private tickTimer: ReturnType<typeof setTimeout> | null = null
	private ticks = 0
	private paused = false
	private builtinState = this.ctx.ext.signaldb.collection<BuiltinState>({ name: RUNTIME_DOC_ID })
	private builtinActions = this.ctx.ext.signaldb.collection<BuiltinAction>({
		name: RUNTIME_ACTIONS_COLLECTION,
		clientWrites: true,
		persistence: false,
	})
	private builtin!: SignalDbDocumentHandle<BuiltinState>
	private readonly processingActions = new Set<string>()

	private display = this.configs.use(DisplayConfig)
	private behavior = this.configs.use(BehaviorConfig)
	private format = this.configs.use(FormatConfig)
	private _runtime = this.configs.use(RuntimeFormSchema)
	private _runtimeToggle = this.configs.use(RuntimeToggleSchema)

	override async init() {
		void this._runtime
		void this._runtimeToggle

		this.startedAt = Date.now()

		await this.builtinState.ready()
		await this.builtinActions.ready()
		this.builtin = this.builtinState.doc({ id: RUNTIME_DOC_ID })
		this.syncBuiltinState()
		this.consumePendingActions()
		const stopWatch = this.builtinActions.watch((event) => {
			if (event.type === 'insert' || event.type === 'update' || event.type === 'snapshot') {
				this.consumePendingActions()
			}
		})
		this.ctx.effects.defer(() => stopWatch())

		this.registerBuiltins()
		this.startTickLoop()
	}

	private buildState(): BuiltinState {
		const { refreshMs } = this.display
		const { tickStep, maxTicks } = this.behavior
		const {
			uptimeStyle,
			showMs,
			timeUnit,
			separator,
			padZeros,
			minDigits,
			labelStyle,
			prefix,
			suffix,
			uppercaseUnits,
			template,
			unitAliases,
		} = this.format
		const uptimeMs = Date.now() - this.startedAt

		return {
			id: RUNTIME_DOC_ID,
			uptimeMs,
			uptimeLabel: formatDuration(uptimeMs, {
				uptimeStyle,
				showMs,
				timeUnit,
				separator,
				padZeros,
				minDigits,
				labelStyle,
				prefix,
				suffix,
				uppercaseUnits,
				template,
				unitAliases,
			}),
			ticks: this.ticks,
			paused: this.paused,
			refreshMs,
			tickStep,
			maxTicks,
		}
	}

	private runtimeStateFallback(): BuiltinState {
		return {
			id: RUNTIME_DOC_ID,
			uptimeMs: 0,
			uptimeLabel: '0s',
			ticks: 0,
			paused: false,
			refreshMs: DEFAULTS.display.refreshMs,
			tickStep: DEFAULTS.behavior.tickStep,
			maxTicks: DEFAULTS.behavior.maxTicks,
		}
	}

	private queueActionWrite(action: BuiltinActionWrite) {
		return this.builtinActions.insertSpec({
			id: { kind: 'generatedId' as const },
			...action,
			status: 'pending' as const,
			createdAt: { kind: 'now' as const },
		})
	}

	private runtimeField<Key extends keyof BuiltinState>(key: Key, fallback: BuiltinState[Key]) {
		return this.builtin.field(key, fallback)
	}

	private summaryRows() {
		return [
			{ label: 'Uptime', value: this.runtimeField('uptimeLabel', '0s') },
			{ label: 'Ticks', value: this.runtimeField('ticks', 0) },
			{ label: 'Paused', value: this.runtimeField('paused', false) },
			{ label: 'Tick step', value: this.runtimeField('tickStep', DEFAULTS.behavior.tickStep) },
			{ label: 'Refresh (ms)', value: this.runtimeField('refreshMs', DEFAULTS.display.refreshMs) },
		]
	}

	private pauseForm(description: string) {
		return this.builtin.form({
			description,
			submitMode: 'onChange',
			autoSubmitDebounceMs: 120,
			schemaKey: '_runtimeToggle',
			write: this.queueActionWrite({
				kind: 'setPaused',
				paused: { kind: 'field', key: 'paused' },
			}),
		})
	}

	private setTicksForm() {
		return this.builtin.form({
			description: 'Manual submit → signaldb action doc.',
			submitLabel: 'Submit',
			submitMode: 'manual',
			schemaKey: '_runtime',
			feedback: { success: { title: 'Submitted', tone: 'success' } },
			resetOnSuccess: false,
			write: this.queueActionWrite({
				kind: 'setTicks',
				ticks: { kind: 'field', key: 'ticks' },
			}),
		})
	}

	private resetTicksAction() {
		return this.builtin.action({
			label: 'Reset to 0',
			description: '单按钮 action：无需 RPC，只写入 action collection。',
			write: this.queueActionWrite({ kind: 'setTicks', ticks: 0 }),
			feedback: { success: { title: 'Queued', tone: 'success' } },
		})
	}

	private registerBuiltins() {
		this.registerOverviewDoc()
		this.registerTabDocs()
	}

	private registerOverviewDoc() {
		const d = doc({} as const)

		this.ctx.ext.ui.builtin.doc({
			id: 'summary',
			point: 'plugin:context',
			title: 'Builtin Overview',
			description: 'Host-rendered preset UI (no plugin UI module).',
			requireRunning: false,
			content: d`
				${d.block(
					'Overview',
					d.card({
						layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
						rows: [
							{ label: 'Plugin', value: this.ctx.pluginInfo.id },
							...this.summaryRows(),
							{
								label: 'Max ticks',
								value: this.builtin.field('maxTicks', DEFAULTS.behavior.maxTicks),
							},
						],
					}),
				)}
			`,
		})
	}

	private registerTabDocs() {
		const d = doc({} as const)
		const docs: TabDocDefinition[] = [
			{
				id: 'controls-doc',
				tab: BUILTIN_TABS.controls,
				priority: 20,
				content: this.buildControlsDoc(d),
			},
			{
				id: 'metrics-doc',
				tab: BUILTIN_TABS.metrics,
				priority: 10,
				content: this.buildMetricsDoc(d),
			},
			{
				id: 'guide-doc',
				tab: BUILTIN_TABS.guide,
				priority: 0,
				content: this.buildGuideDoc(d),
			},
		]

		for (const definition of docs) this.registerTabDoc(definition)
	}

	private buildControlsDoc(d: BuiltinDocBuilder): BuiltinDocContent {
		return d`
			${d.block('Pause', this.pauseForm('submitMode=onChange + signaldb action doc.'))}
			${d.block('Set ticks', this.setTicksForm())}
			${d.block('Reset ticks', this.resetTicksAction())}
		`
	}

	private buildMetricsDoc(d: BuiltinDocBuilder): BuiltinDocContent {
		return d`
			${d.block(
				'Metrics Stream',
				d.card({
					description: 'Compact status list (auto-updated).',
					layout: { variant: 'list', density: 'compact', valueAlign: 'right' },
					rows: this.buildMetricRows(),
				}),
			)}
		`
	}

	private buildGuideDoc(d: BuiltinDocBuilder): BuiltinDocContent {
		return d`
			${GUIDE_INTRO}
			${d.block(
				'Snapshot',
				d.card({
					description: 'Markdown + builtin blocks.',
					layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
					rows: this.summaryRows(),
				}),
			)}
			${d.block('Quick controls', this.pauseForm('onChange + signaldb action doc.'))}
			${GUIDE_NOTES}
		`
	}

	private registerTabDoc(input: TabDocDefinition) {
		this.ctx.ext.ui.builtin.doc({
			id: input.id,
			point: 'plugin:tabs',
			requireRunning: false,
			priority: input.priority,
			meta: {
				label: input.tab.label,
				icon: input.tab.icon,
				tab: input.tab,
			},
			content: input.content,
		})
	}

	private buildMetricRows() {
		const rows = [
			{
				label: 'Stream',
				value: { kind: 'badge', label: 'Live', color: 'green', variant: 'light' } as const,
			},
			{ label: 'Uptime', value: this.runtimeField('uptimeLabel', '0s') },
			{ label: 'Uptime (ms)', value: this.runtimeField('uptimeMs', 0) },
			{ label: 'Ticks', value: this.runtimeField('ticks', 0) },
			{ label: 'Tick step', value: this.runtimeField('tickStep', DEFAULTS.behavior.tickStep) },
			{ label: 'Paused', value: this.runtimeField('paused', false) },
			{ label: 'Max ticks', value: this.runtimeField('maxTicks', DEFAULTS.behavior.maxTicks) },
			{ label: 'Refresh (ms)', value: this.runtimeField('refreshMs', DEFAULTS.display.refreshMs) },
			{
				label: 'Snapshot',
				value: this.builtin.snapshot(this.runtimeStateFallback()),
			},
		]

		return rows
	}

	private startTickLoop() {
		const tick = () => {
			const { refreshMs } = this.display
			const { tickStep, maxTicks, autoPauseAtMax } = this.behavior
			if (!this.paused) {
				this.ticks += tickStep
				if (maxTicks > 0 && this.ticks >= maxTicks) {
					this.ticks = maxTicks
					if (autoPauseAtMax) this.paused = true
				}
			}
			this.syncBuiltinState()
			this.tickTimer = setTimeout(tick, refreshMs)
		}
		tick()
		this.ctx.effects.defer(() => {
			if (this.tickTimer) clearTimeout(this.tickTimer)
			this.tickTimer = null
		})
	}

	private syncBuiltinState() {
		this.builtinState.replaceOne({ id: RUNTIME_DOC_ID }, this.buildState(), { upsert: true })
	}
	private consumePendingActions() {
		for (const action of this.builtinActions.find({ status: 'pending' })) {
			if (this.processingActions.has(action.id)) continue
			this.processingActions.add(action.id)
			Promise.resolve()
				.then(() => this.applyBuiltinAction(action))
				.finally(() => {
					this.processingActions.delete(action.id)
				})
		}
	}

	private applyBuiltinAction(action: BuiltinAction) {
		try {
			if (action.kind === 'setPaused') {
				this.paused = Boolean(action.paused)
			} else if (action.kind === 'setTicks') {
				const value = Number(action.ticks)
				if (!Number.isFinite(value) || value < 0) {
					throw new Error('ticks must be a non-negative number')
				}
				this.ticks = Math.floor(value)
			}
			this.syncBuiltinState()
			this.builtinActions.replaceOne(
				{ id: action.id },
				{ ...action, status: 'done', error: undefined },
				{ upsert: true },
			)
		} catch (error) {
			this.builtinActions.replaceOne(
				{ id: action.id },
				{
					...action,
					status: 'error',
					error: error instanceof Error ? error.message : String(error),
				},
				{ upsert: true },
			)
		}
	}
}
