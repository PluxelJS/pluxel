import { type Context, Injectable } from '@pluxel/core'

import { ExtensionService } from './ExtensionService'
import { RpcService } from './RpcService'
import { SseService } from './SseService'

const serviceName = 'ext' as const

type ExtChildren = {
	rpc: RpcService
	sse: SseService
	ui: ExtensionService
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: ExtService
		}
	}
}

@Injectable({ key: 'ext' })
export class ExtService {
	private readonly children: Partial<ExtChildren> = {}

	constructor(
		public ctx: Context,
		_cfg: unknown = undefined,
	) {}

	/** Plugin RPC extensions registry */
	get rpc(): Context.PublicService<RpcService> {
		return this.use('rpc', (ctx) => new RpcService(ctx, (ctx.config as any)?.rpc))
	}

	/** Server-Sent Events extension registry + stream entry */
	get sse(): Context.PublicService<SseService> {
		return this.use('sse', (ctx) => new SseService(ctx, (ctx.config as any)?.sse))
	}

	/** Plugin UI module compiler/manifest service */
	get ui(): Context.PublicService<ExtensionService> {
		return this.use('ui', (ctx) => new ExtensionService(ctx, (ctx.config as any)?.extensionService))
	}

	private use<K extends keyof ExtChildren>(
		key: K,
		factory: (ctx: Context) => ExtChildren[K],
	): Context.PublicService<ExtChildren[K]> {
		const ctx = this.ctx
		let service = this.children[key]
		if (!service) {
			service = factory(ctx)
			this.children[key] = service
		}
		service.ctx = ctx
		return service as Context.PublicService<ExtChildren[K]>
	}
}
