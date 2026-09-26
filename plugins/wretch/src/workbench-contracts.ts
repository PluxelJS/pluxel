import type { RpcTarget } from 'capnweb'

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

export interface WretchSettingsApi extends RpcTarget {
	snapshotDto(): WretchManagedSettingsSnapshot
	updateDto(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot>
	resetDto(): Promise<WretchManagedSettingsSnapshot>
}
