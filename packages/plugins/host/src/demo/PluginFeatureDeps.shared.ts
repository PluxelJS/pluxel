import { BaseFeature } from '@pluxel/runtime'

// Shared support for `PluginFeatureDepsDemo.ts`:
// - event payload types
// - a tiny reusable feature
// - bridge reconnect helper

export type TickPayload = {
	from: string
	seq: number
	at: number
}

export type TickEvent = readonly [payload: TickPayload]

export type MsgPayload = {
	from: string
	text: string
	at: number
}

export type MsgEvent = readonly [payload: MsgPayload]

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

// Keep bridge reconnect logic out of the plugin class so the main demo reads linearly.
type BindingState<Provider, Consumer> = {
	provider?: Provider
	consumer?: Consumer
	unbind?: () => void
}

export function reconnectOptionalPair<Provider, Consumer>(
	state: BindingState<Provider, Consumer>,
	bind: (consumer: Consumer, provider: Provider) => () => void,
) {
	if (state.unbind) state.unbind()
	state.unbind = undefined
	if (!state.provider || !state.consumer) return
	state.unbind = bind(state.consumer, state.provider)
}
