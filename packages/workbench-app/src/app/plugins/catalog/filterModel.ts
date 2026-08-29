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
	tag?: string
	version?: string
	availability?: 'available' | 'unavailable'
	lifecycleState?: 'running' | 'stopped'
}

export function hasActiveSearchTokens(tokens: SearchTokens): boolean {
	return (
		tokens.plain.length > 0 ||
		tokens.pkg.length > 0 ||
		tokens.tag.length > 0 ||
		tokens.version.length > 0 ||
		tokens.id.length > 0
	)
}

export function hasActiveStatusFilter(filter: StatusFilterState): boolean {
	return !filter.running || !filter.stopped || !filter.unavailable
}

export function matchesGroupSearch(name: string, tokens: SearchTokens): boolean {
	return tokens.plain.length > 0 && tokens.plain.every((term) => name.toLowerCase().includes(term))
}

export function matchesPluginSearch(
	pluginId: string,
	status: SearchablePluginStatus | undefined,
	tokens: SearchTokens,
	filter: StatusFilterState,
): boolean {
	const name = (status?.name || '').toLowerCase()
	const pkg = (status?.packageName || '').toLowerCase()
	const tag = (status?.tag || '').toLowerCase()
	const version = (status?.version || '').toLowerCase()
	const idValue = pluginId.toLowerCase()

	const available = status?.availability !== 'unavailable'
	const running = available && status?.lifecycleState === 'running'
	const stopped = available && status?.lifecycleState !== 'running'
	const unavailable = !available
	const statusOk =
		(filter.running && running) ||
		(filter.stopped && stopped) ||
		(filter.unavailable && unavailable)
	if (!statusOk) return false

	const plainOk = tokens.plain.every((term) =>
		[name, pkg, tag, version, idValue].some((field) => field.includes(term)),
	)
	const pkgOk = tokens.pkg.every((term) => pkg.includes(term))
	const tagOk = tokens.tag.every((term) => tag.includes(term))
	const versionOk = tokens.version.every((term) => version.includes(term))
	const idOk = tokens.id.every((term) => idValue.includes(term))

	return plainOk && pkgOk && tagOk && versionOk && idOk
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return Boolean(
		target.closest(
			'input, textarea, select, button, a[href], [role="button"], [role="textbox"], [contenteditable="true"]',
		),
	)
}
