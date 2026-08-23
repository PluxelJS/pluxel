import type { PluginNodeAddress } from '@pluxel/core'
import type {
	PluginGroup,
	PluginStatusSnapshot,
	PluginsListOutput,
	RuntimeManagementClient,
} from '@pluxel/runtime/web'

const PLUGIN_OVERVIEW_TTL = 30_000

export type PluginStatusEntryLifecycleStage = PluginStatusSnapshot['lifecycleStage']

export const PluginStatusEntryLifecycleStage = Object.freeze({
	running: 'running',
	stopped: 'stopped',
	disabled: 'disabled',
} as const satisfies Record<PluginStatusEntryLifecycleStage, PluginStatusEntryLifecycleStage>)

export type PluginStatusEntry = Readonly<
	Omit<PluginStatusSnapshot, 'label'> & {
		/** Canonical catalog identity used by routes and local view state. */
		id: string
		label: string
	}
>

export type PluginDependency = Readonly<{
	id: string
	reference: string
	route: string
	displayName: string
	label: string
	rootExportName: string
	address: PluginNodeAddress
	isRunning?: boolean
}>

export type PluginOverview = Readonly<{
	status: Readonly<{
		statuses: readonly PluginStatusEntry[]
		summary: PluginsListOutput['summary']
	}>
	groups: readonly PluginGroup[]
}>

export type PluginOverviewResourceSnapshot = Readonly<{
	overview: PluginOverview | null
	isLoading: boolean
	error?: string
}>

const EMPTY_RESOURCE_SNAPSHOT: PluginOverviewResourceSnapshot = Object.freeze({
	overview: null,
	isLoading: false,
})

function projectStatus(entry: PluginStatusSnapshot): PluginStatusEntry {
	return Object.freeze({ ...entry, id: entry.route, label: entry.label.text })
}

export function buildPluginOverview(
	plugins: PluginsListOutput,
	groups: readonly PluginGroup[],
): PluginOverview {
	return Object.freeze({
		status: Object.freeze({
			statuses: Object.freeze(plugins.plugins.map(projectStatus)),
			summary: plugins.summary,
		}),
		groups: Object.freeze([...groups]),
	})
}

export class PluginOverviewResource {
	private snapshot: PluginOverviewResourceSnapshot = EMPTY_RESOURCE_SNAPSHOT
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private loadedAt = 0

	constructor(
		private readonly client: RuntimeManagementClient,
		private readonly now: () => number = Date.now,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): PluginOverviewResourceSnapshot => this.snapshot

	load(force = false): Promise<void> {
		if (this.inflight !== null) return this.inflight
		if (!force && this.snapshot.overview && this.now() - this.loadedAt < PLUGIN_OVERVIEW_TTL) {
			return Promise.resolve()
		}

		this.publish(Object.freeze({ overview: this.snapshot.overview, isLoading: true }))
		const task = Promise.all([this.client.plugins.list(), this.client.groups.list()])
			.then(([plugins, groups]): void => {
				this.loadedAt = this.now()
				this.publish(
					Object.freeze({ overview: buildPluginOverview(plugins, groups), isLoading: false }),
				)
				return undefined
			})
			.catch((error: unknown): void => {
				this.publish(
					Object.freeze({
						overview: this.snapshot.overview,
						isLoading: false,
						error: errorMessage(error, '无法读取插件概览'),
					}),
				)
			})
			.finally(() => {
				if (this.inflight === task) this.inflight = null
			})
		this.inflight = task
		return task
	}

	private publish(snapshot: PluginOverviewResourceSnapshot): void {
		this.snapshot = snapshot
		for (const listener of this.listeners) listener()
	}
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
