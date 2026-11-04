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
