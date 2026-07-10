import { getRouteApi } from '@tanstack/react-router'
import type { PluginDetailSearch } from '../../router/pluginDetailSearch'

const pluginDetailRouteApi = getRouteApi('/_workbench/plugins/$name')
const EMPTY_PLUGIN_DETAIL_SEARCH: PluginDetailSearch = {}

export function usePluginDetailSearch() {
	try {
		return pluginDetailRouteApi.useSearch({ structuralSharing: true })
	} catch {
		return EMPTY_PLUGIN_DETAIL_SEARCH
	}
}

export function getPluginScopedSearchCandidates(value: string | undefined, pluginName?: string) {
	if (!value) return []
	if (!pluginName) return [value]
	const prefix = `${pluginName}:`
	return value.startsWith(prefix) && value.length > prefix.length
		? [value, value.slice(prefix.length)]
		: [value]
}

export function replacePluginDetailSearchParams(patch: Partial<PluginDetailSearch>) {
	if (typeof window === 'undefined') return
	const url = new URL(window.location.href)
	for (const [key, value] of Object.entries(patch) as Array<
		[keyof PluginDetailSearch, string | undefined]
	>) {
		if (value) url.searchParams.set(key, value)
		else url.searchParams.delete(key)
	}
	window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}
