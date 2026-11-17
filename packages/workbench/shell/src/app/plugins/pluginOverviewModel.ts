import type {
	PluginCatalogSection,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
	PluginStatePolicy,
} from '@pluxel/services/management/client'

export type PluginStatusEntry = Readonly<
	Omit<PluginStatusSnapshot, 'label'> & {
		/** Canonical catalog identity used by routes and local view state. */
		id: string
		label: string
	}
>

export type PluginOverview = Readonly<{
	statePolicy: PluginStatePolicy
	status: Readonly<{
		statuses: readonly PluginStatusEntry[]
		summary: PluginCatalogSnapshot['summary']
	}>
	sections: readonly PluginCatalogSection[]
}>

function projectStatus(entry: PluginStatusSnapshot): PluginStatusEntry {
	return Object.freeze({ ...entry, id: entry.route, label: entry.label.text })
}

export function buildPluginOverview(catalog: PluginCatalogSnapshot): PluginOverview {
	return Object.freeze({
		statePolicy: catalog.statePolicy,
		status: Object.freeze({
			statuses: Object.freeze(catalog.plugins.map(projectStatus)),
			summary: catalog.summary,
		}),
		sections: Object.freeze([...catalog.sections]),
	})
}

/** Every field touched by the requested management patch must be writable. */
export function canWritePluginState(
	policy: PluginStatePolicy | undefined,
	...fields: readonly PluginStatePolicy['overriddenFields'][number][]
): boolean {
	return (
		!!policy &&
		!policy.readonly &&
		fields.every((field) => !policy.overriddenFields.includes(field))
	)
}

const LIFECYCLE_FAILURES = new Set<string>([
	'resolve-failed',
	'config-failed',
	'start-failed',
	'dependency-blocked',
	'drain-failed',
])

export type PluginAttention = Readonly<{
	tone: 'error' | 'pending'
	label: '运行异常' | '依赖阻塞' | '装配问题' | '不可用' | '等待启动'
	message: string | null
}>

/** Why a Plugin needs an operator's attention, or `null` when its runtime facts agree. */
export function pluginAttention(
	plugin: Pick<PluginStatusEntry, 'issues' | 'availability' | 'desiredState' | 'lifecycleState'>,
): PluginAttention | null {
	const failure = plugin.issues.find((issue) => LIFECYCLE_FAILURES.has(issue.code))
	if (failure)
		return {
			tone: 'error',
			label: failure.code === 'dependency-blocked' ? '依赖阻塞' : '运行异常',
			message: failure.message,
		}
	if (plugin.availability === 'unavailable')
		return { tone: 'error', label: '不可用', message: plugin.issues[0]?.message ?? null }
	if (plugin.issues[0])
		return { tone: 'error', label: '装配问题', message: plugin.issues[0].message }
	if (plugin.desiredState === 'running' && plugin.lifecycleState !== 'running')
		return { tone: 'pending', label: '等待启动', message: null }
	return null
}
