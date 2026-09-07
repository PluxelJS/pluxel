import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const overviewScope = createWorkbenchRenderer(PluginWithUIWorkbench.overview)

export const overviewSnapshot = overviewScope.query(({ api }) => ({
	queryKey: ['plugin-with-ui', 'overview', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const incrementCounter = overviewScope.mutation(({ api }) => ({
	mutationFn: (delta: number) => api.increment(delta),
}))

export const resetCounter = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.resetCounter(),
}))
