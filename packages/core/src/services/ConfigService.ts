import { type Context, Injectable } from '@pluxel/context'

export type PluginConfigSnapshot = {
	meta: Record<string, unknown>
	configRecord: Record<string, unknown>
}

const serviceName = 'configService' as const
declare module '@pluxel/context' {
	export interface Context {
		[serviceName]: ConfigService
	}
}

/**
 * Core config service: provides a stable, minimal contract for plugin config access.
 *
 * - Core owns "when/how @Config is injected".
 * - Apps/HMR own persistence, validation, defaults, and enablement policies by overriding this service.
 *
 * Note on enablement:
 * - This service stores enablement preference in config state.
 * - Core does not interpret it; orchestrators/loaders may use it to decide whether a plugin should be started.
 */
@Injectable({ key: serviceName })
export class ConfigService {
	private enabledInConfig = new Set<string>()
	private store = new Map<string, PluginConfigSnapshot>()

	isEnabledInConfig(name: string): boolean {
		return this.enabledInConfig.has(name)
	}

	setEnabledInConfig(name: string, enabled: boolean) {
		if (enabled) this.enabledInConfig.add(name)
		else this.enabledInConfig.delete(name)
	}

	enableInConfig(...names: string[]) {
		for (const n of names) this.enabledInConfig.add(n)
	}

	disableInConfig(...names: string[]) {
		for (const n of names) this.enabledInConfig.delete(n)
	}

	replaceEnabledInConfigSet(names: Iterable<string>) {
		this.enabledInConfig.clear()
		for (const n of names) this.enabledInConfig.add(n)
	}

	getConfigSnapshot(name: string): PluginConfigSnapshot {
		return this.store.get(name) ?? { meta: {}, configRecord: {} }
	}

	patchConfigSnapshot(name: string, patch: Partial<PluginConfigSnapshot>) {
		const prev = this.getConfigSnapshot(name)
		this.store.set(name, {
			meta: { ...prev.meta, ...(patch.meta ?? {}) },
			configRecord: { ...prev.configRecord, ...(patch.configRecord ?? {}) },
		})
	}

	constructor(_ctx: Context) {}
}
