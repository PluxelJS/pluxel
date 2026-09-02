import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const eventsScope = createWorkbenchRenderer(PluginWithUIWorkbench.events)

export const eventsSnapshot = eventsScope.query({
	queryFn: ({ api }) => api.snapshot(),
	watch: ({ api }, invalidate) => api.watch(invalidate),
})

export const addNote = eventsScope.mutation({
	mutationFn: ({ api }, message: string) => api.addNote(message),
})

export const clearEvents = eventsScope.mutation({
	mutationFn: ({ api }) => api.clearEvents(),
})
