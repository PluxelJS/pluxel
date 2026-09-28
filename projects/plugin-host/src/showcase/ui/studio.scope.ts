import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { ReportStudioWorkbench } from '../ReportStudio.workbench'

export const studioScope = createWorkbenchRenderer(ReportStudioWorkbench.studio)

export const reportStudioSnapshot = studioScope.query(({ api }) => ({
	queryKey: ['report-studio', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const generateReport = studioScope.mutation(({ api }) => ({
	mutationFn: (title: string) => api.generateDto(title),
}))

export const probeOutbound = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.probeOutboundDto(),
}))

export const clearPreviewCache = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.clearCacheDto(),
}))
