import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import type { WretchManagedSettings } from '../workbench-contracts.ts'
import { WretchWorkbench } from '../workbench.ts'

export const settingsScope = createWorkbenchRenderer(WretchWorkbench.settings)

export const wretchSettingsQuery = settingsScope.query(({ provider }) => ({
	queryKey: ['wretch', 'settings'] as const,
	queryFn: () => provider.snapshotDto(),
}))

export const updateWretchSettingsMutation = settingsScope.mutation(({ provider }) => ({
	mutationFn: (settings: WretchManagedSettings) => provider.updateDto(settings),
	workbench: {
		invalidates: [wretchSettingsQuery],
	},
}))

export const resetWretchSettingsMutation = settingsScope.mutation(({ provider }) => ({
	mutationFn: () => provider.resetDto(),
	workbench: {
		invalidates: [wretchSettingsQuery],
	},
}))
