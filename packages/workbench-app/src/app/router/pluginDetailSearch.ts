export type PluginDetailSearch = {
	dock?: string
	side?: string
	tab?: string
	schema?: string
}

export function validatePluginDetailSearch(search: Record<string, unknown>): PluginDetailSearch {
	return {
		dock:
			typeof search.dock === 'string' && search.dock.trim().length > 0 ? search.dock : undefined,
		side:
			typeof search.side === 'string' && search.side.trim().length > 0 ? search.side : undefined,
		tab: typeof search.tab === 'string' && search.tab.trim().length > 0 ? search.tab : undefined,
		schema:
			typeof search.schema === 'string' && search.schema.trim().length > 0
				? search.schema
				: undefined,
	}
}
