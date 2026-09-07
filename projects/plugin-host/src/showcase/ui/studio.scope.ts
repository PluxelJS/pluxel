import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { ReportStudioWorkbench } from '../ReportStudio.workbench'

export const studioScope = createWorkbenchRenderer(ReportStudioWorkbench.studio)

export const reportStudioSnapshot = studioScope.query(({ api }) => ({
	queryKey: ['report-studio', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const generateReport = studioScope.mutation(({ api }) => ({
	mutationFn: (title: string) => api.generate(title),
}))

export const probeOutbound = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.probeOutbound(),
}))

export const clearPreviewCache = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.clearCache(),
}))
