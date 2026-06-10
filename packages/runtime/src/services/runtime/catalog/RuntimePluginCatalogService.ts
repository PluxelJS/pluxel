import { Injectable, type Context, type PluginConstructor } from '@pluxel/core'
import type { ConfigLayout } from '@pluxel/core'
import type { ConfigSchemaMap } from '@pluxel/core/services'

const serviceName = 'pluginCatalog' as const

export const EXTRA_BASE_PROVIDERS = 'pluxel:baseProviders' as const
export const EXTRA_FORKS = 'pluxel:forks' as const
export const EXTRA_DEP_OVERRIDES = 'pluxel:depOverrides' as const
export const EXTRA_BUILTINS_KNOWN = 'pluxel:builtinsKnown' as const

/**
 * Global base-provider selection.
 * key: abstract base token name (usually ctor.name)
 * val: provider plugin id
 */
export type BaseProvidersExtra = Record<string, string>

/**
 * Fork catalog (so forks can be restarted across reloads).
 * key: original plugin id
 * val: list of forkIds (the part after '#')
 */
export type ForksExtra = Record<string, string[]>

/**
 * Per-plugin dependency overrides (constructor parameter tokens).
 * key: consumer plugin id
 * val: index -> target plugin id (may include '#')
 */
export type DepOverridesExtra = Record<string, Record<number, string>>

/**
 * Builtins "known" catalog.
 *
 * Purpose:
 * - seed default-enabled builtins only once (first encounter);
 * - never re-enable a builtin the user has disabled (or auto-disabled due to MissingDependency)
 *   on subsequent startups.
 */
export type BuiltinsKnownExtra = Record<string, 1>

export type RuntimePluginSource =
	| {
			__typename: 'PluginSourceInfo'
			kind: 'package'
			moduleId: string
			packageName: string
			version: string | null
			tag: string | null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'hmr'
			moduleId: string
			packageName: null
			version: null
			tag: null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'unknown'
			moduleId: null
			packageName: null
			version: null
			tag: null
	  }

export type RuntimePluginLifecycleStage = 'running' | 'stopped' | 'disabled'

export type RuntimePluginStatusSnapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: RuntimePluginLifecycleStage
	source: RuntimePluginSource
}

export type RuntimePluginStatusOverview = {
	statuses: Array<RuntimePluginStatusSnapshot & { name: string }>
	summary: {
		total: number
		running: number
		stopped: number
		disabled: number
	}
}

export type RuntimePluginDependencyInfo = Array<{ name: string; isRunning: boolean }>
export type RuntimePluginCatalog = Omit<RuntimePluginCatalogService, 'ctx'>

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: RuntimePluginCatalogService
		}
	}
}

@Injectable({ key: serviceName })
export class RuntimePluginCatalogService {
	constructor(public readonly ctx: Context) {}

	private missing(): never {
		throw new Error(
			'[pluxel/runtime] No plugin catalog route is registered. Import a route package such as @pluxel/runtime-dynamic/register before using plugin catalog APIs.',
		)
	}

	resolve(_target: PluginConstructor | string): PluginConstructor | undefined {
		return this.missing()
	}

	resolveOrRegistered(_name: string): PluginConstructor | undefined {
		return this.missing()
	}

	require(_name: string): PluginConstructor {
		return this.missing()
	}

	listRegistered(): ReadonlyMap<string, PluginConstructor> {
		return this.missing()
	}

	listLoadedNames(): string[] {
		return this.missing()
	}

	isRunning(_target: PluginConstructor | string): boolean {
		return this.missing()
	}

	isEnabled(_name: string): boolean {
		return this.missing()
	}

	getModuleId(_name: string, _ctor?: PluginConstructor): string | null {
		return this.missing()
	}

	getSchema(_name: string): ConfigSchemaMap | undefined {
		return this.missing()
	}

	getSchemaSource(_name: string): Readonly<Record<string, string>> | undefined {
		return this.missing()
	}

	getConfigLayout(_name: string): Readonly<Record<string, ConfigLayout>> | undefined {
		return this.missing()
	}

	listDependencies(_ctor: PluginConstructor): RuntimePluginDependencyInfo {
		return this.missing()
	}

	enable(_name: string, _ctor: PluginConstructor): Promise<void> | void {
		return this.missing()
	}

	enablePersisted(_name: string): Promise<void> | void {
		return this.missing()
	}

	deactivate(_name: string, _ctor: PluginConstructor, _options: { runtimeOnly: boolean }) {
		this.missing()
	}

	stop(_name: string, _ctor: PluginConstructor) {
		this.missing()
	}

	resolveSource(_name: string, _ctor?: PluginConstructor): RuntimePluginSource {
		return this.missing()
	}

	readStatus(_name: string, _ctor: PluginConstructor): RuntimePluginStatusSnapshot {
		return this.missing()
	}

	statusOverview(): RuntimePluginStatusOverview {
		return this.missing()
	}

	ensureForkBase(_baseName: string): PluginConstructor | undefined {
		return this.missing()
	}
}

export function getRuntimePluginCatalog(ctx: Context): RuntimePluginCatalog {
	return ctx.pluginCatalog
}
