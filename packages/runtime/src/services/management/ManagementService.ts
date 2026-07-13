import { type Context as CoreContext, Injectable } from '@pluxel/core'
import type {
	AnyManagementModule,
	ManagementBindings,
	ManagementMount,
	PluginManagement,
} from '../../management'

const serviceName = 'management' as const

export interface ManagementBackend {
	forContext(ctx: CoreContext): PluginManagement
	dispose?(): void | Promise<void>
}

const installedBackends = new WeakMap<ManagementService, ManagementBackend>()

function rootGate(ctx: CoreContext): ManagementService {
	return ctx.root.management as unknown as ManagementService
}

function backendFor(ctx: CoreContext): ManagementBackend | undefined {
	return installedBackends.get(rootGate(ctx))
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: ManagementService
		}
	}
}

@Injectable({ key: serviceName })
export class ManagementService {
	constructor(
		public readonly ctx: CoreContext,
		_cfg: unknown,
	) {}

	get enabled(): boolean {
		return backendFor(this.ctx) !== undefined
	}

	mount<Module extends AnyManagementModule>(
		module: Module,
		bindings: ManagementBindings<Module>,
	): ManagementMount<Module> | undefined {
		const backend = backendFor(this.ctx)
		if (!backend) return undefined
		return backend.forContext(this.ctx).mount(module, bindings)
	}
}

/** @internal */
export function requireManagementBackend(ctx: CoreContext): ManagementBackend {
	const backend = backendFor(ctx)
	if (!backend) throw new Error('[pluxel/runtime] Management is not enabled for this host.')
	return backend
}

/** @internal */
export function installManagementBackend(ctx: CoreContext, backend: ManagementBackend): () => void {
	const gate = rootGate(ctx)
	if (installedBackends.has(gate)) {
		throw new Error('[pluxel/runtime] Management is already installed.')
	}
	installedBackends.set(gate, backend)
	let active = true
	return () => {
		if (!active) return
		active = false
		if (installedBackends.get(gate) !== backend) return
		installedBackends.delete(gate)
		void backend.dispose?.()
	}
}

/** @internal Keep the lightweight gate isolated per plugin Context. */
export function withManagementPluginContext<T extends CoreContext.Config>(config: T): T {
	const registry =
		config.registry && typeof config.registry === 'object'
			? (config.registry as Record<string, unknown>)
			: {}
	const current = Array.isArray(registry.pluginCTXIsolate)
		? (registry.pluginCTXIsolate as unknown[])
		: []
	if (current.includes(ManagementService)) return config
	return {
		...config,
		registry: {
			...registry,
			pluginCTXIsolate: [...current, ManagementService],
		},
	} as T
}
