import { installHostPluginDiagnostics } from './diagnostics'
import type { Context, CommitSummary } from '@pluxel/core'
import { PluginHostCoordinator, type HostStateCoordinatorStore } from './coordinator'
import { corePluginGraphDriver } from './driver'
import { HostStateStore } from './state-store'

const coordinators = new WeakMap<Context['root'], PluginHostCoordinator<CommitSummary>>()

/** Install one graph authority per root. The root owns its queue's teardown. */
export function installPluginHostCoordinator(
	ctx: Context,
	options: { state?: HostStateCoordinatorStore } = {},
): PluginHostCoordinator<CommitSummary> {
	const root = ctx.root
	if (coordinators.has(root)) throw new Error('[host] a coordinator is already installed')
	const coordinator = new PluginHostCoordinator(
		options.state ?? new HostStateStore(root),
		corePluginGraphDriver(root),
	)
	installHostPluginDiagnostics(root)
	coordinators.set(root, coordinator)
	root.effects.defer(
		async () => {
			await coordinator.dispose()
			coordinators.delete(root)
		},
		{ tag: 'PluginHostCoordinator', phase: 'shutdown' },
	)
	return coordinator
}

export function requirePluginHostCoordinator(ctx: Context): PluginHostCoordinator<CommitSummary> {
	const coordinator = coordinators.get(ctx.root)
	if (!coordinator) throw new Error('[host] root has no Plugin host coordinator')
	return coordinator
}
