import type { ComponentType } from 'react'
import type { WorkbenchUiModule } from '@pluxel/runtime/workbench/ui'
import type { LocaleService } from '@pluxel/runtime/web'

class WorkbenchUiRegistry {
	private readonly modules = new Map<string, WorkbenchUiModule>()
	private readonly hashes = new Map<string, string>()
	private readonly cleanups = new Map<string, () => void>()
	private readonly listeners = new Set<() => void>()

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async load(
		owner: string,
		importer: () => Promise<WorkbenchUiModule | { default?: WorkbenchUiModule }>,
		hash: string,
		locale: LocaleService,
	): Promise<void> {
		if (this.hashes.get(owner) === hash) return
		const imported = await importer()
		const module =
			imported && typeof imported === 'object' && 'default' in imported && imported.default
				? imported.default
				: (imported as WorkbenchUiModule)
		if (!module || typeof module !== 'object' || !module.views) {
			throw new Error(`[workbench-ui] invalid UI module for ${owner}`)
		}
		this.unload(owner)
		let cleanup: void | (() => void)
		if (module.setup) cleanup = await module.setup({ ownerPluginId: owner, locale })
		this.modules.set(owner, module)
		this.hashes.set(owner, hash)
		if (typeof cleanup === 'function') this.cleanups.set(owner, cleanup)
		this.notify()
	}

	unload(owner: string): void {
		try {
			this.cleanups.get(owner)?.()
		} catch (error) {
			console.error(`[workbench-ui] remote cleanup failed (${owner})`, error)
		}
		const changed = this.modules.delete(owner) || this.hashes.delete(owner)
		this.cleanups.delete(owner)
		if (changed) this.notify()
	}

	view(owner: string, exportName: string): ComponentType | undefined {
		return this.modules.get(owner)?.views[exportName]
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				console.error('[workbench-ui] registry listener failed', error)
			}
		}
	}
}

export const workbenchUiRegistry = new WorkbenchUiRegistry()
