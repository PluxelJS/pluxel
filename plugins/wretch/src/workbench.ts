import { workbench } from '@pluxel/runtime/workbench'
import type { WretchSettingsApi } from './workbench-contracts.ts'

export type {
	WretchManagedSettings,
	WretchManagedSettingsSnapshot,
	WretchSettingsApi,
} from './workbench-contracts.ts'

/** Provider-owned renderer and capability; consumers only choose its placement. */
export const WretchWorkbench = workbench.define({
	settings: workbench.attachment<WretchSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})
