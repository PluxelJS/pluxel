import { formatPluginNodeReference, parsePluginNodeReference } from '@pluxel/core'

/** Applied log filters are document state, so reload and duplication preserve them. */
export type LogsSearch = {
	plugin?: string
	stream?: string
	displayName?: string
	context?: string
	category?: string
}
export function validateLogsSearch(search: Record<string, unknown>): LogsSearch {
	const result: LogsSearch = {}
	if (search.plugin !== undefined) {
		if (typeof search.plugin !== 'string') throw new TypeError('日志插件筛选必须是插件引用')
		const reference = formatPluginNodeReference(parsePluginNodeReference(search.plugin))
		if (reference !== search.plugin) throw new TypeError('日志插件筛选必须是规范的插件引用')
		result.plugin = reference
	}
	for (const key of ['stream', 'displayName', 'context', 'category'] as const) {
		const value = search[key]
		if (value === undefined) continue
		if (typeof value !== 'string') throw new TypeError(`日志筛选 ${key} 必须是字符串`)
		if (value.trim() && !(key === 'stream' && value.trim() === 'default'))
			result[key] = value.trim()
	}
	return result
}
export function buildLogsHref(search: LogsSearch): string {
	const params = new URLSearchParams(validateLogsSearch(search))
	return `/logs${params.size > 0 ? `?${params}` : ''}`
}
