import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { BotWorkspaceWorkbench } from '../BotWorkspace.workbench'

export const botScope = createWorkbenchRenderer(BotWorkspaceWorkbench.bot)
export const botSnapshot = botScope.query(({ api }) => ({
	queryKey: ['bot-workspace', 'bot'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: { subscribe: ({ invalidate }) => api.watch(invalidate) },
}))
export const saveBot = botScope.mutation(({ api }) => ({
	mutationFn: (input: { instructions: string; expectedRevision: number }) => api.saveDto(input),
}))
export const setBotRunning = botScope.mutation(({ api }) => ({
	mutationFn: (input: { running: boolean; expectedRevision: number }) => api.setRunningDto(input),
}))
