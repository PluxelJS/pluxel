import type { Context } from '@pluxel/core'

import { readStatusSnapshot, resolvePluginSource } from '../features/pluginStatus/service'

export type PluginStatusSnapshot = ReturnType<typeof readStatusSnapshot> & { name: string }

export type PluginsListOutput = {
	plugins: PluginStatusSnapshot[]
	summary: {
		total: number
		running: number
		stopped: number
		disabled: number
	}
}

export function pluginStatus(ctx: Context, name: string): PluginStatusSnapshot | null {
	const ctor = ctx.loader.api.runtime.resolve(name) ?? ctx.loader.api.registry.getCtor(name)
	if (!ctor) return null
	const snap = readStatusSnapshot(ctx, name, ctor)
	const source = ((snap as any).source && typeof (snap as any).source === 'object')
		? (() => {
				const { __typename: _t, ...rest } = (snap as any).source
				return rest
			})()
		: snap.source
	return { name, ...snap, source } as any
}

export function pluginsList(ctx: Context): PluginsListOutput {
	const out: PluginStatusSnapshot[] = []
	for (const [name, ctor] of ctx.loader.api.registry.listRegistered()) {
		const snap = readStatusSnapshot(ctx, name, ctor)
		const source = ((snap as any).source && typeof (snap as any).source === 'object')
			? (() => {
					const { __typename: _t, ...rest } = (snap as any).source
					return rest
				})()
			: snap.source
		out.push({ name, ...snap, source } as any)
	}
	out.sort((a, b) => a.name.localeCompare(b.name))

	let running = 0
	let disabled = 0
	for (const e of out) {
		if (e.isRunning) running += 1
		if (e.isEnabled === false) disabled += 1
	}

	return {
		plugins: out,
		summary: {
			total: out.length,
			running,
			disabled,
			stopped: out.length - running - disabled,
		},
	}
}

export function pluginSource(ctx: Context, name: string) {
	const ctor = ctx.loader.api.runtime.resolve(name) ?? ctx.loader.api.registry.getCtor(name) ?? undefined
	const src: any = resolvePluginSource(ctx, name, ctor)
	if (src && typeof src === 'object') {
		const { __typename: _t, ...rest } = src
		return rest
	}
	return src
}
