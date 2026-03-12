import type { Context } from '@pluxel/core'

import { readStatusSnapshot } from '../features/pluginStatus/service'
import { maybeAddForkToCatalog } from './forksCatalog'
import type {
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
} from '../http/rpc/types'

function resolvePlugin(ctx: Context, name: string) {
	const ctor = ctx.loader.api.runtime.resolve(name)
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string') return message
	}
	return String(error)
}

async function runStatusAction(
	ctx: Context,
	name: string,
	action: PluginStatusAction,
): Promise<PluginStatusMutationResult> {
	try {
		if (action === 'start' || action === 'restart' || action === 'enable') {
			maybeAddForkToCatalog(ctx, name)
		}

		const ctor = resolvePlugin(ctx, name)

		switch (action) {
			case 'start':
				await ctx.loader.api.control.enable(name, ctor)
				break
			case 'stop':
				ctx.loader.api.control.deactivate(name, ctor, { runtimeOnly: true })
				break
			case 'restart':
				ctx.loader.api.control.deactivate(name, ctor, { runtimeOnly: true })
				await ctx.loader.api.control.enable(name, ctor)
				break
			case 'disable':
				ctx.loader.api.control.deactivate(name, ctor, { runtimeOnly: false })
				break
			case 'enable':
				ctx.loader.api.control.enablePersisted(name)
				break
			default:
				return { name, ok: false, code: 'invalid_status', error: `Unsupported: ${action}` }
		}
		return { name, ok: true }
	} catch (error) {
		const isStart = action === 'start' || action === 'restart'
		const message = getErrorMessage(error)
		const code = message.includes('Plugin not found')
			? 'plugin_not_found'
			: isStart
				? 'plugin_start_failed'
				: 'plugin_operation_failed'
		return { name, ok: false, code, error: message }
	}
}

export async function applyStatusActions(
	ctx: Context,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	if (!actions.length) return { ok: true, results: [] }

	const interim: PluginStatusMutationResult[] = []
	const touched = new Set<string>()

	for (const { name, action } of actions) {
		const res = await runStatusAction(ctx, name, action)
		interim.push(res)
		if (res.ok) touched.add(name)
	}

	const commitResult = await ctx.registry.commit()
	if ((commitResult as any)?.err) {
		const commitError = String((commitResult as any).err)
		return {
			ok: false,
			commitError,
			results: interim.map((r) =>
				r.ok ? { ...r, ok: false, code: 'commit_failed', error: commitError } : r,
			),
		}
	}

	const snapshots = Array.from(touched).map((name) => {
		const ctor = resolvePlugin(ctx, name)
		return { name, ...readStatusSnapshot(ctx, name, ctor as any) }
	})
	const snapMap = new Map(snapshots.map((s) => [s.name, s]))

	return {
		ok: interim.every((r) => r.ok),
		results: interim.map((r) => (r.ok ? { ...r, ...snapMap.get(r.name) } : r)),
	}
}
