import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const dashboardScope = createWorkbenchRenderer(PluginWithUIWorkbench.dashboard)

export const dashboardSnapshot = dashboardScope.query(({ api }) => ({
	queryKey: ['plugin-with-ui', 'dashboard', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))
