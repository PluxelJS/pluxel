import {
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { isPluginEnabled, setPluginsEnabled } from '@pluxel/runtime/internal'

type PluginTarget = PluginConstructor | PluginNodeAddress

function addressOf(target: PluginTarget): PluginNodeAddress {
	return typeof target === 'function' ? pluginNodeAddressOf(target) : target
}

export function enablePlugins(ctx: Context, ...targets: PluginTarget[]): void {
	ctx.runtimeState.update((draft) => setPluginsEnabled(draft, targets.map(addressOf), true))
}

export function disablePlugins(ctx: Context, ...targets: PluginTarget[]): void {
	ctx.runtimeState.update((draft) => setPluginsEnabled(draft, targets.map(addressOf), false))
}

export function isEnabled(ctx: Context, target: PluginTarget): boolean {
	return isPluginEnabled(ctx.runtimeState.snapshot(), addressOf(target))
}
