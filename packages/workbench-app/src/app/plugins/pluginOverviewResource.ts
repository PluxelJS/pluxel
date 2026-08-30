import type {
	PluginCatalogSection,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
	RuntimeManagementClient,
} from '@pluxel/runtime/web'

const PLUGIN_OVERVIEW_TTL = 30_000

export type PluginStatusEntry = Readonly<
	Omit<PluginStatusSnapshot, 'label'> & {
		/** Canonical catalog identity used by routes and local view state. */
		id: string
		label: string
	}
>

export type PluginOverview = Readonly<{
	status: Readonly<{
		statuses: readonly PluginStatusEntry[]
		summary: PluginCatalogSnapshot['summary']
	}>
	sections: readonly PluginCatalogSection[]
}>

export type PluginOverviewResourceSnapshot = Readonly<{
	overview: PluginOverview | null
	isLoading: boolean
	isStale: boolean
	error?: string
}>

const EMPTY_RESOURCE_SNAPSHOT: PluginOverviewResourceSnapshot = Object.freeze({
	overview: null,
	isLoading: false,
	isStale: false,
})

function projectStatus(entry: PluginStatusSnapshot): PluginStatusEntry {
	return Object.freeze({ ...entry, id: entry.route, label: entry.label.text })
}

export function buildPluginOverview(catalog: PluginCatalogSnapshot): PluginOverview {
	return Object.freeze({
		status: Object.freeze({
			statuses: Object.freeze(catalog.plugins.map(projectStatus)),
			summary: catalog.summary,
		}),
		sections: Object.freeze([...catalog.sections]),
	})
}

export class PluginOverviewResource {
	private snapshot: PluginOverviewResourceSnapshot = EMPTY_RESOURCE_SNAPSHOT
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private inflightVersion = -1
	private invalidationVersion = 0
	private loadedVersion = -1
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
		if (this.inflight !== null) {
			if (!force || this.inflightVersion >= this.invalidationVersion) return this.inflight
			const requiredVersion = this.invalidationVersion
			return this.inflight.then(() => {
				if (
					!this.snapshot.isStale &&
					this.invalidationVersion === requiredVersion &&
					this.loadedVersion >= requiredVersion
				) {
					return undefined
				}
				return this.load(true)
			})
		}
		if (!force && this.snapshot.overview && this.now() - this.loadedAt < PLUGIN_OVERVIEW_TTL) {
			return Promise.resolve()
		}

		this.publish(
			Object.freeze({
				overview: this.snapshot.overview,
				isLoading: true,
				isStale: this.snapshot.isStale,
			}),
		)
		const readVersion = this.invalidationVersion
		this.inflightVersion = readVersion
		const task = this.client.catalog
			.snapshot()
			.then((catalog): void => {
				this.loadedAt = this.now()
				this.loadedVersion = readVersion
				this.publish(
					Object.freeze({
						overview: buildPluginOverview(catalog),
						isLoading: false,
						isStale: readVersion !== this.invalidationVersion,
					}),
				)
				return undefined
			})
			.catch((error: unknown): void => {
				this.publish(
					Object.freeze({
						overview: this.snapshot.overview,
						isLoading: false,
						isStale: this.snapshot.overview !== null,
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

	markStale(): void {
		this.invalidationVersion += 1
		this.loadedAt = 0
		this.publish(
			Object.freeze({
				overview: this.snapshot.overview,
				isLoading: this.snapshot.isLoading,
				isStale: true,
				...(this.snapshot.error === undefined ? {} : { error: this.snapshot.error }),
			}),
		)
		if (this.listeners.size > 0) void this.load(true)
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
