import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { BotWorkspaceWorkbench } from '../BotWorkspace.workbench'

export const homeScope = createWorkbenchRenderer(BotWorkspaceWorkbench.home)
export const homeSnapshot = homeScope.query(({ api }) => ({
	queryKey: ['bot-workspace', 'home'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: { subscribe: ({ invalidate }) => api.watch(invalidate) },
}))
