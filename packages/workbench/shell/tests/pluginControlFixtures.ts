import type { PluginNodeAddress } from '@pluxel/core'
import type {
	PluginCatalogSnapshot,
	PluginControlBatchResult,
	PluginControlMutationFailure,
	PluginControlMutationSuccess,
	PluginStatusSnapshot,
} from '@pluxel/services/management/client'

export function controlNode(exportName = 'FixturePlugin'): PluginNodeAddress {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/plugin-control' },
			exportName,
		},
		variant: 'default',
	}
}

export function appliedControl(address = controlNode()): PluginControlMutationSuccess {
	return {
		address,
		ok: true,
		status: 'applied',
		report: {
			persistence: { status: 'unchanged' },
			writtenFields: [],
			catalogRevision: 1,
			runtimeStateRevision: 1,
			reconciliation: [],
			core: {
				status: 'committed',
				summary: {
					pluginChanges: {
						added: [],
						replaced: [],
						removed: [],
						restarted: [],
						availabilityChanged: [],
					},
					runtimeUpdate: {},
					lifecycleReport: { ok: true, issues: [] },
				},
			},
		},
		control: {
			autoStart: true,
			sessionIntent: 'run',
			desiredState: 'running',
			activationReason: 'session',
			lifecycleState: 'running',
		},
	}
}

export function lifecycleFailedControl(
	address = controlNode(),
): Extract<PluginControlMutationFailure, { code: 'lifecycle_failed' }> {
	const applied = appliedControl(address)
	return {
		address,
		ok: false,
		code: 'lifecycle_failed',
		status: 'applied-with-issues',
		error: 'Plugin lifecycle application completed with issues',
		report: {
			...applied.report,
			core: {
				status: 'committed',
				summary: {
					pluginChanges: {
						added: [],
						replaced: [],
						removed: [],
						restarted: [],
						availabilityChanged: [],
					},
					runtimeUpdate: {},
					lifecycleReport: {
						ok: false,
						issues: [
							{
								plugin: address,
								phase: 'start',
								kind: 'start-failed',
								message: 'database unavailable',
								error: { name: 'Error', message: 'database unavailable' },
							},
						],
					},
				},
			},
		},
		control: { ...applied.control, lifecycleState: 'stopped' },
	}
}

export function rejectedControl(
	code: 'graph_rejected' | 'revision_conflict' = 'graph_rejected',
	address = controlNode(),
): PluginControlMutationFailure {
	return { address, ok: false, code, state: 'unchanged', error: `${code}: policy changed` }
}

export function unknownControl(address = controlNode()): PluginControlMutationFailure {
	return {
		address,
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		error: 'Policy write outcome is unknown',
	}
}

export function invalidControlBatch(
	error = 'Plugin auto-start items must contain at most 1000 items',
): PluginControlBatchResult {
	return {
		ok: false,
		status: 'rejected',
		code: 'invalid_input',
		state: 'unchanged',
		error,
		results: [],
	}
}

export function controlStatus(address = controlNode()): PluginStatusSnapshot {
	const name = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/plugin-control::${name}`,
		route: `v1/package/${name}/@fixture/plugin-control`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		availability: 'available',
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}

export function controlCatalog(
	plugins = [controlStatus()],
	managedRevision = 'policy:test:0',
): PluginCatalogSnapshot {
	return {
		plugins,
		sections: [],
		statePolicy: { readonly: false, managedRevision, overriddenFields: [] },
		summary: {
			total: plugins.length,
			running: plugins.filter((plugin) => plugin.lifecycleState === 'running').length,
			stopped: plugins.filter((plugin) => plugin.lifecycleState === 'stopped').length,
			autoStart: plugins.filter((plugin) => plugin.autoStart).length,
		},
	}
}
