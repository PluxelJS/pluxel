import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import type { WretchManagedSettings } from '../workbench-contracts.ts'
import { WretchWorkbench } from '../workbench.ts'

export const settingsScope = createWorkbenchRenderer(WretchWorkbench.settings)

export const wretchSettingsQuery = settingsScope.query(({ provider }) => ({
	queryKey: ['wretch', 'settings'] as const,
	queryFn: () => provider.snapshot(),
}))

export const updateWretchSettingsMutation = settingsScope.mutation(({ provider }) => ({
	mutationFn: (settings: WretchManagedSettings) => provider.update(settings),
	workbench: {
		invalidates: [wretchSettingsQuery],
	},
}))

export const resetWretchSettingsMutation = settingsScope.mutation(({ provider }) => ({
	mutationFn: () => provider.reset(),
	workbench: {
		invalidates: [wretchSettingsQuery],
	},
}))
