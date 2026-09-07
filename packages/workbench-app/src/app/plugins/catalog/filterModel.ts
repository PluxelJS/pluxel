import type { SearchTokens } from './searchTokens'

export type StatusFilterState = {
	running: boolean
	stopped: boolean
	unavailable: boolean
}

export const DEFAULT_STATUS_FILTER: StatusFilterState = {
	running: true,
	stopped: true,
	unavailable: true,
}

type SearchablePluginStatus = {
	name?: string
	packageName?: string
	sourceSpace?: string
	sourcePath?: string
	exportName?: string
	reference?: string
	executionSearchTerms?: readonly string[]
	recentUpdateSearchTerms?: readonly string[]
	availability?: 'available' | 'unavailable'
	lifecycleState?: 'running' | 'stopped'
}

export function hasActiveSearchTokens(tokens: SearchTokens): boolean {
	return (
		tokens.plain.length > 0 ||
		tokens.pkg.length > 0 ||
		tokens.reference.length > 0 ||
		tokens.execution.length > 0
	)
}

export function hasActiveStatusFilter(filter: StatusFilterState): boolean {
	return !filter.running || !filter.stopped || !filter.unavailable
}

export function matchesGroupSearch(name: string, tokens: SearchTokens): boolean {
	return tokens.plain.length > 0 && tokens.plain.every((term) => name.toLowerCase().includes(term))
}

export function matchesPluginSearch(
	_pluginId: string,
	status: SearchablePluginStatus | undefined,
	tokens: SearchTokens,
	filter: StatusFilterState,
): boolean {
	const name = (status?.name || '').toLowerCase()
	const pkg = (status?.packageName || '').toLowerCase()
	const sourceSpace = (status?.sourceSpace || '').toLowerCase()
	const sourcePath = (status?.sourcePath || '').toLowerCase()
	const exportName = (status?.exportName || '').toLowerCase()
	const reference = (status?.reference || '').toLowerCase()
	const runtimeFields = [
		...(status?.executionSearchTerms ?? []),
		...(status?.recentUpdateSearchTerms ?? []),
	].map((field) => field.toLowerCase())

	const available = status?.availability !== 'unavailable'
	const running = available && status?.lifecycleState === 'running'
	const stopped = available && status?.lifecycleState !== 'running'
	const unavailable = !available
	const statusOk =
		(filter.running && running) ||
		(filter.stopped && stopped) ||
		(filter.unavailable && unavailable)
	if (!statusOk) return false

	const plainFields = [name, pkg, sourceSpace, sourcePath, exportName, reference, ...runtimeFields]
	const plainOk = tokens.plain.every((term) => plainFields.some((field) => field.includes(term)))
	const pkgOk = tokens.pkg.every((term) => pkg.includes(term))
	const referenceOk = tokens.reference.every((term) => reference.includes(term))
	const executionOk = tokens.execution.every((term) =>
		runtimeFields.some((field) => field.includes(term)),
	)

	return plainOk && pkgOk && referenceOk && executionOk
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return Boolean(
		target.closest(
			'input, textarea, select, button, a[href], [role="button"], [role="textbox"], [contenteditable="true"]',
		),
	)
}
