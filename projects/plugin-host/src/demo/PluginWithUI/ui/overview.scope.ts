import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const overviewScope = createWorkbenchRenderer(PluginWithUIWorkbench.overview)

export const overviewSnapshot = overviewScope.query({
	queryFn: ({ api }) => api.snapshot(),
	watch: ({ api }, invalidate) => api.watch(invalidate),
})

export const incrementCounter = overviewScope.mutation({
	mutationFn: ({ api }, delta: number) => api.increment(delta),
})

export const resetCounter = overviewScope.mutation({
	mutationFn: ({ api }) => api.resetCounter(),
})
