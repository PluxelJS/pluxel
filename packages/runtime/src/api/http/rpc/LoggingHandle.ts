import type { LogLevel } from '@logtape/logtape'
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'

import { runtimePluginLevels } from '../../../logger/ensure'
import { ensureRuntimePluginLevelsLoaded, persistRuntimePluginLevels } from '../../../logger/levels'

type PluginLogLevel = LogLevel | null

export type PluginLevelsSnapshot = {
	levels: Record<string, PluginLogLevel>
}

export class LoggingHandle extends RpcTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	async getPluginLevels(): Promise<PluginLevelsSnapshot> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		const levels = runtimePluginLevels.toRecord() as Record<string, PluginLogLevel>
		return { levels }
	}

	async setPluginLevel(pluginId: string, level: PluginLogLevel): Promise<{ ok: true }> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		runtimePluginLevels.set(String(pluginId), level)
		persistRuntimePluginLevels(this.ctx)
		return { ok: true }
	}

	async deletePluginLevel(pluginId: string): Promise<{ ok: true }> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		runtimePluginLevels.delete(String(pluginId))
		persistRuntimePluginLevels(this.ctx)
		return { ok: true }
	}

	async setPluginLevelDefault(level: PluginLogLevel): Promise<{ ok: true }> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		runtimePluginLevels.setDefault(level)
		persistRuntimePluginLevels(this.ctx)
		return { ok: true }
	}

	async deletePluginLevelDefault(): Promise<{ ok: true }> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		runtimePluginLevels.delete('*')
		persistRuntimePluginLevels(this.ctx)
		return { ok: true }
	}

	async clearPluginLevels(): Promise<{ ok: true }> {
		await ensureRuntimePluginLevelsLoaded(this.ctx)
		runtimePluginLevels.clear()
		persistRuntimePluginLevels(this.ctx)
		return { ok: true }
	}
}
