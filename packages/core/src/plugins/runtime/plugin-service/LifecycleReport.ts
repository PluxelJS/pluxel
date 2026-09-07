import type { PluginNodeSlot } from '../identity'
import { findErrorPartPath } from '../../../internal/effects-part-path'

export type PluginLifecycleIssuePhase = 'resolve' | 'config' | 'start' | 'dependency' | 'drain'

export const PLUGIN_LIFECYCLE_ISSUE_KIND = {
	ResolveFailed: 'resolve-failed',
	ConfigFailed: 'config-failed',
	StartFailed: 'start-failed',
	DependencyBlocked: 'dependency-blocked',
	DrainFailed: 'drain-failed',
} as const

export type PluginLifecycleIssueKind =
	(typeof PLUGIN_LIFECYCLE_ISSUE_KIND)[keyof typeof PLUGIN_LIFECYCLE_ISSUE_KIND]

export type PluginLifecycleErrorInfo = Readonly<{
	name: string
	message: string
	stack?: string
	cause?: string
	/** Present when construction, startup, or cleanup failed inside a PluginPart occurrence. */
	partPath?: readonly string[]
}>

export type PluginLifecycleIssue = Readonly<{
	plugin: PluginNodeSlot
	phase: PluginLifecycleIssuePhase
	kind: PluginLifecycleIssueKind
	message: string
	error?: PluginLifecycleErrorInfo
	blockedBy?: PluginNodeSlot
}>

export type PluginLifecycleReport = Readonly<{
	readonly ok: boolean
	readonly issues: readonly PluginLifecycleIssue[]
}>

export type PluginLifecycleIssuePredicate = (issue: PluginLifecycleIssue) => boolean

export type MutableLifecycleReport = {
	issues: PluginLifecycleIssue[]
	issueKeys: WeakMap<PluginNodeSlot, Set<string>>
	onIssue?: () => void
}

export const EMPTY_LIFECYCLE_REPORT: PluginLifecycleReport = Object.freeze({
	ok: true,
	issues: Object.freeze([]) as readonly PluginLifecycleIssue[],
})

export const createLifecycleReport = (): MutableLifecycleReport => ({
	issues: [],
	issueKeys: new WeakMap(),
})

export function serializeLifecycleError(error: unknown): PluginLifecycleErrorInfo {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause
		const partPath = findErrorPartPath(error)
		return {
			name: error.name || 'Error',
			message: error.message,
			...(error.stack ? { stack: error.stack } : {}),
			...(cause !== null && cause !== undefined ? { cause: errorMessage(cause) } : {}),
			...(partPath ? { partPath: Object.freeze([...partPath]) as readonly string[] } : {}),
		}
	}
	return {
		name: typeof error,
		message: errorMessage(error),
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof AggregateError) {
		const nested = [...error.errors].map(errorMessage).filter(Boolean)
		return nested.length > 0 ? `${error.message}: ${nested.join('; ')}` : error.message
	}
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
	const blockedBy = issue.blockedBy
		? JSON.stringify({
				entry: issue.blockedBy.definition.entry.address,
				exportName: issue.blockedBy.definition.exportName,
				variant: issue.blockedBy.variant,
				...(issue.blockedBy.variant === 'fork' ? { forkId: issue.blockedBy.forkId } : {}),
			})
		: ''
	const key = `${issue.kind}\0${blockedBy}\0${issue.message}`
	let keys = report.issueKeys.get(issue.plugin)
	if (!keys) {
		keys = new Set()
		report.issueKeys.set(issue.plugin, keys)
	}
	if (keys.has(key)) return
	keys.add(key)
	report.issues.push(issue)
	report.onIssue?.()
}

/** Install the publication hook only after the initial immutable report has been published. */
export function observeLifecycleReport(report: MutableLifecycleReport, onIssue: () => void): void {
	report.onIssue = onIssue
}

export function finalizeLifecycleReport(report: MutableLifecycleReport): PluginLifecycleReport {
	if (report.issues.length === 0) return EMPTY_LIFECYCLE_REPORT
	const issues = report.issues.map((issue): PluginLifecycleIssue => {
		const error = issue.error
			? Object.freeze({
					name: issue.error.name,
					message: issue.error.message,
					...(issue.error.stack === undefined ? {} : { stack: issue.error.stack }),
					...(issue.error.cause === undefined ? {} : { cause: issue.error.cause }),
					...(issue.error.partPath === undefined
						? {}
						: { partPath: Object.freeze([...issue.error.partPath]) }),
				})
			: undefined
		return Object.freeze({
			plugin: issue.plugin,
			phase: issue.phase,
			kind: issue.kind,
			message: issue.message,
			...(error === undefined ? {} : { error }),
			...(issue.blockedBy === undefined ? {} : { blockedBy: issue.blockedBy }),
		})
	})
	return Object.freeze({ ok: false, issues: Object.freeze(issues) })
}

export function isPluginLifecycleNotStartedIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind !== PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed
}

export function isPluginLifecycleBlockedIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind === PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked
}

export function isPluginLifecycleDrainErrorIssue(issue: PluginLifecycleIssue): boolean {
	return issue.kind === PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed
}

export function collectPluginLifecycleIssuePlugins(
	report: PluginLifecycleReport | undefined,
	predicate: PluginLifecycleIssuePredicate = () => true,
): PluginNodeSlot[] {
	if (!report) return []
	const plugins = new Set<PluginNodeSlot>()
	for (const issue of report.issues) {
		if (predicate(issue)) plugins.add(issue.plugin)
	}
	return [...plugins]
}

export function collectPluginLifecycleNotStarted(
	report: PluginLifecycleReport | undefined,
): PluginNodeSlot[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleNotStartedIssue)
}

export function collectPluginLifecycleBlocked(
	report: PluginLifecycleReport | undefined,
): PluginNodeSlot[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleBlockedIssue)
}

export function collectPluginLifecycleDrainErrors(
	report: PluginLifecycleReport | undefined,
): PluginNodeSlot[] {
	return collectPluginLifecycleIssuePlugins(report, isPluginLifecycleDrainErrorIssue)
}
