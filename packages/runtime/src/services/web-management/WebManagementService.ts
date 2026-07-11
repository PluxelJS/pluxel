import { type Context, Injectable } from '@pluxel/core'
import type { ExtensionService } from '../plugin-interaction/ExtensionService'
import type { RpcService } from '../plugin-interaction/RpcService'
import type { SignalDbService } from '../plugin-interaction/SignalDbService'
import type { SseService } from '../plugin-interaction/SseService'

const serviceName = 'webManagement' as const

export interface PluginUiContributions
	extends Pick<Context.PublicService<ExtensionService>, 'register' | 'builtin' | 'interaction'> {}

export interface PluginRpcRegistry
	extends Pick<Context.PublicService<RpcService>, 'expose'> {}

export interface PluginSseRegistry
	extends Pick<Context.PublicService<SseService>, 'expose'> {}

export interface PluginManagementState
	extends Pick<Context.PublicService<SignalDbService>, 'collection'> {}

export interface PluginWebManagement {
	readonly ui: PluginUiContributions
	readonly rpc: PluginRpcRegistry
	readonly sse: PluginSseRegistry
	readonly state: PluginManagementState
}

export interface WebManagementBackendServices {
	readonly ui: Context.PublicService<ExtensionService>
	readonly rpc: Context.PublicService<RpcService>
	readonly sse: Context.PublicService<SseService>
	readonly state: Context.PublicService<SignalDbService>
}

export interface WebManagementBackend {
	forContext(ctx: Context): WebManagementBackendServices
	dispose?(): void | Promise<void>
}

const installedBackends = new WeakMap<WebManagementService, WebManagementBackend>()

function rootGate(ctx: Context): WebManagementService {
	return ctx.root.webManagement
}

function backendFor(ctx: Context): WebManagementBackend | undefined {
	return installedBackends.get(rootGate(ctx))
}

function authorView(services: WebManagementBackendServices): PluginWebManagement {
	return {
		ui: {
			register: services.ui.register.bind(services.ui),
			builtin: { doc: services.ui.doc.bind(services.ui) },
			interaction: {
				surface: services.ui.surface.bind(services.ui),
				offer: services.ui.offer.bind(services.ui),
			},
		},
		rpc: { expose: services.rpc.expose.bind(services.rpc) },
		sse: { expose: services.sse.expose.bind(services.sse) },
		state: { collection: services.state.collection.bind(services.state) },
	}
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: WebManagementService
		}
	}
}

@Injectable({ key: serviceName })
export class WebManagementService {
	constructor(
		public ctx: Context,
		_cfg: unknown,
	) {}

	get enabled(): boolean {
		return backendFor(this.ctx) !== undefined
	}

	use<T>(callback: (web: PluginWebManagement) => T): T | undefined {
		const backend = backendFor(this.ctx)
		if (!backend) return undefined
		return callback(authorView(backend.forContext(this.ctx)))
	}
}

/** @internal Runtime-only access to the installed backend services. */
export function requireWebManagement(ctx: Context): WebManagementBackendServices {
	const backend = backendFor(ctx)
	if (!backend) {
		throw new Error('[pluxel/runtime] Web Management is not enabled for this host.')
	}
	return backend.forContext(ctx)
}

/** @internal Installed by host launchers before the first plugin commit. */
export function installWebManagementBackend(
	ctx: Context,
	backend: WebManagementBackend,
): () => void {
	const gate = rootGate(ctx)
	if (installedBackends.has(gate)) {
		throw new Error('[pluxel/runtime] Web Management is already installed.')
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
