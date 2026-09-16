export {
	type PluginReconciliationIssue,
	type CorePluginOperation,
	type PluginSessionIntent,
	type PluginActivationReason,
	type HostPluginSessionEntry as RuntimePluginSessionEntry,
	type HostPluginDesiredControl as RuntimePluginDesiredControl,
	type AppliedPluginGraphSnapshot,
	type ReconciliationPlan,
	emptyAppliedPluginGraphSnapshot,
	reconcilePluginGraph,
	catalogTransitionRejections,
	pluginReconciliationIssueKey,
} from '@pluxel/host/internal'
