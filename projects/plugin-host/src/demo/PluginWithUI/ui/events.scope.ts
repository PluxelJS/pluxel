import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const eventsScope = createWorkbenchRenderer(PluginWithUIWorkbench.events)

export const eventsSnapshot = eventsScope.query(({ api }) => ({
	queryKey: ['plugin-with-ui', 'events', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const addNote = eventsScope.mutation(({ api }) => ({
	mutationFn: (message: string) => api.addNote(message),
}))

export const clearEvents = eventsScope.mutation(({ api }) => ({
	mutationFn: () => api.clearEvents(),
}))
