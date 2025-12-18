import { type Context, Injectable } from '@pluxel/context'

const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null))

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
	private store = new Map<string, Record<string, unknown>>()
	private extra: Record<string, unknown> = Object.create(null)

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

	getConfig<T extends object = Record<string, unknown>>(name: string): Readonly<T> {
		return (this.store.get(name) as T | undefined) ?? (EMPTY_CONFIG as T)
	}

	patchConfig<T extends object = Record<string, unknown>>(name: string, patch: Partial<T>) {
		let entry = this.store.get(name)
		if (!entry) {
			entry = Object.create(null)
			this.store.set(name, entry)
		}
		Object.assign(entry, patch)
	}

	getExtra<T = unknown>(key: string): T | undefined {
		return this.extra[key] as T | undefined
	}

	setExtra(key: string, value: unknown): void {
		this.extra[key] = value
	}

	constructor(_ctx: Context) {}
}
