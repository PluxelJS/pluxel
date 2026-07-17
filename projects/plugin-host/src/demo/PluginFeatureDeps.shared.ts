import { BaseFeature } from '@pluxel/runtime'

// Shared support for `PluginFeatureDepsDemo.ts`:
// - event payload types
// - a tiny reusable feature

export type TickPayload = {
	from: string
	seq: number
	at: number
}

export type TickEvent = readonly [payload: TickPayload]

export class PluginLoggerFeature extends BaseFeature {
	info(message: string, extra?: Record<string, unknown>) {
		this.ctx.logger.info(message, {
			plugin: this.ctx.pluginInfo.id,
			...extra,
		})
	}

	debug(message: string, extra?: Record<string, unknown>) {
		this.ctx.logger.debug(message, {
			plugin: this.ctx.pluginInfo.id,
			...extra,
		})
	}
}
