import { getLoadedModules, loadPluginUI, syncWithManifest, unloadPluginUI } from '../runtime'
import type { ExtensionManifest } from '../types'
import type {
	ExtensionManagerOptions,
	ExtensionManagerState,
	PluginInfo,
} from './types'

type Listener = () => void

const INITIAL_STATE: ExtensionManagerState = {
	isLoading: true,
	error: null,
	manifestVersion: 0,
	loadedCount: 0,
}

function createRunningKey(plugins: PluginInfo[]): string {
	return plugins
		.filter((plugin) => plugin.isRunning)
		.map((plugin) => plugin.name)
		.sort()
		.join(',')
}

export class ExtensionLifecycleManager {
	private readonly fetchManifestFn: ExtensionManagerOptions['fetchManifest']
	private state: ExtensionManagerState = INITIAL_STATE
	private listeners = new Set<Listener>()
	private plugins: PluginInfo[] = []
	private runningKey = ''
	private manifest: ExtensionManifest | null = null
	private lastVersion = 0
	private syncing = false
	private rerunRequested = false
	private rerunForce = false
	private pendingSyncTimer: ReturnType<typeof setTimeout> | null = null
	private pollTimer: ReturnType<typeof setInterval> | null = null
	private pollInterval: number
	private destroyed = false
	private started = false

	constructor(options: ExtensionManagerOptions) {
		this.fetchManifestFn = options.fetchManifest
		this.pollInterval = options.pollInterval ?? 0
	}

	start(): void {
		if (this.started) return
		this.started = true
		this.destroyed = false
		this.markLoading()
		this.restartPolling()
		void this.sync(true)
	}

	dispose(): void {
		this.started = false
		this.destroyed = true
		this.clearPendingSync()
		this.stopPolling()
		this.listeners.clear()
	}

	setPollInterval(interval: number | undefined): void {
		const next = typeof interval === 'number' && interval > 0 ? interval : 0
		this.pollInterval = next
		if (this.started) {
			this.restartPolling()
		}
	}

	setPlugins(plugins: PluginInfo[]): void {
		this.plugins = plugins
		const nextKey = createRunningKey(plugins)
		if (this.runningKey === nextKey) return
		this.runningKey = nextKey
		if (this.manifest) {
			this.scheduleSync(false)
		}
	}

	refresh(): Promise<void> {
		this.manifest = null
		this.lastVersion = 0
		this.markLoading()
		return this.sync(true)
	}

	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): ExtensionManagerState => {
		return this.state
	}

	private markLoading(): void {
		this.updateState({ isLoading: true })
	}

	private updateState(partial: Partial<ExtensionManagerState>): void {
		if (this.destroyed) return
		this.state = { ...this.state, ...partial }
		this.listeners.forEach((listener) => {
			try {
				listener()
			} catch (error) {
				if (process.env.NODE_ENV !== 'production') {
					console.error('[ExtensionLifecycle] Failed to notify listener', error)
				}
			}
		})
	}

	private scheduleSync(forceReload: boolean): void {
		this.clearPendingSync()
		if (this.destroyed) return
		this.pendingSyncTimer = setTimeout(() => {
			this.pendingSyncTimer = null
			void this.sync(forceReload)
		}, 100)
	}

	private clearPendingSync(): void {
		if (this.pendingSyncTimer) {
			clearTimeout(this.pendingSyncTimer)
			this.pendingSyncTimer = null
		}
	}

	private restartPolling(): void {
		this.stopPolling()
		if (this.destroyed) return
		if (this.pollInterval > 0) {
			this.pollTimer = setInterval(() => {
				void this.handlePoll()
			}, this.pollInterval)
		}
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
	}

	private async handlePoll(): Promise<void> {
		if (this.destroyed) return
		const previousVersion = this.manifest?.version ?? 0
		const manifest = await this.fetchLatestManifest()
		if (!manifest) return
		if (manifest.version !== previousVersion) {
			await this.sync(false)
		}
	}

	private async sync(forceReload: boolean): Promise<void> {
		if (this.destroyed) return
		if (this.syncing) {
			this.rerunRequested = true
			this.rerunForce = this.rerunForce || forceReload
			return
		}

		this.syncing = true
		try {
			let manifest = await this.fetchManifest(forceReload)
			if (!manifest) {
				this.updateState({ isLoading: false })
				return
			}

			const runningSet = this.getRunningPlugins()
			const ensuredManifest = await this.ensureManifestCoverage(manifest, runningSet)
			if (!ensuredManifest) {
				this.updateState({ isLoading: false })
				return
			}
			manifest = ensuredManifest

			const versionChanged = manifest.version !== this.lastVersion
			if (!versionChanged && !forceReload) {
				const loadedBefore = getLoadedModules()
				for (const pluginName of loadedBefore.keys()) {
					if (!runningSet.has(pluginName)) {
						unloadPluginUI(pluginName)
					}
				}

				const loadedAfter = getLoadedModules()
				for (const bundle of manifest.bundles) {
					if (runningSet.has(bundle.pluginName) && !loadedAfter.has(bundle.pluginName)) {
						await loadPluginUI(bundle.pluginName, bundle.bundleUrl, bundle.sourceHash)
					}
				}
			} else {
				this.lastVersion = manifest.version
				await syncWithManifest(manifest.bundles, runningSet)
			}

			this.updateState({
				manifestVersion: manifest.version,
				loadedCount: getLoadedModules().size,
				error: null,
				isLoading: false,
			})
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error))
			this.updateState({ error: normalized, isLoading: false })
		} finally {
			this.syncing = false
			if (this.destroyed) return
			if (this.rerunRequested) {
				const shouldForce = this.rerunForce
				this.rerunRequested = false
				this.rerunForce = false
				void this.sync(shouldForce)
			}
		}
	}

	private async fetchManifest(forceReload: boolean): Promise<ExtensionManifest | null> {
		if (!forceReload && this.manifest) {
			return this.manifest
		}
		return this.fetchLatestManifest()
	}

	private async fetchLatestManifest(): Promise<ExtensionManifest | null> {
		try {
			const manifest = await this.fetchManifestFn()
			if (this.destroyed) {
				return null
			}
			this.manifest = manifest
			return manifest
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error))
			this.updateState({ error: normalized, isLoading: false })
			return null
		}
	}

	private getRunningPlugins(): Set<string> {
		const names = this.plugins
			.filter((plugin) => plugin.isRunning)
			.map((plugin) => plugin.name)
		return new Set(names)
	}

	private async ensureManifestCoverage(
		manifest: ExtensionManifest,
		running: ReadonlySet<string>,
	): Promise<ExtensionManifest | null> {
		if (running.size === 0) {
			return manifest
		}

		const manifestPlugins = new Set(manifest.bundles.map((bundle) => bundle.pluginName))
		for (const name of running) {
			if (!manifestPlugins.has(name)) {
				return this.fetchManifest(true)
			}
		}
		return manifest
	}
}
