import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { ReportStudioWorkbench } from '../ReportStudio.workbench'

export const studioScope = createWorkbenchRenderer(ReportStudioWorkbench.studio)

export const reportStudioSnapshot = studioScope.query({
	queryFn: ({ api }) => api.snapshot(),
	watch: ({ api }, invalidate) => api.watch(invalidate),
})

export const generateReport = studioScope.mutation({
	mutationFn: ({ api }, title: string) => api.generate(title),
})

export const probeOutbound = studioScope.mutation({
	mutationFn: ({ api }) => api.probeOutbound(),
})

export const clearPreviewCache = studioScope.mutation({
	mutationFn: ({ api }) => api.clearCache(),
})
