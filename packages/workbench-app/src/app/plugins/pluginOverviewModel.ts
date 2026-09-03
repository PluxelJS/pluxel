import type {
	PluginCatalogSection,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
} from '@pluxel/runtime/web'

export type PluginStatusEntry = Readonly<
	Omit<PluginStatusSnapshot, 'label'> & {
		/** Canonical catalog identity used by routes and local view state. */
		id: string
		label: string
	}
>

export type PluginOverview = Readonly<{
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
		status: Object.freeze({
			statuses: Object.freeze(catalog.plugins.map(projectStatus)),
			summary: catalog.summary,
		}),
		sections: Object.freeze([...catalog.sections]),
	})
}
