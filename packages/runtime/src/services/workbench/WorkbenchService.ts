import { type Context as CoreContext, Injectable } from '@pluxel/core'
import type {
	AnyWorkbenchExtension,
	WorkbenchBindings,
	WorkbenchMount,
	PluginWorkbench,
} from '../../workbench'

const serviceName = 'workbench' as const

export interface WorkbenchBackend {
	forContext(ctx: CoreContext): PluginWorkbench
	dispose?(): void | Promise<void>
}

const installedBackends = new WeakMap<WorkbenchService, WorkbenchBackend>()

function rootGate(ctx: CoreContext): WorkbenchService {
	return ctx.root.workbench as unknown as WorkbenchService
}

function backendFor(ctx: CoreContext): WorkbenchBackend | undefined {
	return installedBackends.get(rootGate(ctx))
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: WorkbenchService
		}
	}
}

@Injectable({ key: serviceName })
export class WorkbenchService {
	constructor(
		public readonly ctx: CoreContext,
		_cfg: unknown,
	) {}

	get enabled(): boolean {
		return backendFor(this.ctx) !== undefined
	}

	mount<
		Extension extends AnyWorkbenchExtension,
		const Bindings extends WorkbenchBindings<Extension>,
	>(extension: Extension, bindings: Bindings): WorkbenchMount<Extension, Bindings> | undefined {
		const backend = backendFor(this.ctx)
		if (!backend) return undefined
		return backend.forContext(this.ctx).mount(extension, bindings)
	}
}

/** @internal */
export function requireWorkbenchBackend(ctx: CoreContext): WorkbenchBackend {
	const backend = backendFor(ctx)
	if (!backend) throw new Error('[pluxel/runtime] Workbench is not enabled for this host.')
	return backend
}

/** @internal */
export function installWorkbenchBackend(ctx: CoreContext, backend: WorkbenchBackend): () => void {
	const gate = rootGate(ctx)
	if (installedBackends.has(gate)) {
		throw new Error('[pluxel/runtime] Workbench is already installed.')
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
export function withWorkbenchPluginContext<T extends CoreContext.Config>(config: T): T {
	const registry =
		config.registry && typeof config.registry === 'object'
			? (config.registry as Record<string, unknown>)
			: {}
	const current = Array.isArray(registry.pluginCTXIsolate)
		? (registry.pluginCTXIsolate as unknown[])
		: []
	if (current.includes(WorkbenchService)) return config
	return {
		...config,
		registry: {
			...registry,
			pluginCTXIsolate: [...current, WorkbenchService],
		},
	} as T
}
