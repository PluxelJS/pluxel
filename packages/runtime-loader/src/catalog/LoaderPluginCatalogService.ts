import {
	ForkablePlugin,
	formatForkPluginId,
	getPluginInfo,
	OverrideOf,
	type Context,
	type PluginConstructor,
} from '@pluxel/core'
import type { ConfigLayout } from '@pluxel/core'
import type { ConfigSchemaMap } from '@pluxel/core/services'
import {
	EXTRA_FORKS,
	type ForksExtra,
	RuntimePluginCatalogService,
	type RuntimePluginCatalog,
	type RuntimePluginLifecycleStage,
	type RuntimePluginSource,
	type RuntimePluginStatusOverview,
	type RuntimePluginStatusSnapshot,
} from '@pluxel/runtime/plugin-catalog'

@OverrideOf(RuntimePluginCatalogService)
export class LoaderPluginCatalogService extends RuntimePluginCatalogService {
	constructor(public override readonly ctx: Context) {
		super(ctx)
	}

	resolve(target: PluginConstructor | string): PluginConstructor | undefined {
		return this.ctx.loader.api.runtime.resolve(target)
	}

	resolveOrRegistered(name: string): PluginConstructor | undefined {
		return this.resolve(name) ?? this.ctx.loader.api.registry.getCtor(name)
	}

	require(name: string): PluginConstructor {
		const ctor = this.resolveOrRegistered(name)
		if (!ctor) throw new Error(`Plugin not found: ${name}`)
		return ctor
	}

	listRegistered(): ReadonlyMap<string, PluginConstructor> {
		return this.ctx.loader.api.registry.listRegistered()
	}

	listLoadedNames(): string[] {
		return this.ctx.loader.api.registry.listLoadedNames()
	}

	isRunning(target: PluginConstructor | string): boolean {
		return this.ctx.loader.api.runtime.isRunning(target)
	}

	isEnabled(name: string): boolean {
		return this.ctx.configService.isEnabledInConfig(name)
	}

	getModuleId(name: string, ctor?: PluginConstructor): string | null {
		return this.ctx.loader.api.registry.findModuleId(name, ctor)
	}

	getSchema(name: string): ConfigSchemaMap | undefined {
		return this.ctx.loader.api.registry.getSchema(name)
	}

	getSchemaSource(name: string): Readonly<Record<string, string>> | undefined {
		return this.ctx.loader.api.registry.getSchemaSource(name)
	}

	getConfigLayout(name: string): Readonly<Record<string, ConfigLayout>> | undefined {
		return this.ctx.loader.api.registry.getConfigLayout(name)
	}

	listDependencies(ctor: PluginConstructor) {
		return this.ctx.loader.api.deps.list(ctor)
	}

	enable(name: string, ctor: PluginConstructor) {
		return this.ctx.loader.api.control.enable(name, ctor)
	}

	enablePersisted(name: string) {
		return this.ctx.loader.api.control.enablePersisted(name)
	}

	deactivate(name: string, ctor: PluginConstructor, options: { runtimeOnly: boolean }) {
		this.ctx.loader.api.control.deactivate(name, ctor, options)
	}

	stop(name: string, ctor: PluginConstructor) {
		this.ctx.loader.api.control.stop(name, ctor)
	}

	resolveSource(name: string, ctor?: PluginConstructor): RuntimePluginSource {
		const moduleId = this.getModuleId(name, ctor)
		if (moduleId) {
			const packageSpec = this.ctx.packageService?.getPackageSpecByModuleId?.(moduleId)
			if (packageSpec) {
				return {
					__typename: 'PluginSourceInfo',
					kind: 'package',
					packageName: packageSpec.name,
					version: packageSpec.version ?? null,
					tag: packageSpec.tag ?? null,
					moduleId,
				}
			}
			return {
				__typename: 'PluginSourceInfo',
				kind: 'hmr',
				moduleId,
				packageName: null,
				version: null,
				tag: null,
			}
		}
		return {
			__typename: 'PluginSourceInfo',
			kind: 'unknown',
			moduleId: null,
			packageName: null,
			version: null,
			tag: null,
		}
	}

	readStatus(name: string, ctor: PluginConstructor): RuntimePluginStatusSnapshot {
		const isRunning = this.isRunning(ctor)
		const isEnabled = this.isEnabled(name)
		const lifecycleStage: RuntimePluginLifecycleStage = !isEnabled
			? 'disabled'
			: isRunning
				? 'running'
				: 'stopped'
		const source = this.resolveSource(name, ctor)
		return { isRunning, isEnabled, lifecycleStage, source }
	}

	statusOverview(): RuntimePluginStatusOverview {
		const nameToCtor = this.listRegistered()
		const forkNames = new Set<string>()
		const catalog = this.ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS) ?? {}

		for (const [baseName, baseCtor] of nameToCtor) {
			const forkIds = catalog?.[baseName]
			if (Array.isArray(forkIds)) {
				for (const raw of forkIds) {
					const fid = typeof raw === 'string' ? raw.trim() : ''
					if (!fid) continue
					try {
						forkNames.add(formatForkPluginId(baseName, fid))
					} catch {}
				}
			}
			for (const forkCtor of this.ctx.registry.listForks(baseCtor as never)) {
				try {
					forkNames.add(getPluginInfo(forkCtor as never).id)
				} catch {}
			}
		}

		const allNames = [...new Set<string>([...nameToCtor.keys(), ...forkNames])].sort((a, b) =>
			a.localeCompare(b),
		)
		const statuses: Array<RuntimePluginStatusSnapshot & { name: string }> = []
		for (const name of allNames) {
			const ctor = this.resolve(name) ?? nameToCtor.get(name)
			if (!ctor) continue
			statuses.push({ name, ...this.readStatus(name, ctor) })
		}

		let running = 0
		let disabled = 0
		for (const e of statuses) {
			if (e.isRunning) running += 1
			if (e.isEnabled === false) disabled += 1
		}

		return {
			statuses,
			summary: {
				total: statuses.length,
				running,
				disabled,
				stopped: statuses.length - running - disabled,
			},
		}
	}

	ensureForkBase(baseName: string): PluginConstructor | undefined {
		const baseCtor = this.resolve(baseName)
		if (!baseCtor) return undefined
		const proto = (baseCtor as { prototype?: unknown }).prototype
		if (!proto || !(proto instanceof ForkablePlugin)) return undefined
		return baseCtor
	}
}

export function getRuntimePluginCatalog(ctx: Context): RuntimePluginCatalog {
	return ctx.pluginCatalog ?? new LoaderPluginCatalogService(ctx)
}
