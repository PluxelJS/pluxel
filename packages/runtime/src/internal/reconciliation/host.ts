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
import {
	RuntimePluginGraphCoordinator,
	type CorePluginGraphDriver,
	type CorePluginUpdateDraft,
} from './coordinator'

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

const coordinators = new WeakMap<Context['root'], RuntimePluginGraphCoordinator<CommitSummary>>()

export function installRuntimePluginGraphCoordinator(
	ctx: Context,
): RuntimePluginGraphCoordinator<CommitSummary> {
	const root = ctx.root
	const current = coordinators.get(root)
	if (current) return current
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
	const coordinator = new RuntimePluginGraphCoordinator(
		requireRuntimeStateStore(root),
		corePluginGraphDriver(root),
	)
	coordinators.set(root, coordinator)
	root.effects.defer(
		async () => {
			await coordinator.dispose()
			if (coordinators.get(root) === coordinator) coordinators.delete(root)
		},
		{
			tag: 'RuntimePluginGraphCoordinator',
			phase: 'shutdown',
		},
	)
	return coordinator
}

export function requireRuntimePluginGraphCoordinator(
	ctx: Context,
): RuntimePluginGraphCoordinator<CommitSummary> {
	const coordinator = coordinators.get(ctx.root)
	if (!coordinator) {
		throw new Error('[runtime:reconciliation] host did not install the Plugin graph coordinator')
	}
	return coordinator
}

function corePluginGraphDriver(ctx: Context): CorePluginGraphDriver<CommitSummary> {
	const registry = requirePluginService(ctx)
	return {
		readCommittedDependencyAdjacency: () => registry.readCommittedDependencyAdjacency(),
		isRunning: (address) => registry.isRunning(address),
		beginUpdate(options) {
			const update = registry.beginUpdate(options)
			return {
				materializeNode: (address, candidate) => update.materializeNode(address, candidate),
				dematerializeNode: (address, operationOptions) =>
					update.dematerializeNode(address, operationOptions),
				restartNode: (address, operationOptions) => update.restartNode(address, operationOptions),
				replaceDefinition: (address, candidate, operationOptions) =>
					update.replaceDefinition(address, candidate, operationOptions),
				setProviderDefault: (token, provider) => update.setProviderDefault(token, provider),
				setDependencyOverride: (consumer, requirement, provider) =>
					update.setDependencyOverride(consumer, requirement, provider),
				prepare: () => {
					const prepared = update.prepare()
					return {
						async commit(commitOptions): Promise<CommitSummary> {
							const result = await prepared.commit(commitOptions)
							if (result.ok === false) {
								throw result.err instanceof Error ? result.err : new Error(String(result.err))
							}
							const summary = registry.lastCommit
							if (!summary) {
								throw new Error('[runtime:reconciliation] Core commit omitted CommitSummary')
							}
							return summary
						},
						rollback: () => prepared.rollback(),
					}
				},
				rollback: () => update.rollback(),
			} satisfies CorePluginUpdateDraft<CommitSummary>
		},
	}
}
