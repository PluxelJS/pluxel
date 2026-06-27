import type { RuntimePluginKey } from '../identity'

export type PluginLifecycleIssuePhase = 'resolve' | 'config' | 'start' | 'dependency' | 'stop'

export const PLUGIN_LIFECYCLE_ISSUE_KIND = {
	ResolveFailed: 'resolve-failed',
	ConfigFailed: 'config-failed',
	StartFailed: 'start-failed',
	DependencyBlocked: 'dependency-blocked',
	StopFailed: 'stop-failed',
} as const

export type PluginLifecycleIssueKind =
	(typeof PLUGIN_LIFECYCLE_ISSUE_KIND)[keyof typeof PLUGIN_LIFECYCLE_ISSUE_KIND]

export type PluginLifecycleErrorInfo = {
	name: string
	message: string
	stack?: string
	cause?: string
}

export type PluginLifecycleIssue = {
	plugin: RuntimePluginKey
	phase: PluginLifecycleIssuePhase
	kind: PluginLifecycleIssueKind
	message: string
	error?: PluginLifecycleErrorInfo
	blockedBy?: RuntimePluginKey
}

export type PluginLifecycleReport = {
	readonly ok: boolean
	readonly issues: readonly PluginLifecycleIssue[]
}

export type PluginLifecycleIssuePredicate = (issue: PluginLifecycleIssue) => boolean

export type MutableLifecycleReport = {
	issues: PluginLifecycleIssue[]
	issueKeys: Set<string>
}

export const EMPTY_LIFECYCLE_REPORT: PluginLifecycleReport = Object.freeze({
	ok: true,
	issues: Object.freeze([]) as readonly PluginLifecycleIssue[],
})

export const createLifecycleReport = (): MutableLifecycleReport => ({
	issues: [],
	issueKeys: new Set(),
})

export function serializeLifecycleError(error: unknown): PluginLifecycleErrorInfo {
	if (error instanceof Error) {
		const info: PluginLifecycleErrorInfo = {
			name: error.name || 'Error',
			message: error.message,
		}
		if (error.stack) info.stack = error.stack
		const cause = (error as Error & { cause?: unknown }).cause
		if (cause !== null && cause !== undefined) info.cause = errorMessage(cause)
		return info
	}
	return {
		name: typeof error,
		message: errorMessage(error),
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	try {
		const json = JSON.stringify(error)
		return json ?? String(error)
	} catch {
		return String(error)
	}
}

export function recordLifecycleIssue(
	report: MutableLifecycleReport,
	issue: PluginLifecycleIssue,
): void {
	const key = `${issue.plugin}\0${issue.kind}\0${issue.blockedBy ?? ''}\0${issue.message}`
	if (report.issueKeys.has(key)) return
	report.issueKeys.add(key)
	report.issues.push(issue)
}

export function finalizeLifecycleReport(report: MutableLifecycleReport): PluginLifecycleReport {
	if (report.issues.length === 0) return EMPTY_LIFECYCLE_REPORT
	return { ok: false, issues: report.issues }
}

export function isPluginLifecycleNotStartedIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind !== PLUGIN_LIFECYCLE_ISSUE_KIND.StopFailed
}

export function isPluginLifecycleBlockedIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind === PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked
}

export function isPluginLifecycleStoppedWithErrorIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind === PLUGIN_LIFECYCLE_ISSUE_KIND.StopFailed
}

export function collectPluginLifecycleIssuePlugins(
	report: PluginLifecycleReport | undefined,
	predicate: PluginLifecycleIssuePredicate = () => true,
): RuntimePluginKey[] {
	if (!report) return []
	const plugins = new Set<RuntimePluginKey>()
	for (const issue of report.issues) {
		if (predicate(issue)) plugins.add(issue.plugin)
	}
	return [...plugins]
}

export function collectPluginLifecycleNotStarted(
	report: PluginLifecycleReport | undefined,
): RuntimePluginKey[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleNotStartedIssue)
}

export function collectPluginLifecycleBlocked(
	report: PluginLifecycleReport | undefined,
): RuntimePluginKey[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleBlockedIssue)
}

export function collectPluginLifecycleStoppedWithErrors(
	report: PluginLifecycleReport | undefined,
): RuntimePluginKey[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleStoppedWithErrorIssue)
}
