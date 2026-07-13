// Read this when you want host-rendered management documents without a UI bundle.

import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	defineManagementModule,
	ManagementPlacements,
	managementBinding,
	managementDoc,
	managementDocument,
	managementResource,
	managementView,
	type ManagementSyncRef,
	type MountedManagementResources,
} from '@pluxel/runtime/management'
import {
	BehaviorConfig,
	type BuiltinAction,
	type BuiltinState,
	DEFAULTS,
	DisplayConfig,
	FormatConfig,
	RUNTIME_ACTIONS_COLLECTION,
	RUNTIME_DOC_ID,
	RuntimeFormSchema,
	RuntimeToggleSchema,
	formatDuration,
} from './PluginBuiltinShowcase.shared'

const PLUGIN = 'PluginBuiltinShowcase'

function stateRef<Key extends keyof BuiltinState>(
	key: Key,
	fallback: BuiltinState[Key],
): ManagementSyncRef<BuiltinState[Key]> {
	return {
		kind: 'signaldb',
		collection: RUNTIME_DOC_ID,
		selector: { id: RUNTIME_DOC_ID },
		path: String(key),
		fallback,
	}
}

const actionInsert = (value: Record<string, unknown>) => ({
	collection: RUNTIME_ACTIONS_COLLECTION,
	mode: 'insert' as const,
	value: {
		id: { kind: 'generatedId' as const },
		...value,
		status: 'pending',
		createdAt: { kind: 'now' as const },
	},
})

const d = managementDoc({} as const)
const summaryRows = [
	{ label: 'Uptime', value: stateRef('uptimeLabel', '0s') },
	{ label: 'Ticks', value: stateRef('ticks', 0) },
	{ label: 'Paused', value: stateRef('paused', false) },
	{ label: 'Tick step', value: stateRef('tickStep', DEFAULTS.behavior.tickStep) },
	{ label: 'Refresh (ms)', value: stateRef('refreshMs', DEFAULTS.display.refreshMs) },
]

const BuiltinShowcaseManagement = defineManagementModule({
	id: PLUGIN,
	resources: {
		[RUNTIME_DOC_ID]: managementResource.collection<BuiltinState>(),
		[RUNTIME_ACTIONS_COLLECTION]: managementResource.collection<BuiltinAction>(),
	},
	contributions: [
		managementView({
			id: 'summary',
			placement: ManagementPlacements.PluginContext,
			requireRunning: false,
			view: managementDocument({
				title: 'Builtin Overview',
				description: 'Host-rendered, resource-bound management document.',
				content: d`
					${d.block(
						'Overview',
						d.card({
							layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
							rows: [{ label: 'Plugin', value: PLUGIN }, ...summaryRows],
						}),
					)}

					Builtin documents suit status summaries, small forms and immediate actions. Complex flows should use a remote view.
				`,
			}),
		}),
		managementView({
			id: 'controls',
			placement: ManagementPlacements.PluginTabs,
			priority: 20,
			meta: {
				label: 'Controls',
				icon: 'form',
				tab: { id: 'controls', label: 'Controls', icon: 'form' },
			},
			view: managementDocument({
				content: d`
					${d.block('Pause', {
						kind: 'form',
						description: 'onChange form writes an action document.',
						submitMode: 'onChange',
						autoSubmitDebounceMs: 120,
						schemaKey: '_runtimeToggle',
						write: actionInsert({ kind: 'setPaused', paused: { kind: 'field', key: 'paused' } }),
					})}
					${d.block('Set ticks', {
						kind: 'form',
						description: 'Manual submit writes an action document.',
						submitLabel: 'Submit',
						submitMode: 'manual',
						schemaKey: '_runtime',
						write: actionInsert({ kind: 'setTicks', ticks: { kind: 'field', key: 'ticks' } }),
					})}
					${d.block('Reset ticks', {
						kind: 'action',
						label: 'Reset to 0',
						description: 'No RPC: write to the action collection.',
						write: actionInsert({ kind: 'setTicks', ticks: 0 }),
					})}
				`,
			}),
		}),
		managementView({
			id: 'metrics',
			placement: ManagementPlacements.PluginTabs,
			priority: 10,
			meta: {
				label: 'Metrics',
				icon: 'activity',
				tab: { id: 'metrics', label: 'Metrics', icon: 'activity' },
			},
			view: managementDocument({
				content: d`${d.block(
					'Metrics Stream',
					d.card({
						description: 'SignalDB-backed values update live.',
						layout: { variant: 'list', density: 'compact', valueAlign: 'right' },
						rows: [...summaryRows, { label: 'Uptime (ms)', value: stateRef('uptimeMs', 0) }],
					}),
				)}`,
			}),
		}),
	],
})

type ShowcaseResources = MountedManagementResources<typeof BuiltinShowcaseManagement>

@Plugin({ name: PLUGIN })
export class PluginBuiltinShowcase extends BasePlugin {
	private startedAt = Date.now()
	private tickTimer: ReturnType<typeof setTimeout> | null = null
	private ticks = 0
	private paused = false
	private builtinState!: ShowcaseResources[typeof RUNTIME_DOC_ID]
	private builtinActions!: ShowcaseResources[typeof RUNTIME_ACTIONS_COLLECTION]
	private readonly processingActions = new Set<string>()

	private display = this.configs.use(DisplayConfig)
	private behavior = this.configs.use(BehaviorConfig)
	private format = this.configs.use(FormatConfig)
	private _runtime = this.configs.use(RuntimeFormSchema)
	private _runtimeToggle = this.configs.use(RuntimeToggleSchema)

	override async init() {
		void this._runtime
		void this._runtimeToggle
		const mounted = this.ctx.management.mount(BuiltinShowcaseManagement, {
			[RUNTIME_DOC_ID]: managementBinding.collection(),
			[RUNTIME_ACTIONS_COLLECTION]: managementBinding.collection({ clientWrites: true }),
		})
		if (!mounted) return
		this.builtinState = mounted.resources[RUNTIME_DOC_ID]
		this.builtinActions = mounted.resources[RUNTIME_ACTIONS_COLLECTION]
		this.startedAt = Date.now()
		await Promise.all([this.builtinState.ready(), this.builtinActions.ready()])
		this.syncBuiltinState()
		this.consumePendingActions()
		const stopWatch = this.builtinActions.watch((event) => {
			if (event.type === 'insert' || event.type === 'update' || event.type === 'snapshot')
				this.consumePendingActions()
		})
		this.ctx.effects.defer(stopWatch)
		this.startTickLoop()
	}

	private buildState(): BuiltinState {
		const uptimeMs = Date.now() - this.startedAt
		return {
			id: RUNTIME_DOC_ID,
			uptimeMs,
			uptimeLabel: formatDuration(uptimeMs, { ...DEFAULTS.format, ...this.format }),
			ticks: this.ticks,
			paused: this.paused,
			refreshMs: this.display.refreshMs,
			tickStep: this.behavior.tickStep,
			maxTicks: this.behavior.maxTicks,
		}
	}

	private startTickLoop() {
		const tick = () => {
			if (!this.paused) {
				this.ticks += this.behavior.tickStep
				if (this.behavior.maxTicks > 0 && this.ticks >= this.behavior.maxTicks) {
					this.ticks = this.behavior.maxTicks
					if (this.behavior.autoPauseAtMax) this.paused = true
				}
			}
			this.syncBuiltinState()
			this.tickTimer = setTimeout(tick, this.display.refreshMs)
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
				.finally(() => this.processingActions.delete(action.id))
		}
	}

	private applyBuiltinAction(action: BuiltinAction) {
		try {
			if (action.kind === 'setPaused') this.paused = Boolean(action.paused)
			else if (action.kind === 'setTicks') {
				const value = Number(action.ticks)
				if (!Number.isFinite(value) || value < 0) throw new Error('ticks must be non-negative')
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
