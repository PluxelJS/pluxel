export type PluginDetailSearch = {
	tab?: string
	schema?: string
}

export function validatePluginDetailSearch(search: Record<string, unknown>): PluginDetailSearch {
	return {
		tab: typeof search.tab === 'string' && search.tab.trim().length > 0 ? search.tab : undefined,
		schema:
			typeof search.schema === 'string' && search.schema.trim().length > 0
				? search.schema
				: undefined,
	}
}
