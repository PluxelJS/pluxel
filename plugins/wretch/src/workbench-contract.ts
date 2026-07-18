import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export type WretchManagedSettings = Readonly<{
	headers: Readonly<Record<string, string>>
	proxyUrl?: string
	/** Optional per-consumer cap. It can only lower the host timeout. */
	timeoutMs?: number
}>

export type WretchManagedSettingsSnapshot = Readonly<{
	settings: WretchManagedSettings
	hostTimeoutMs: number
	effectiveTimeoutMs: number
}>

export interface WretchWorkbenchCommands {
	get(): WretchManagedSettingsSnapshot
	update(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot>
	reset(): Promise<WretchManagedSettingsSnapshot>
}

export const WretchWorkbenchPort = workbenchContract.port({
	id: '@pluxel/wretch.settings',
	version: 1,
	resources: {
		settings: workbenchContract.rpc<WretchWorkbenchCommands>(),
	},
})
