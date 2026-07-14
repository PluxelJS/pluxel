// Read this when you want host-rendered, read-only Workbench documents without a UI bundle.

import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	workbench,
	workbenchDoc,
	type MountedWorkbenchManagedCollections,
	type WorkbenchSyncRef,
} from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import {
	type BuiltinState,
	DEFAULTS,
	DisplayConfig,
	BehaviorConfig,
	FormatConfig,
	RUNTIME_DOC_ID,
	formatDuration,
} from './PluginBuiltinShowcase.shared'

const PLUGIN = 'PluginBuiltinShowcase'

function stateRef<Key extends keyof BuiltinState>(
	key: Key,
	fallback: BuiltinState[Key],
): WorkbenchSyncRef<BuiltinState[Key]> {
	return {
		kind: 'signaldb',
		collection: RUNTIME_DOC_ID,
		selector: { id: RUNTIME_DOC_ID },
		path: String(key),
		fallback,
	}
}

const d = workbenchDoc({} as const)
const summaryRows = [
	{ label: 'Uptime', value: stateRef('uptimeLabel', '0s') },
	{ label: 'Ticks', value: stateRef('ticks', 0) },
	{ label: 'Paused', value: stateRef('paused', false) },
	{ label: 'Tick step', value: stateRef('tickStep', DEFAULTS.behavior.tickStep) },
	{ label: 'Refresh (ms)', value: stateRef('refreshMs', DEFAULTS.display.refreshMs) },
]

const BuiltinShowcaseUi = workbenchContract.define({
	resources: {
		[RUNTIME_DOC_ID]: workbenchContract.collection<BuiltinState>(),
	},
	views: {
		summary: workbenchContract.document({
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginContext, { when: 'always' }),
			],
			title: 'Builtin Overview',
			description: 'Host-rendered, resource-bound Workbench document.',
			content: d`
				${d.block(
					'Overview',
					d.card({
						layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
						rows: [{ label: 'Plugin', value: PLUGIN }, ...summaryRows],
					}),
				)}

				Builtin documents suit read-only status summaries. Interactive flows use a React View and typed RPC.
			`,
		}),
		metrics: workbenchContract.document({
			placements: [workbenchContract.slot(workbenchContract.slots.PluginTabs, { order: 10 })],
			content: d`${d.block(
				'Metrics Stream',
				d.card({
					description: 'SignalDB-backed values update live.',
					layout: { variant: 'list', density: 'compact', valueAlign: 'right' },
					rows: [...summaryRows, { label: 'Uptime (ms)', value: stateRef('uptimeMs', 0) }],
				}),
			)}`,
		}),
	},
})

const BuiltinShowcaseWorkbench = workbench.extension({ contract: BuiltinShowcaseUi })
type ShowcaseResources = MountedWorkbenchManagedCollections<typeof BuiltinShowcaseWorkbench>

@Plugin({ name: PLUGIN })
export class PluginBuiltinShowcase extends BasePlugin {
	private startedAt = Date.now()
	private tickTimer: ReturnType<typeof setTimeout> | null = null
	private ticks = 0
	private paused = false
	private builtinState!: NonNullable<ShowcaseResources[typeof RUNTIME_DOC_ID]>

	private display = this.configs.use(DisplayConfig)
	private behavior = this.configs.use(BehaviorConfig)
	private format = this.configs.use(FormatConfig)

	override async init() {
		const mounted = this.ctx.workbench.mount(BuiltinShowcaseWorkbench, {
			[RUNTIME_DOC_ID]: workbench.bind.managedCollection(),
		})
		if (!mounted?.managedCollections[RUNTIME_DOC_ID]) return
		this.builtinState = mounted.managedCollections[RUNTIME_DOC_ID]
		this.startedAt = Date.now()
		await this.builtinState.ready()
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
			this.builtinState.replaceOne({ id: RUNTIME_DOC_ID }, this.buildState(), { upsert: true })
			this.tickTimer = setTimeout(tick, this.display.refreshMs)
		}
		tick()
		this.ctx.effects.defer(() => {
			if (this.tickTimer) clearTimeout(this.tickTimer)
			this.tickTimer = null
		})
	}
}
