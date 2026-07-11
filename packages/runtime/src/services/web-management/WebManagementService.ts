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

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: WebManagementService
		}
	}
}

@Injectable({ key: serviceName })
export class WebManagementService {
	private backend: WebManagementBackend | undefined

	constructor(
		public ctx: Context,
		_cfg: unknown,
	) {}

	get enabled(): boolean {
		return this.backend !== undefined
	}

	use<T>(callback: (web: PluginWebManagement) => T): T | undefined {
		const backend = this.backend
		if (!backend) return undefined
		const services = backend.forContext(this.ctx)
		return callback({
			ui: {
				register: services.ui.register.bind(services.ui),
				builtin: services.ui.builtin,
				interaction: services.ui.interaction,
			},
			rpc: { expose: services.rpc.expose.bind(services.rpc) },
			sse: { expose: services.sse.expose.bind(services.sse) },
			state: { collection: services.state.collection.bind(services.state) },
		})
	}

	/** @internal Host/runtime entry. Plugins use use(). */
	require(): WebManagementBackendServices {
		const backend = this.backend
		if (!backend) {
			throw new Error('[pluxel/runtime] Web Management is not enabled for this host.')
		}
		return backend.forContext(this.ctx)
	}

	/** @internal Installed by static/dynamic host launchers before plugin commit. */
	install(backend: WebManagementBackend): () => void {
		if (this.backend) throw new Error('[pluxel/runtime] Web Management is already installed.')
		this.backend = backend
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.backend !== backend) return
			this.backend = undefined
			void backend.dispose?.()
		}
	}
}
