export type PluginStatuses = { [name: string]: PluginStatus }

export interface PluginStatus {
	id: string
	name?: string
	packageName?: string
	version?: string
	tag?: string
	sourceKind?: 'hmr' | 'package' | 'unknown'
	moduleId?: string | null
	isRunning: boolean
	isEnabled?: boolean
}

export interface GroupConfig {
	groupId: string
	name: string
	pluginIds: string[]
}
