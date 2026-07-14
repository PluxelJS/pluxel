import type { ComponentType } from 'react'
import type { ManagementUiModule } from '@pluxel/runtime/management/ui'
import type { LocaleService } from '@pluxel/runtime/web'

class ManagementUiRegistry {
	private readonly modules = new Map<string, ManagementUiModule>()
	private readonly hashes = new Map<string, string>()
	private readonly cleanups = new Map<string, () => void>()
	private readonly listeners = new Set<() => void>()

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async load(
		owner: string,
		importer: () => Promise<ManagementUiModule | { default?: ManagementUiModule }>,
		hash: string,
		locale: LocaleService,
	): Promise<void> {
		if (this.hashes.get(owner) === hash) return
		const imported = await importer()
		const module =
			imported && typeof imported === 'object' && 'default' in imported && imported.default
				? imported.default
				: (imported as ManagementUiModule)
		if (!module || typeof module !== 'object' || !module.views) {
			throw new Error(`[management-ui] invalid UI module for ${owner}`)
		}
		this.unload(owner)
		let cleanup: void | (() => void)
		if (module.setup) cleanup = await module.setup({ owner, locale })
		this.modules.set(owner, module)
		this.hashes.set(owner, hash)
		if (typeof cleanup === 'function') this.cleanups.set(owner, cleanup)
		this.notify()
	}

	unload(owner: string): void {
		try {
			this.cleanups.get(owner)?.()
		} catch (error) {
			console.error(`[management-ui] remote cleanup failed (${owner})`, error)
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
				console.error('[management-ui] registry listener failed', error)
			}
		}
	}
}

export const managementUiRegistry = new ManagementUiRegistry()
