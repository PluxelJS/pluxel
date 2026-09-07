import type { PluginToken } from '../../types'

export interface PluginOptions {
	readonly displayName?: string
	readonly startTimeoutMs?: number
	readonly forkable?: true
}

export interface PluginMarker {
	readonly options: PluginOptions
	readonly providerClass?: PluginToken
}
