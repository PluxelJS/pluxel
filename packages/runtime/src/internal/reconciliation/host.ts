import {
	pluginNodeIndexKey,
	formatPluginNodeReference,
	type CommitSummary,
	type Context,
	type PluginLifecycleIssue,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { requireRuntimeStateStore } from '../runtime-state'
import { installPluginHostCoordinator, requirePluginHostCoordinator } from '@pluxel/host/internal'
import { RuntimePluginGraphCoordinator } from './coordinator'

export type RuntimePluginLifecycleDiagnostic = Readonly<{
	plugin: PluginNodeAddress
	kind: PluginLifecycleIssue['kind']
	message: string
}>

const lifecycleIssues = new WeakMap<
	Context['root'],
	Map<string, readonly RuntimePluginLifecycleDiagnostic[]>
>()

export function readRuntimePluginLifecycleIssues(
	ctx: Context,
): readonly RuntimePluginLifecycleDiagnostic[] {
	return [...(lifecycleIssues.get(ctx.root)?.values() ?? [])].flat()
}

const installed = new WeakSet<Context['root']>()

export function installRuntimePluginGraphCoordinator(
	ctx: Context,
): RuntimePluginGraphCoordinator<CommitSummary> {
	const root = ctx.root
	if (installed.has(root)) return requirePluginHostCoordinator(root)
	const registry = requirePluginService(root)
	const retained = new Map<string, readonly RuntimePluginLifecycleDiagnostic[]>()
	lifecycleIssues.set(root, retained)
	const unsubscribe = registry.subscribeCommitted((summary) => {
		const nodes = new Map(
			registry
				.readCommittedDependencyAdjacency()
				.nodes.map((node) => [pluginNodeIndexKey(node), node]),
		)
		for (const [key] of retained) {
			const node = nodes.get(key)
			if (!node || registry.isRunning(node)) retained.delete(key)
		}
		const failed = new Map<string, RuntimePluginLifecycleDiagnostic[]>()
		for (const issue of summary.lifecycleReport.issues) {
			const address = registry.nodeAddressOf(issue.plugin)
			const key = pluginNodeIndexKey(address)
			const issues = failed.get(key) ?? []
			issues.push(Object.freeze({ plugin: address, kind: issue.kind, message: issue.message }))
			failed.set(key, issues)
			root.logger.error('Plugin lifecycle operation failed', {
				pluginReference: formatPluginNodeReference(address),
				phase: issue.phase,
				kind: issue.kind,
				message: issue.message,
				error: issue.error,
			})
		}
		for (const [key, issues] of failed) if (nodes.has(key)) retained.set(key, Object.freeze(issues))
	})
	root.effects.defer(
		() => {
			unsubscribe()
			lifecycleIssues.delete(root)
		},
		{ tag: 'PluginLifecycleDiagnostics', phase: 'shutdown' },
	)
	const coordinator = installPluginHostCoordinator(root, { state: requireRuntimeStateStore(root) })
	installed.add(root)
	root.effects.defer(
		() => {
			installed.delete(root)
		},
		{ phase: 'shutdown' },
	)
	return coordinator
}

export function requireRuntimePluginGraphCoordinator(
	ctx: Context,
): RuntimePluginGraphCoordinator<CommitSummary> {
	return requirePluginHostCoordinator(ctx)
}
