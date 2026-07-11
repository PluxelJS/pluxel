import './http/InternalApiValidationService'
import './http/InternalGraphQLService'

import type { Context } from '@pluxel/core'
import { ExtensionService } from './plugin-interaction/ExtensionService'
import { RpcService } from './plugin-interaction/RpcService'
import { SignalDbService } from './plugin-interaction/SignalDbService'
import { SseService } from './plugin-interaction/SseService'
import {
	installWebManagementBackend,
	type WebManagementBackend,
	type WebManagementBackendServices,
} from './web-management/WebManagementService'

function bindContext<T extends { ctx: Context }>(service: T, ctx: Context): T {
	return new Proxy(service, {
		get(target, property) {
			if (property === 'ctx') return ctx
			return Reflect.get(target, property, target)
		},
		set(target, property, value) {
			if (property === 'ctx') return false
			return Reflect.set(target, property, value, target)
		},
	})
}

class DefaultWebManagementBackend implements WebManagementBackend {
	private readonly children: Partial<{
		ui: ExtensionService
		rpc: RpcService
		sse: SseService
		state: SignalDbService
	}> = {}
	private readonly views = new WeakMap<Context, WebManagementBackendServices>()

	forContext(ctx: Context): WebManagementBackendServices {
		const existing = this.views.get(ctx)
		if (existing) return existing

		const serviceCtx = ctx.root
		const ui =
			this.children.ui ??
			(this.children.ui = new ExtensionService(serviceCtx, { enabled: true }))
		const rpc = this.children.rpc ?? (this.children.rpc = new RpcService(serviceCtx, undefined))
		const sse = this.children.sse ?? (this.children.sse = new SseService(serviceCtx, undefined))
		const state =
			this.children.state ?? (this.children.state = new SignalDbService(serviceCtx, undefined))
		const view = {
			ui: bindContext(ui, ctx),
			rpc: bindContext(rpc, ctx),
			sse: bindContext(sse, ctx),
			state: bindContext(state, ctx),
		}
		this.views.set(ctx, view)
		return view
	}
}

export function installWebManagement(ctx: Context): () => void {
	const dispose = installWebManagementBackend(ctx, new DefaultWebManagementBackend())
	const guard = ctx.root.effects.defer(dispose)
	return () => guard.dispose()
}

export type {
	SignalDbCollectionHandle,
	SignalDbCollectionOptions,
	SignalDbDocumentHandle,
} from './plugin-interaction/SignalDbService'
export type { SseChannel } from './plugin-interaction/SseService'
export type { ExtensionUiRpcMap } from '../web/protocol'
export type { PluginWebManagement } from './web-management/WebManagementService'
