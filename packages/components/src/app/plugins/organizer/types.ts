export type PluginStatuses = { [name: string]: PluginStatus }

export interface PluginStatus {
	id: string
	name?: string
	isRunning: boolean
	isEnabled?: boolean
}

export interface GroupConfig {
	groupId: string
	name: string
	pluginIds: string[]
}

