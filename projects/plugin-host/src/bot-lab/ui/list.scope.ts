import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { BotWorkspaceWorkbench } from '../BotWorkspace.workbench'

export const listScope = createWorkbenchRenderer(BotWorkspaceWorkbench.list)
export const listSnapshot = listScope.query(({ api }) => ({
	queryKey: ['bot-workspace', 'list'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: { subscribe: ({ invalidate }) => api.watch(invalidate) },
}))
