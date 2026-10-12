export type PluginDetailSearch = {
	entry?: string
	tab?: string
}

export function validatePluginDetailSearch(search: Record<string, unknown>): PluginDetailSearch {
	return {
		entry: typeof search.entry === 'string' && search.entry.trim() ? search.entry : undefined,
		tab: typeof search.tab === 'string' && search.tab.trim().length > 0 ? search.tab : undefined,
	}
}
