export type PluginDetailSearch = {
	entry?: string
}

export function validatePluginDetailSearch(search: Record<string, unknown>): PluginDetailSearch {
	return {
		entry: typeof search.entry === 'string' && search.entry.trim() ? search.entry : undefined,
	}
}
