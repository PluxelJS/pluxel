import { getRouteApi } from '@tanstack/react-router'
import type { PluginDetailSearch } from '../../router/pluginDetailSearch'

const pluginDetailRouteApi = getRouteApi('/_workbench/plugins/$')
const EMPTY_PLUGIN_DETAIL_SEARCH: PluginDetailSearch = {}

export function usePluginDetailSearch() {
	try {
		return pluginDetailRouteApi.useSearch({ structuralSharing: true })
	} catch {
		return EMPTY_PLUGIN_DETAIL_SEARCH
	}
}
