import {
	pluginNodeIndexKey,
	formatPluginNodeReference,
	type Context,
	type PluginLifecycleIssue,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
export type HostPluginLifecycleDiagnostic = Readonly<{
	plugin: PluginNodeAddress
	kind: PluginLifecycleIssue['kind']
	message: string
}>

const lifecycleIssues = new WeakMap<
	Context['root'],
	Map<string, readonly HostPluginLifecycleDiagnostic[]>
>()

export function readHostPluginLifecycleIssues(
	ctx: Context,
): readonly HostPluginLifecycleDiagnostic[] {
	return [...(lifecycleIssues.get(ctx.root)?.values() ?? [])].flat()
}

export function installHostPluginDiagnostics(ctx: Context): void {
	const root = ctx.root
	const registry = requirePluginService(root)
	const retained = new Map<string, readonly HostPluginLifecycleDiagnostic[]>()
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
		const failed = new Map<string, HostPluginLifecycleDiagnostic[]>()
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
}
