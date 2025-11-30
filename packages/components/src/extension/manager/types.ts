import type { ExtensionManifest } from "../types"

export interface PluginInfo {
	name: string
	isRunning: boolean
}

export interface ExtensionManagerOptions {
	fetchManifest: () => Promise<ExtensionManifest>
	pollInterval?: number
}

export interface ExtensionManagerState {
	isLoading: boolean
	error: Error | null
	manifestVersion: number
	loadedCount: number
}
