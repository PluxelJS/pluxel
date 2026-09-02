import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import type { WretchManagedSettings } from '../workbench-contracts.ts'
import { WretchWorkbench } from '../workbench.ts'

export const settingsScope = createWorkbenchRenderer(WretchWorkbench.settings)

export const wretchSettingsQuery = settingsScope.query({
	queryFn: ({ provider }) => provider.snapshot(),
})

export const updateWretchSettingsMutation = settingsScope.mutation({
	mutationFn: ({ provider }, settings: WretchManagedSettings) => provider.update(settings),
	invalidates: [wretchSettingsQuery],
})

export const resetWretchSettingsMutation = settingsScope.mutation({
	mutationFn: ({ provider }) => provider.reset(),
	invalidates: [wretchSettingsQuery],
})
