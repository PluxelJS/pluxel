import type { Context } from '@pluxel/core'
import { isPluginEnabled, setPluginsEnabled } from '@pluxel/runtime/internal'

export function enablePlugins(ctx: Context, ...names: string[]): void {
	ctx.runtimeState.update((draft) => setPluginsEnabled(draft, names, true))
}

export function disablePlugins(ctx: Context, ...names: string[]): void {
	ctx.runtimeState.update((draft) => setPluginsEnabled(draft, names, false))
}

export function isEnabled(ctx: Context, name: string): boolean {
	return isPluginEnabled(ctx.runtimeState.snapshot(), name)
}
