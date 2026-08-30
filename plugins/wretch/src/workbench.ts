import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

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
	snapshot(): WretchManagedSettingsSnapshot
	update(settings: WretchManagedSettings): Promise<WretchManagedSettingsSnapshot>
	reset(): Promise<WretchManagedSettingsSnapshot>
}

/** Provider-owned renderer and capability; consumers only choose its placement. */
export const WretchWorkbench = workbench.define({
	settings: workbench.attachment<WretchSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/index.tsx'),
	}),
})
