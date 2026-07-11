import './http/InternalApiValidationService'
import './http/InternalGraphQLService'

import type { Context } from '@pluxel/core'
import { ExtensionService } from './plugin-interaction/ExtensionService'
import { RpcService } from './plugin-interaction/RpcService'
import { SignalDbService } from './plugin-interaction/SignalDbService'
import { SseService } from './plugin-interaction/SseService'
import type {
	WebManagementBackend,
	WebManagementBackendServices,
} from './web-management/WebManagementService'

class DefaultWebManagementBackend implements WebManagementBackend {
	private readonly children: Partial<{
		ui: ExtensionService
		rpc: RpcService
		sse: SseService
		state: SignalDbService
	}> = {}

	forContext(ctx: Context): WebManagementBackendServices {
		const ui =
			this.children.ui ??
			(this.children.ui = new ExtensionService(ctx, { enabled: true }))
		const rpc = this.children.rpc ?? (this.children.rpc = new RpcService(ctx, undefined))
		const sse = this.children.sse ?? (this.children.sse = new SseService(ctx, undefined))
		const state =
			this.children.state ?? (this.children.state = new SignalDbService(ctx, undefined))
		ui.ctx = ctx
		rpc.ctx = ctx
		sse.ctx = ctx
		state.ctx = ctx
		return { ui, rpc, sse, state }
	}
}

export function installWebManagement(ctx: Context): () => void {
	const dispose = ctx.root.webManagement.install(new DefaultWebManagementBackend())
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
