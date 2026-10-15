import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { ReportStudioWorkbench } from '../ReportStudio.workbench'
import type { ShowcaseRenderRequest } from '../ReportStudio.contracts'

export const studioScope = createWorkbenchRenderer(ReportStudioWorkbench.studio)

export const reportStudioSnapshot = studioScope.query(({ api }) => ({
	queryKey: ['report-studio', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const generateReport = studioScope.mutation(({ api }) => ({
	mutationFn: (request: ShowcaseRenderRequest) => api.generateDto(request),
}))

export const probeOutbound = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.probeOutboundDto(),
}))

export const clearPreviewCache = studioScope.mutation(({ api }) => ({
	mutationFn: () => api.clearCacheDto(),
}))
