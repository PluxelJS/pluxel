import type { Context, PluginNodeAddressSnapshot } from '@pluxel/core'
import { readStatusSnapshot } from '../features/pluginStatus/service'
import { maybeAddForkToCatalog } from './forksCatalog'
import { requireRouteCapability } from '../../runtime/capabilities'
import { pluginNodeAddressKey } from '../../runtime/plugin-address'
import type {
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
} from '../../web/protocol'

function resolvePlugin(ctx: Context, address: PluginNodeAddressSnapshot) {
	const ctor = requireRouteCapability(ctx, 'catalog').resolve(address)
	if (!ctor) throw new Error('Plugin node is not present in the route catalog')
	return ctor
}

async function runStatusAction(
	ctx: Context,
	address: PluginNodeAddressSnapshot,
	action: PluginStatusAction,
): Promise<PluginStatusMutationResult> {
	try {
		const lifecycle = requireRouteCapability(ctx, 'lifecycle')
		if (action === 'start' || action === 'restart' || action === 'enable') {
			maybeAddForkToCatalog(ctx, address)
		}
		const ctor = resolvePlugin(ctx, address)
		switch (action) {
			case 'start':
			case 'enable':
				await lifecycle.enable(address, ctor)
				break
			case 'stop':
				lifecycle.deactivate(address, ctor, { runtimeOnly: true })
				break
			case 'restart':
				ctx.registry.restart(ctor)
				break
			case 'disable':
				lifecycle.deactivate(address, ctor, { runtimeOnly: false })
				break
			case 'enable-persisted':
				await lifecycle.enablePersisted(address)
				break
			default:
				return { address, ok: false, code: 'invalid_status', error: `Unsupported: ${action}` }
		}
		return { address, ok: true }
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error)
		return {
			address,
			ok: false,
			code: text.includes('not present') ? 'plugin_not_found' : 'plugin_operation_failed',
			error: text,
		}
	}
}

export async function applyStatusActions(
	ctx: Context,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	if (actions.length === 0) return { ok: true, results: [] }
	const interim: PluginStatusMutationResult[] = []
	const touched = new Map<string, PluginNodeAddressSnapshot>()
	for (const { address, action } of actions) {
		const result = await runStatusAction(ctx, address, action)
		interim.push(result)
		if (result.ok) touched.set(pluginNodeAddressKey(address), address)
	}
	const commit = await ctx.registry.commit()
	if (commit.err) {
		const commitError = String(commit.err)
		return {
			ok: false,
			commitError,
			results: interim.map((result) =>
				result.ok
					? Object.assign({}, result, {
							ok: false as const,
							code: 'commit_failed',
							error: commitError,
						})
					: result,
			),
		}
	}
	const snapshots = new Map(
		[...touched].map(([key, address]) => [key, readStatusSnapshot(ctx, address)]),
	)
	return {
		ok: interim.every((result) => result.ok),
		results: interim.map((result) =>
			result.ok
				? Object.assign({}, result, snapshots.get(pluginNodeAddressKey(result.address)))
				: result,
		),
	}
}
