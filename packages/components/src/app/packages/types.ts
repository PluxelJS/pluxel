import type {
	InstallPackageSpecInput,
	PackageLoadIssue,
	PackageInventoryEntry,
	PluginStatusEntry,
} from '../gqty'

export type Maybe<T> = T | null | undefined

export type PackageRow = {
	name: string
	version: string | null
	tag: string | null
	raw: string | null
	installedVersion: string | null
	requestedVersion: string | null
	loaded: boolean
	pluginCount: number
	runningCount: number
	pluginNames: string[]
	issues: PackageLoadIssue[]
}

export type InstallTask = {
	label: string
	spec: InstallPackageSpecInput
	kind: 'primary' | 'dependency'
	from?: string
	force?: boolean
}

export type InstallLogEntry = {
	label: string
	kind: 'primary' | 'dependency'
	status: 'pending' | 'running' | 'success' | 'error'
	message?: string
}

export const ISSUE_SOURCE_LABEL: Record<string, string> = {
	load: '加载',
	restore: '恢复',
}

export { type InstallPackageSpecInput, type PackageLoadIssue, type PackageInventoryEntry, type PluginStatusEntry }
