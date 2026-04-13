// Read this when:
// - 你不打算写自定义 UI
// - 你只想看 builtin doc/form/action 的完整最小组合

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { doc, type SignalDbDocumentHandle } from '@pluxel/runtime/services'
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

// Builtin doc tabs stay close to the top so readers can see the output shape first.
const BUILTIN_TABS = {
	controls: { id: 'controls', label: 'Controls', icon: 'form' },
	metrics: { id: 'metrics', label: 'Metrics', icon: 'activity' },
} satisfies Record<string, BuiltinTabMeta>

const BUILTIN_NOTES = `
Builtin doc 适合放：

- 当前状态摘要
- 少量即时操作
- 简短说明文段

如果页面需要复杂交互、复杂布局或独立路由，就切到自定义 UI demo。
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

	// Runtime state and builtin write payloads.
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

	private statusRows() {
		return [
			...this.summaryRows(),
			{ label: 'Max ticks', value: this.runtimeField('maxTicks', DEFAULTS.behavior.maxTicks) },
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

	// Builtin doc registration.
	private registerOverviewDoc() {
		const d = doc({} as const)

		this.registerBuiltinDoc({
			id: 'summary',
			point: 'plugin:context',
			title: 'Builtin Overview',
			description: 'Host-rendered preset UI (no plugin UI module).',
			content: d`
				${d.block(
					'Overview',
					d.card({
						layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
						rows: [{ label: 'Plugin', value: this.ctx.pluginInfo.id }, ...this.statusRows()],
					}),
				)}
				${BUILTIN_NOTES}
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

	private registerTabDoc(input: TabDocDefinition) {
		this.registerBuiltinDoc({
			id: input.id,
			point: 'plugin:tabs',
			priority: input.priority,
			meta: {
				label: input.tab.label,
				icon: input.tab.icon,
				tab: input.tab,
			},
			content: input.content,
		})
	}

	private registerBuiltinDoc(
		input: Parameters<typeof this.ctx.ext.ui.builtin.doc>[0] & { requireRunning?: false },
	) {
		this.ctx.ext.ui.builtin.doc({
			requireRunning: false,
			...input,
		})
	}

	private buildMetricRows() {
		return [
			{
				label: 'Stream',
				value: { kind: 'badge', label: 'Live', color: 'green', variant: 'light' } as const,
			},
			...this.statusRows(),
			{ label: 'Uptime (ms)', value: this.runtimeField('uptimeMs', 0) },
			{
				label: 'Snapshot',
				value: this.builtin.snapshot(this.runtimeStateFallback()),
			},
		]
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
