import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const dashboardScope = createWorkbenchRenderer(PluginWithUIWorkbench.dashboard)

export const dashboardSnapshot = dashboardScope.query({
	queryFn: ({ api }) => api.snapshot(),
	watch: ({ api }, invalidate) => api.watch(invalidate),
})
