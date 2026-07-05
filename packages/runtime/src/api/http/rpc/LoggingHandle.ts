import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'

import { ensureRuntimePluginPolicyLoaded, persistRuntimePluginPolicy } from '../../../logger/levels'
import {
	runtimePluginLogPolicy,
	type PluginLogPolicySnapshot,
	type RuntimePluginLogLevel,
} from '../../../logger/policy'

export class LoggingHandle extends RpcTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	async getPolicy(): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async replacePolicy(snapshot: PluginLogPolicySnapshot): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.replace(snapshot)
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async setDefaultLevel(level: RuntimePluginLogLevel): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.setDefaultLevel(level)
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async clearDefaultLevel(): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.clearDefaultLevel()
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async setPluginLevel(
		pluginId: string,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.setPluginLevel(String(pluginId), level)
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async clearPluginLevel(pluginId: string): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.clearPluginLevel(String(pluginId))
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}

	async resetPolicy(): Promise<PluginLogPolicySnapshot> {
		await ensureRuntimePluginPolicyLoaded(this.ctx)
		runtimePluginLogPolicy.clear()
		persistRuntimePluginPolicy(this.ctx)
		return runtimePluginLogPolicy.snapshot()
	}
}
