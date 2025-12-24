import { type Context, Injectable } from '@pluxel/core'

import { ExtensionService } from './ExtensionService'
import { RpcService } from './RpcService'
import { SseService } from './SseService'

@Injectable({ key: 'ext' })
export class ExtService {
	private _rpc: RpcService | null = null
	private _sse: SseService | null = null
	private _ui: ExtensionService | null = null

	constructor(public ctx: Context, _cfg: unknown = undefined) {}

	/** Plugin RPC extensions registry */
	get rpc(): RpcService {
		const ctx = this.ctx
		let inst = this._rpc
		if (!inst) {
			inst = new RpcService(ctx, (ctx.config as any)?.rpc)
			this._rpc = inst
		}
		inst.ctx = ctx
		return inst
	}

	/** Server-Sent Events extension registry + stream entry */
	get sse(): SseService {
		const ctx = this.ctx
		let inst = this._sse
		if (!inst) {
			inst = new SseService(ctx, (ctx.config as any)?.sse)
			this._sse = inst
		}
		inst.ctx = ctx
		return inst
	}

	/** Plugin UI module compiler/manifest service */
	get ui(): ExtensionService {
		const ctx = this.ctx
		let inst = this._ui
		if (!inst) {
			inst = new ExtensionService(ctx, (ctx.config as any)?.extensionService)
			this._ui = inst
		}
		inst.ctx = ctx
		return inst
	}

	// No isolate() here by design: ExtService owns the subservices and rebinds `ctx`
	// on access, mirroring Context's service getter behavior.
}
