export function formatLogName(ctxName: string, pluginId?: string): string {
	if (!pluginId) return ctxName
	if (pluginId === ctxName) return pluginId
	return `${pluginId}(${ctxName})`
}
