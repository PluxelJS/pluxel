import type { LogLevel } from '@logtape/logtape'
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'

import { hmrPluginLevels } from '../../../logger/ensure'
import { ensureHmrPluginLevelsLoaded, persistHmrPluginLevels } from '../../../logger/levels'

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
		await ensureHmrPluginLevelsLoaded(this.ctx)
		const levels = hmrPluginLevels.toRecord()
		return { levels }
	}

	async setPluginLevel(pluginId: string, level: PluginLogLevel): Promise<{ ok: true }> {
		await ensureHmrPluginLevelsLoaded(this.ctx)
		hmrPluginLevels.set(String(pluginId), level)
		persistHmrPluginLevels(this.ctx)
		return { ok: true }
	}

	async deletePluginLevel(pluginId: string): Promise<{ ok: true }> {
		await ensureHmrPluginLevelsLoaded(this.ctx)
		hmrPluginLevels.delete(String(pluginId))
		persistHmrPluginLevels(this.ctx)
		return { ok: true }
	}

	async setPluginLevelDefault(level: PluginLogLevel): Promise<{ ok: true }> {
		await ensureHmrPluginLevelsLoaded(this.ctx)
		hmrPluginLevels.setDefault(level)
		persistHmrPluginLevels(this.ctx)
		return { ok: true }
	}

	async deletePluginLevelDefault(): Promise<{ ok: true }> {
		await ensureHmrPluginLevelsLoaded(this.ctx)
		hmrPluginLevels.delete('*')
		persistHmrPluginLevels(this.ctx)
		return { ok: true }
	}

	async clearPluginLevels(): Promise<{ ok: true }> {
		await ensureHmrPluginLevelsLoaded(this.ctx)
		hmrPluginLevels.clear()
		persistHmrPluginLevels(this.ctx)
		return { ok: true }
	}
}
