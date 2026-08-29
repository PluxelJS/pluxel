import type { PluginNodeAddress } from '@pluxel/core'

export type PluginStatuses = { [name: string]: PluginStatus }

export interface PluginStatus {
	id: string
	address: PluginNodeAddress
	name?: string
	packageName?: string
	version?: string
	tag?: string
	sourceKind?: 'hmr' | 'package' | 'unknown'
	moduleId?: string | null
	availability: 'available' | 'unavailable'
	autoStart: boolean
	desiredState: 'running' | 'stopped'
	lifecycleState: 'running' | 'stopped'
}

export interface GroupConfig {
	groupId: string
	name: string
	pluginIds: string[]
}
