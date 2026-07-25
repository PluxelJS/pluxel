export const PLUGIN_SCHEMA_GROUP = '__plugin__'

export function splitSchemaKey(key: string): { group: string; sub: string; isConfig: boolean } {
	const dot = key.indexOf('.')
	if (dot === -1) return { group: PLUGIN_SCHEMA_GROUP, sub: key, isConfig: false }
	const group = key.slice(0, dot)
	const sub = key.slice(dot + 1)
	return { group, sub, isConfig: sub === 'config' }
}

export function compareSchemaKeys(a: string, b: string): number {
	const aa = splitSchemaKey(a)
	const bb = splitSchemaKey(b)
	const g = aa.group.localeCompare(bb.group)
	if (g !== 0) return g
	// Put `${feature}.config` first within a namespace.
	if (aa.isConfig !== bb.isConfig) return aa.isConfig ? -1 : 1
	return aa.sub.localeCompare(bb.sub)
}

export function formatSchemaGroupLabel(group: string): string {
	if (group === PLUGIN_SCHEMA_GROUP) return '插件'
	return group
}
